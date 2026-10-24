// Runs in the page's own JS world at document_start on YouTube and Instagram. It reads copies of the
// feed data the site downloads (and the data embedded in the first page) and posts the items to Picky's
// content script, so Jev can judge them before the site draws them. It never changes what the page
// receives: responses are cloned, original functions always run, and every failure is swallowed.
(() => {
  const site = /(^|\.)youtube\.com$/.test(location.hostname) ? 'yt'
    : /(^|\.)instagram\.com$/.test(location.hostname) ? 'ig' : null;
  if (!site) return;
  const FEED_URL = site === 'yt' ? /\/youtubei\/v1\/(browse|search|next|get_watch|reel)\b/ : /\/(graphql|api\/v1)\//;
  const posted = new Set();

  function post(items) {
    const fresh = items.filter((it) => it && !posted.has(it.key));
    if (!fresh.length) return;
    fresh.forEach((it) => posted.add(it.key));
    try {
      window.postMessage({ __picky: 'feed', items: fresh.slice(0, 200) }, location.origin);
    } catch {}
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

  function extract(root) {
    const items = [];
    const stack = [[root, '']];
    let budget = 400000; // objects visited; feed payloads are far smaller
    while (stack.length && budget-- > 0) {
      const [node, parentKey] = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node)) {
        for (let i = node.length - 1; i >= 0; i--) stack.push([node[i], parentKey]);
        continue;
      }
      const item = site === 'yt' ? ytItem(node, parentKey) : igItem(node);
      if (item) items.push(item);
      for (const k in node) {
        const v = node[k];
        if (v && typeof v === 'object') stack.push([v, k]);
      }
    }
    return items.map(toMessage).filter(Boolean);
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

  function onText(body) {
    try {
      const json = JSON.parse(String(body).replace(/^\s*(for\s*\(;;\);|\)\]\}')/, ''));
      post(extract(json));
    } catch {}
  }

  // ---- network: read copies of feed responses ----
  try {
    const nativeFetch = window.fetch;
    if (typeof nativeFetch === 'function') {
      window.fetch = function fetch(input) {
        const response = nativeFetch.apply(this, arguments);
        try {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url || '';
          if (FEED_URL.test(url)) {
            response.then((res) => {
              try {
                if (res.ok) res.clone().text().then(onText, () => {});
              } catch {}
            }, () => {});
          }
        } catch {}
        return response;
      };
    }
  } catch {}

  try {
    const urls = new WeakMap();
    const proto = window.XMLHttpRequest.prototype;
    const open = proto.open;
    const send = proto.send;
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
              else if (this.responseType === 'json' && this.response) post(extract(this.response));
            } catch {}
          });
        }
      } catch {}
      return send.apply(this, arguments);
    };
  } catch {}

  // ---- data embedded in the first page ----
  try {
    if (site === 'yt') {
      // ytInitialData is a global set by an inline script; catch it as soon as that script has run.
      let done = false;
      const grab = () => {
        try {
          const data = window.ytInitialData;
          if (done || !data || typeof data !== 'object') return;
          done = true;
          watcher.disconnect();
          post(extract(data));
        } catch {}
      };
      const watcher = new MutationObserver(grab);
      watcher.observe(document, { childList: true, subtree: true });
      document.addEventListener('DOMContentLoaded', () => {
        grab();
        watcher.disconnect();
      }, { once: true });
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
