// Runs in the page's own JS world at document_start on YouTube and Instagram. It reads copies of the
// feed data the site downloads (and the data embedded in the first page) and posts the items to Picky's
// content script, so Jev can judge them before the site draws them.
// With Clean feed on (YouTube only), it also waits up to 700 ms for those decisions and hands YouTube a
// copy of the response without the items Picky would certainly hide, so they are never drawn. Anything
// slow or failing falls back to the original response; original functions always run.
(() => {
  const site = /(^|\.)youtube\.com$/.test(location.hostname) ? 'yt'
    : /(^|\.)instagram\.com$/.test(location.hostname) ? 'ig' : null;
  if (!site) return;
  const FEED_URL = site === 'yt' ? /\/youtubei\/v1\/(browse|search|next|get_watch|reel)\b/ : /\/(graphql|api\/v1)\//;
  const CLEAN_BUDGET_MS = 700;
  const EMPTY_LIMIT = 3; // continuations in a row with nothing left before Picky stops loading more
  const posted = new Set();

  const send = (msg) => {
    try {
      window.postMessage({ ...msg }, location.origin);
    } catch {}
  };
  function post(items) {
    const fresh = items.filter((it) => it && !posted.has(it.key));
    if (!fresh.length) return;
    fresh.forEach((it) => posted.add(it.key));
    send({ __picky: 'feed', items: fresh.slice(0, 200) });
  }

  // ---- schema-agnostic extraction: walk every object, keep the ones that look like feed items ----
  const text = (t) => !t ? '' : typeof t === 'string' ? t
    : t.simpleText || t.content || (Array.isArray(t.runs) ? t.runs.map((r) => r?.text || '').join('') : '');
  const ID = /^[\w-]{11}$/;

  function ytItem(o, parentKey) {
    // Classic renderers (search results, grids): videoId + title runs.
    if (typeof o.videoId === 'string' && ID.test(o.videoId) && (o.title || o.headline) && !/endScreen/.test(parentKey)) {
      const title = text(o.title) || text(o.headline);
      if (!title) return null;
      const short = Boolean(o.navigationEndpoint?.reelWatchEndpoint);
      const channel = text(o.ownerText) || text(o.shortBylineText) || text(o.longBylineText);
      return { key: `yt:${short ? 's' : 'v'}:${o.videoId}`, kind: short ? 'short' : 'video', title, channel };
    }
    // Lockups (home, channel grids, watch sidebar): contentId + metadata title.
    if (typeof o.contentId === 'string' && ID.test(o.contentId) && o.metadata?.lockupMetadataViewModel) {
      if (o.contentType && !/VIDEO/.test(o.contentType)) return null;
      const m = o.metadata.lockupMetadataViewModel;
      const channel = text(m.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text);
      return { key: `yt:v:${o.contentId}`, kind: 'video', title: text(m.title), channel };
    }
    // Shorts lockups: overlay title + reel endpoint.
    if (o.overlayMetadata?.primaryText && o.onTap) {
      const id = o.onTap.innertubeCommand?.reelWatchEndpoint?.videoId || String(o.entityId || '').replace(/^shorts-shelf-item-/, '');
      if (ID.test(id)) return { key: `yt:s:${id}`, kind: 'short', title: text(o.overlayMetadata.primaryText) };
    }
    return null;
  }

  function igItem(o) {
    const code = typeof o.code === 'string' ? o.code : typeof o.shortcode === 'string' ? o.shortcode : null;
    if (!code || !/^[\w-]{5,40}$/.test(code)) return null;
    if (!(o.image_versions2 || o.display_uri || o.display_url || o.thumbnail_src || o.accessibility_caption)) return null;
    const caption = typeof o.caption === 'string' ? o.caption
      : o.caption?.text || o.edge_media_to_caption?.edges?.[0]?.node?.text || '';
    const candidates = (o.image_versions2?.candidates || []).filter((c) => c?.url && c.width >= 320);
    candidates.sort((a, b) => Math.abs(a.width - 640) - Math.abs(b.width - 640));
    return {
      key: `ig:${code}`,
      kind: o.product_type === 'clips' || o.media_type === 2 || o.is_video ? 'reel' : 'post',
      username: o.user?.username || o.owner?.username || '',
      caption,
      alt: o.accessibility_caption || '',
      image: candidates[0]?.url || o.display_uri || o.display_url || o.thumbnail_src || '',
    };
  }

  // Items with the array element that holds each one (`holder`, chained to the holders above it),
  // so Clean feed can take the whole element out of its array.
  function find(root) {
    const found = [];
    const stack = [[root, '', null]];
    let budget = 400000; // objects visited; feed payloads are far smaller
    while (stack.length && budget-- > 0) {
      const [node, parentKey, holder] = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node)) {
        for (let i = node.length - 1; i >= 0; i--) stack.push([node[i], parentKey, { arr: node, el: node[i], parent: holder }]);
        continue;
      }
      const item = site === 'yt' ? ytItem(node, parentKey) : igItem(node);
      if (item) {
        const msg = toMessage(item);
        if (msg) found.push({ ...msg, holder });
        continue; // nothing to find inside an item
      }
      for (const k in node) {
        const v = node[k];
        if (v && typeof v === 'object') stack.push([v, k, holder]);
      }
    }
    return found;
  }

  function toMessage(it) {
    if (site === 'yt') {
      if (!it.title) return null;
      const feed = { platform: 'YouTube', kind: it.kind, title: it.title };
      if (it.channel) feed.channel = it.channel;
      return { key: it.key, state: { feed_item: feed } };
    }
    const feed = { platform: 'Instagram', kind: it.kind };
    if (it.username) feed.username = it.username;
    if (it.caption) feed.caption = it.caption;
    const tags = it.caption.match(/#[\p{L}\p{N}_]+/gu);
    if (tags) feed.hashtags = [...new Set(tags)].slice(0, 10);
    if (it.alt) feed.image_descriptions = [it.alt];
    if (!it.caption && !it.alt) return null;
    return { key: it.key, state: { feed_item: feed }, image: it.image };
  }
  const messages = (found) => found.map(({ holder, ...msg }) => msg);

  const parse = (body) => JSON.parse(String(body).replace(/^\s*(for\s*\(;;\);|\)\]\}')/, ''));
  function onText(body) {
    try {
      post(messages(find(parse(body))));
    } catch {}
  }

  // ---- Clean feed (YouTube) ----
  const clean = { on: false, hide: new Set(), ads: false }; // set by the content script ('config')
  const waiting = new Map(); // request id -> resolve(decisions)
  let requestId = 0;
  let emptyStreak = 0;
  let paused = null; // { resume, holds: Set } while further continuations wait for "Keep looking"

  window.addEventListener('message', (e) => {
    const m = e.source === window && e.data;
    if (!m || typeof m.__picky !== 'string') return;
    if (m.__picky === 'config') {
      clean.on = Boolean(m.clean);
      if (Array.isArray(m.hide)) clean.hide = new Set(m.hide.filter((k) => typeof k === 'string'));
      clean.ads = Boolean(m.ads);
      if (!clean.on) resume();
    } else if (m.__picky === 'decisions') {
      waiting.get(m.id)?.(m);
    } else if (m.__picky === 'keep-looking') {
      resume();
    }
  });

  function askDecisions(items, budget) {
    const id = ++requestId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        resolve(null);
      }, budget);
      waiting.set(id, (m) => {
        clearTimeout(timer);
        waiting.delete(id);
        resolve(m);
      });
      send({ __picky: 'judge-request', id, items: items.slice(0, 200), budget });
    });
  }

  const isContinuation = (json) => Boolean(json && typeof json === 'object' && !Array.isArray(json)
    && (json.onResponseReceivedActions || json.onResponseReceivedCommands || json.onResponseReceivedEndpoints)
    && !json.contents);

  const CONTAINER = /^(gridShelfViewModel|reelShelfRenderer|shelfRenderer|richShelfRenderer|richSectionRenderer|horizontalCardListRenderer|itemSectionRenderer)$/;
  function holds(node, test, budget = 20000) {
    const stack = [node];
    while (stack.length && budget-- > 0) {
      const n = stack.pop();
      if (!n || typeof n !== 'object') continue;
      if (test(n)) return true;
      for (const k in n) if (n[k] && typeof n[k] === 'object') stack.push(n[k]);
    }
    return false;
  }
  const keepsSomething = (el) => holds(el, (n) => !Array.isArray(n) && ('continuationItemRenderer' in n || ytItem(n, '')));

  // Take each item's element out of its array; then drop shelves (and search sections) left empty.
  function prune(found, removeSet) {
    const removed = [];
    for (const f of found) {
      if (!removeSet.has(f.key) || !f.holder) continue;
      const i = f.holder.arr.indexOf(f.holder.el);
      if (i < 0) continue;
      f.holder.arr.splice(i, 1);
      removed.push(f.key);
      for (let h = f.holder, depth = 0; h?.parent && depth < 3; h = h.parent, depth++) {
        const box = h.parent.el;
        const kind = box && typeof box === 'object' && !Array.isArray(box) ? Object.keys(box).find((k) => CONTAINER.test(k)) : null;
        if (!kind || keepsSomething(box)) break;
        const j = h.parent.arr.indexOf(box);
        if (j >= 0) h.parent.arr.splice(j, 1);
      }
    }
    return removed;
  }

  // Ads in the feed data (search, home, watch sidebar, masthead), when a rule is against every ad. The
  // player's ads (playerAds, adPlacements) live in other responses and are never touched.
  const AD = /^(adSlotRenderer|searchPyvRenderer|promotedSparklesWebRenderer|promotedVideoRenderer|compactPromotedVideoRenderer|displayAdRenderer|inFeedAdLayoutRenderer)$/;
  const isAdEntry = (el) => {
    if (!el || typeof el !== 'object' || Array.isArray(el)) return false;
    if (Object.keys(el).some((k) => AD.test(k))) return true;
    const content = el.richItemRenderer?.content || el.richSectionRenderer?.content;
    if (content && Object.keys(content).some((k) => AD.test(k))) return true;
    const box = Object.keys(el).find((k) => CONTAINER.test(k)); // a search section holding only ads
    const items = box && (el[box].contents || el[box].items);
    return Array.isArray(items) && items.length > 0 && items.every(isAdEntry);
  };
  function pruneAds(root) {
    let count = 0;
    const stack = [root];
    let budget = 400000;
    while (stack.length && budget-- > 0) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node)) {
        for (let i = node.length - 1; i >= 0; i--) {
          if (isAdEntry(node[i])) {
            node.splice(i, 1);
            count++;
          } else {
            stack.push(node[i]);
          }
        }
        continue;
      }
      if (isAdEntry(node.masthead)) {
        delete node.masthead;
        count++;
      }
      for (const k in node) if (node[k] && typeof node[k] === 'object' && !/^(playerAds|adPlacements|adSlots)$/.test(k)) stack.push(node[k]);
    }
    return count;
  }

  function cleanCopy(res, json) {
    const headers = new Headers(res.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    const out = new Response(JSON.stringify(json), { status: res.status, statusText: res.statusText, headers });
    for (const prop of ['url', 'redirected', 'type']) {
      try {
        Object.defineProperty(out, prop, { value: res[prop], configurable: true });
      } catch {}
    }
    return out;
  }

  async function cleanResponse(res) {
    const started = performance.now();
    let outcome = 'kept';
    let continuation = false;
    let counts = { found: 0, removed: 0 };
    try {
      if (!res.ok) return res;
      const json = parse(await res.clone().text());
      continuation = isContinuation(json);
      if (!continuation) emptyStreak = 0;
      const ads = clean.ads ? pruneAds(json) : 0; // no question needed: these go whatever they promote
      if (ads) send({ __picky: 'pruned-ads', count: ads });
      const found = find(json);
      if (!found.length) {
        if (ads) outcome = 'pruned';
        return ads ? cleanCopy(res, json) : res;
      }
      const answer = await askDecisions(messages(found), Math.max(0, CLEAN_BUDGET_MS - (performance.now() - started)));
      if (!answer) {
        outcome = 'timeout';
        return ads ? cleanCopy(res, json) : res;
      }
      const removed = prune(found, new Set(Array.isArray(answer.remove) ? answer.remove : []));
      counts = { found: found.length, removed: removed.length, ads };
      if (continuation) {
        emptyStreak = found.length - removed.length === 0 ? emptyStreak + 1 : 0;
        if (emptyStreak >= EMPTY_LIMIT && !paused) {
          paused = { holds: new Set(), resume: null };
          send({ __picky: 'paused' });
        } else if (emptyStreak) {
          send({ __picky: 'emptied', streak: emptyStreak }); // the content script may nudge YouTube to load on
        }
      }
      if (!removed.length && !ads) return res;
      outcome = 'pruned';
      if (removed.length) send({ __picky: 'pruned', keys: removed });
      return cleanCopy(res, json);
    } catch {
      outcome = 'error';
      return res;
    } finally {
      send({ __picky: 'clean-timing', outcome, continuation, ...counts, ms: Math.round(performance.now() - started) });
    }
  }

  // While paused, a continuation request waits here (not sent, so no Jev cost) until "Keep looking".
  function hold(signal) {
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      paused.holds.add(entry);
      signal?.addEventListener('abort', () => {
        paused?.holds.delete(entry);
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      }, { once: true });
    });
  }
  function resume() {
    if (!paused) return;
    const { holds: waitingHolds } = paused;
    paused = null;
    emptyStreak = 0;
    waitingHolds.forEach((h) => h.resolve());
    send({ __picky: 'resumed' });
  }
  // YouTube gzips its request bodies. If this fails, the request counts as a new page (never stuck).
  async function requestIsContinuation(input, init) {
    try {
      let body = typeof init?.body === 'string' ? init.body : '';
      if (!body && input instanceof Request) {
        const copy = input.clone();
        body = copy.headers.get('content-encoding') === 'gzip'
          ? await new Response(copy.body.pipeThrough(new DecompressionStream('gzip'))).text()
          : await copy.text();
      }
      return body.includes('"continuation"');
    } catch {
      return false;
    }
  }

  // ---- network: read copies of feed responses ----
  try {
    const nativeFetch = window.fetch;
    if (typeof nativeFetch === 'function') {
      window.fetch = function fetch(input, init) {
        let url = '';
        try {
          url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url || '';
        } catch {}
        if (!FEED_URL.test(url)) return nativeFetch.apply(this, arguments);
        const self = this;
        const args = arguments;

        if (site === 'yt' && clean.on) {
          const start = () => {
            send({ __picky: 'feed-start' });
            return nativeFetch.apply(self, args).then(cleanResponse);
          };
          if (!paused) return start();
          return requestIsContinuation(input, init).then((more) => {
            if (!paused) return start();
            if (!more) { // a new page: stop waiting for the old one's "Keep looking"
              paused.holds.forEach((h) => h.reject(new DOMException('The operation was aborted.', 'AbortError')));
              paused = null;
              emptyStreak = 0;
              send({ __picky: 'resumed' });
              return start();
            }
            return hold(init?.signal || input?.signal).then(start);
          });
        }

        const response = nativeFetch.apply(this, arguments);
        try {
          response.then((res) => {
            try {
              if (res.ok) res.clone().text().then(onText, () => {});
            } catch {}
          }, () => {});
        } catch {}
        return response;
      };
    }
  } catch {}

  try {
    const urls = new WeakMap();
    const proto = window.XMLHttpRequest.prototype;
    const open = proto.open;
    const sendXhr = proto.send;
    proto.open = function (method, url) {
      try {
        urls.set(this, String(url));
      } catch {}
      return open.apply(this, arguments);
    };
    proto.send = function () {
      try {
        if (FEED_URL.test(urls.get(this) || '')) {
          this.addEventListener('load', () => {
            try {
              if (this.status !== 200) return;
              if (this.responseType === '' || this.responseType === 'text') onText(this.responseText);
              else if (this.responseType === 'json' && this.response) post(messages(find(this.response)));
            } catch {}
          });
        }
      } catch {}
      return sendXhr.apply(this, arguments);
    };
  } catch {}

  // ---- data embedded in the first page ----
  try {
    if (site === 'yt') {
      // ytInitialData is a global set by an inline script. Catch the assignment: Clean feed can only use
      // answers already cached (no waiting is possible here); everything gets sent for judging.
      let value;
      let seen = false;
      const take = (data) => {
        try {
          if (seen || !data || typeof data !== 'object') return data;
          seen = true;
          const ads = clean.on && clean.ads ? pruneAds(data) : 0;
          if (ads) send({ __picky: 'pruned-ads', count: ads });
          const found = find(data);
          if (clean.on && clean.hide.size) {
            const removed = prune(found, clean.hide);
            if (removed.length) send({ __picky: 'pruned', keys: removed });
          }
          post(messages(found));
        } catch {}
        return data;
      };
      try {
        Object.defineProperty(window, 'ytInitialData', {
          configurable: true,
          enumerable: true,
          get: () => value,
          set: (v) => {
            value = take(v);
          },
        });
      } catch {
        document.addEventListener('DOMContentLoaded', () => take(window.ytInitialData), { once: true });
      }
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        try {
          for (const s of document.querySelectorAll('script[type="application/json"]')) {
            if (/"(code|shortcode)":"[\w-]{5,40}"/.test(s.textContent)) onText(s.textContent);
          }
        } catch {}
      }, { once: true });
    }
  } catch {}
})();
