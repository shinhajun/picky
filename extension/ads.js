// Ads as judgeable items. In the top page: find ad slots (GPT/AdSense, ad networks' iframes, Taboola and
// Outbrain widgets, anything labelled Advertisement/Sponsored) and the wrapper each one sits in. Inside a
// frame: tell ad frames from ordinary ones, and read the creative (text, alt text, where it links, picture).
// Loaded by both content scripts (content.js in the top page, frame.js in every frame), so it is cheap to run.
(() => {
  if (globalThis.PickyAds) return;

  const AD_HOST = /(^|\.)(doubleclick\.net|googlesyndication\.com|googleadservices\.com|amazon-adsystem\.com|adnxs\.com|taboola\.com|outbrain\.com|criteo\.(com|net)|rubiconproject\.com|pubmatic\.com|openx\.net|adsrvr\.org|casalemedia\.com|smartadserver\.com|teads\.tv|media\.net|3lift\.com|sharethrough\.com|adform\.net|2mdn\.net|serving-sys\.com|flashtalking\.com|gumgum\.com|kargo\.com|yieldmo\.com|revcontent\.com|mgid\.com|nativo\.com|zemanta\.com|adroll\.com|connatix\.com)$/i;
  const SLOT = [
    'ins.adsbygoogle', '[id^="div-gpt-ad"]', '[id^="google_ads_iframe"]', '[data-google-query-id]', 'amp-ad', 'amp-embed',
    '[id^="taboola-"]', '.trc_related_container', '.OUTBRAIN', '[data-widget-id^="AR_"]',
    '[aria-label="Advertisement" i]', '[aria-label="Sponsored" i]', '[aria-label="Ad" i]', '[aria-label="Ads" i]',
  ].join(',');
  const LABEL = /^(advertisements?|advertising|ads?|sponsored( content| links?| posts?)?|promoted|paid (content|post)|story continues below advertisement|continue reading below|광고|anzeige|werbung|publicité|publicidad|pubblicità|реклама|広告)$/i;
  // Ad-network boilerplate inside creatives, not what the ad is about.
  const BOILERPLATE = /\b(adchoices|ads by google|why this ad\??|report this ad|stop seeing this ad|my ad center|visit site|advertisement|sponsored)\b/gi;
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META']);

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  // Text that doesn't change when Picky hides the slot (innerText would). Skips scripts, our labels, and
  // the site's own "Advertisement" / "Story continues below advertisement" lines.
  function textOf(root) {
    let out = '';
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement?.closest('script, style, noscript, template, .picky-label') || (n.data.length <= 40 && LABEL.test(n.data.trim()))
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let n = walker.nextNode(); n && out.length < 2000; n = walker.nextNode()) out += ` ${n.data}`;
    return clean(out.replace(BOILERPLATE, ' '));
  }
  const hostOf = (url) => {
    try {
      return new URL(url, location.href).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  };
  const isAdHost = (host) => AD_HOST.test(host);

  // FNV-1a, 32-bit: content keys for ads.
  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  // Where an ad link really goes: click trackers carry the landing page in a parameter.
  function landingHost(href, depth = 0) {
    let u;
    try {
      u = new URL(href, location.href);
    } catch {
      return '';
    }
    if (!/^https?:$/.test(u.protocol)) return '';
    if (depth < 2) {
      for (const k of ['adurl', 'url', 'u', 'dest', 'dest_url', 'destination', 'redirect', 'redirect_url', 'rurl', 'landing', 'lp', 'clickurl']) {
        const v = u.searchParams.get(k);
        if (v && /^https?:\/\//i.test(v)) {
          const h = landingHost(v, depth + 1);
          if (h) return h;
        }
      }
    }
    const host = u.hostname.replace(/^www\./, '');
    return isAdHost(host) || /(^|\.)google\.[a-z.]+$/.test(host) ? '' : host;
  }
  function landingDomain(root) {
    const counts = new Map();
    for (const a of root.querySelectorAll('a[href]')) {
      if (/adchoices|privacy|opt.?out|why this ad/i.test(a.textContent + a.getAttribute('href'))) continue;
      const host = landingHost(a.getAttribute('href'));
      if (host && host !== location.hostname.replace(/^www\./, '') && !/(^|\.)(instagram|facebook|youtube)\.com$/.test(host)) counts.set(host, (counts.get(host) || 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || shownDomain(root);
  }
  // Ads whose links only go through the platform's click tracker still print where they lead.
  function shownDomain(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const m = n.data.trim().match(/^(?:https?:\/\/)?((?:[\w-]+\.)+[a-z]{2,})(?:\/\S*)?$/i);
      if (m && !/\.(jpg|png|gif|webp)$/i.test(m[1])) return m[1].toLowerCase().replace(/^www\./, '');
    }
    return '';
  }
  // Labelled as an ad by the site itself ("Sponsored", "광고"…), anywhere inside.
  function hasAdLabel(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.data.length <= 40 && LABEL.test(n.data.trim())) return true;
    return false;
  }

  function alts(root) {
    return [...root.querySelectorAll('img[alt]')].map((i) => clean(i.alt))
      .filter((a) => a.length > 3 && !/adchoices|^advertisement$/i.test(a)).slice(0, 3);
  }

  function biggestImage(root) {
    let best = null;
    let bestArea = 0;
    for (const img of root.querySelectorAll('img')) {
      const r = img.getBoundingClientRect();
      if (r.width < 100 || r.height < 50 || !/^https?:/.test(img.currentSrc || img.src)) continue;
      if (r.width * r.height > bestArea) [best, bestArea] = [img, r.width * r.height];
    }
    return best ? best.currentSrc || best.src : null;
  }

  // ---- in a frame ----

  // Ad frames: served by an ad network, nested inside one, or (same-origin "friendly" frames that ad
  // scripts write into) sitting in an ad slot of the parent page.
  function isAdFrame() {
    if (window === top) return false;
    if (isAdHost(location.hostname)) return true;
    const ancestors = location.ancestorOrigins || [];
    for (let i = 0; i < ancestors.length - 1; i++) if (isAdHost(hostOf(ancestors[i]))) return true;
    try {
      const f = window.frameElement;
      if (f && (f.matches(SLOT) || f.closest(SLOT) || isAdHost(hostOf(f.src)))) return true;
    } catch {}
    return false;
  }

  // The creative in this frame, or null when the frame is a sync pixel, still empty, or only a
  // container for a nested frame (which reports for itself).
  function creative() {
    const body = document.body;
    if (!body || innerWidth < 40 || innerHeight < 20) return null;
    const text = textOf(body).slice(0, 400);
    const pictures = alts(document);
    const domain = landingDomain(document);
    const image = biggestImage(document);
    const letters = (text.match(/[\p{L}\p{N}]/gu) || []).length;
    if (letters < 3 && !pictures.length && !image && !domain) return null;
    const f = { kind: 'advertisement' };
    if (letters >= 3) f.text = text;
    if (pictures.length) f.image_descriptions = pictures;
    if (domain) f.advertiser_domain = domain;
    return { key: `ad:${hash([f.text, pictures.join('|'), domain, image].join('\n'))}`, state: { feed_item: f }, image };
  }

  // ---- in the top page ----

  // Text outside `inside` (a descendant of `p`), skipping scripts and styles ad tags drop in wrappers.
  function textOutside(p, inside) {
    let out = '';
    for (const n of p.childNodes) {
      if (n.nodeType === 3) out += n.data;
      else if (n.nodeType === 1 && !SKIP_TAGS.has(n.tagName) && !n.contains(inside)) out += ` ${n.textContent}`;
    }
    return clean(out);
  }

  // Climb from an ad to the wrapper that holds only it and its "Advertisement" label, so the whole slot goes.
  function slotOf(core) {
    let slot = core;
    let height = core.getBoundingClientRect().height;
    for (let p = core.parentElement, i = 0; p && i < 8 && p !== document.body && p !== document.documentElement; p = p.parentElement, i++) {
      if (p.matches('main, article, [role="main"], [role="feed"]')) break;
      const extra = textOutside(p, slot);
      if (extra && !LABEL.test(extra)) break;
      if ([...p.querySelectorAll(`${SLOT}, iframe`)].some((x) => !slot.contains(x) && x !== slot && !x.contains(slot) && isAdCore(x))) break;
      const h = p.getBoundingClientRect().height;
      if (h > Math.max(height, 1) + 140) break; // a tall wrapper holds more than this ad
      slot = p;
      height = Math.max(height, h);
    }
    return slot;
  }

  const isAdCore = (el) => el.matches(SLOT) || (el.tagName === 'IFRAME' && isAdHost(hostOf(el.src)));

  // Elements labelled with just "Advertisement", "Sponsored", "광고"…: the smallest ancestor that also
  // holds a link, picture or frame is the ad. Checked at most every 2 s (it walks the page's text).
  let labelledAt = -Infinity;
  let labelledCache = [];
  function labelled() {
    if (performance.now() - labelledAt < 2000) return labelledCache.filter((el) => el.isConnected);
    labelledAt = performance.now();
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n && out.length < 50; n = walker.nextNode()) {
      if (n.data.length > 40 || !LABEL.test(n.data.trim())) continue;
      let el = n.parentElement;
      if (!el || SKIP_TAGS.has(el.tagName) || el.closest('a[href], button, nav, [role="navigation"], form')) continue;
      const label = n.data.trim();
      while (el.parentElement && clean(el.parentElement.textContent) === label) el = el.parentElement;
      for (let p = el.parentElement, i = 0; p && i < 4 && p !== document.body; p = p.parentElement, i++) {
        if (p.querySelector('a[href], img, iframe, video')) {
          const r = p.getBoundingClientRect();
          if (clean(p.textContent).length <= 600 && r.height <= innerHeight * 1.2 && !p.matches('main, article, [role="main"], [role="feed"]')) out.push(p);
          break;
        }
      }
    }
    labelledCache = out;
    return out;
  }

  const big = (el) => {
    const r = el.getBoundingClientRect();
    return r.width >= 50 && r.height >= 30;
  };

  // Ad slots on the page, outermost only.
  function findSlots() {
    if (!document.body) return [];
    const cores = new Set(document.querySelectorAll(SLOT));
    for (const f of document.querySelectorAll('iframe[src]')) if (isAdHost(hostOf(f.src))) cores.add(f);
    for (const el of labelled()) cores.add(el);
    const slots = new Set();
    for (const core of cores) {
      if (!core.closest('.picky-label') && big(core)) slots.add(slotOf(core));
    }
    return [...slots].filter((s) => ![...slots].some((o) => o !== s && o.contains(s)));
  }

  // What the top page can see of a slot by itself: an iframe ad is mostly opaque here; its frame reports
  // the creative separately (frame.js).
  function slotState(slot) {
    const f = { kind: 'advertisement' };
    const text = textOf(slot).slice(0, 500);
    if ((text.match(/[\p{L}\p{N}]/gu) || []).length >= 3) f.text = text;
    const pictures = alts(slot);
    if (pictures.length) f.image_descriptions = pictures;
    const domain = landingDomain(slot);
    if (domain) f.advertiser_domain = domain;
    const frame = slot.matches('iframe') ? slot : slot.querySelector('iframe');
    const network = frame && hostOf(frame.src);
    if (network && isAdHost(network)) f.ad_network = network;
    return { feed_item: f };
  }

  const slotKey = (slot) => `ad:s:${hash(JSON.stringify(slotState(slot).feed_item))}`;

  // An iframe ad of which the page sees nothing but the frame: its creative decides.
  function opaque(slot) {
    const f = slotState(slot).feed_item;
    return !f.text && !f.image_descriptions && !f.advertiser_domain && Boolean(slot.matches('iframe') || slot.querySelector('iframe'));
  }

  globalThis.PickyAds = {
    isAdFrame, creative, findSlots, slotOf, slotState, slotKey, opaque, image: biggestImage, KEY: /^ad:[\w:]{1,40}$/,
    // For the YouTube and Instagram adapters' own ad items.
    text: textOf, domain: landingDomain, hasAdLabel, hash,
  };
})();
