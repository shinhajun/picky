// Site adapters. Each one finds feed items, gives each a content key (not the node:
// sites recycle nodes), and extracts the text Jev judges.
//   findItems() -> Element[]      itemOf(node) -> Element | null (YouTube only)
//   key(el) -> string | null      extract(el) -> state object | null (null = not rendered yet)
//   image(el) -> picture URL | null (used only when text alone leaves Jev unsure)
//   shape(el) -> 'tile' | 'short' | 'row'      isDark() -> boolean
// Built-in adapters also have `site`, the key Picky uses for the per-site on/off switch.

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
const textOf = (el) => clean(el?.textContent);
const firstText = (root, selector) => {
  for (const el of root.querySelectorAll(selector)) {
    const t = textOf(el);
    if (t) return t;
  }
  return '';
};

const YT_ITEMS = [
  'ytd-rich-item-renderer',
  'ytd-video-renderer',
  'ytd-compact-video-renderer',
  'ytd-grid-video-renderer',
  'ytd-reel-item-renderer',
  'ytd-playlist-renderer',
  'ytd-radio-renderer',
  'yt-lockup-view-model',
  'ytm-shorts-lockup-view-model-v2',
  'ytm-shorts-lockup-view-model',
].join(',');

const youtube = {
  name: 'YouTube',
  site: 'youtube.com',
  itemSelector: YT_ITEMS,

  // Outermost matches only: home wraps yt-lockup-view-model inside ytd-rich-item-renderer.
  findItems() {
    return [...document.querySelectorAll(YT_ITEMS)].filter((el) => !el.parentElement?.closest(YT_ITEMS));
  },

  itemOf(node) {
    let el = (node.nodeType === 1 ? node : node.parentElement)?.closest(YT_ITEMS);
    let up;
    while (el && (up = el.parentElement?.closest(YT_ITEMS))) el = up;
    return el || null;
  },

  key(el) {
    for (const a of el.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href');
      let m = href.match(/[?&]v=([\w-]{6,})/);
      if (m) return `yt:v:${m[1]}`;
      m = href.match(/\/shorts\/([\w-]{6,})/);
      if (m) return `yt:s:${m[1]}`;
      m = href.match(/[?&]list=([\w-]+)/);
      if (m) return `yt:l:${m[1]}`;
    }
    return null;
  },

  extract(el) {
    const title =
      firstText(el, '#video-title, h3') ||
      clean(el.querySelector('a[title]')?.getAttribute('title')) ||
      clean(el.querySelector('h3[aria-label], a[aria-label]')?.getAttribute('aria-label'));
    if (!title) return null;
    const avatar = el.querySelector('[aria-label^="Go to channel "]')?.getAttribute('aria-label');
    const channel =
      firstText(el, 'ytd-channel-name a, ytd-channel-name #text, yt-content-metadata-view-model span') ||
      clean(avatar?.slice('Go to channel '.length));
    const key = this.key(el) || '';
    const kind = key.startsWith('yt:s:') ? 'short' : key.startsWith('yt:l:') ? 'playlist' : 'video';
    const state = { platform: 'YouTube', kind, title };
    if (channel) state.channel = channel;
    return { feed_item: state };
  },

  image(el) {
    const id = this.key(el)?.match(/^yt:[vs]:(.+)$/)?.[1];
    if (id) return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`; // 480x360, exists for every video
    return el.querySelector('img[src*="ytimg.com"]')?.src || null;
  },

  shape(el) {
    if (/^ytm-shorts|^ytd-reel/i.test(el.tagName) || el.querySelector('ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2')) return 'short';
    if (/^ytd-(rich-item|grid-video)-renderer$/i.test(el.tagName)) return 'tile';
    return 'row';
  },

  isDark() {
    return document.documentElement.hasAttribute('dark');
  },
};

// ---- generic: no class names, only semantics (article/role) and repeated sibling structure ----

const CHROME = 'nav, header, footer, aside, form, dialog, menu, [role="navigation"], [role="banner"], [role="contentinfo"], [role="menu"], [role="menubar"], [role="tablist"], [role="dialog"], [contenteditable=""], [contenteditable="true"]';
const CONTAINERS = 'ul, ol, div, section, main, [role="list"], [role="feed"], [role="grid"]';

function realLinks(el) {
  const links = [...el.querySelectorAll('a[href]')];
  if (el.matches('a[href]')) links.unshift(el);
  return links.filter((a) => {
    const h = a.getAttribute('href');
    return h && !h.startsWith('#') && !/^javascript:/i.test(h);
  });
}

function looksLikeItem(el, maxText) {
  if (el.classList.contains('picky-label') || el.closest(CHROME)) return false;
  const len = el.textContent.trim().length;
  if (len < 15 || len > maxText) return false;
  if (!realLinks(el).length) return false;
  const r = el.getBoundingClientRect();
  return r.width >= 120 && r.height >= 24;
}

const generic = {
  name: 'Any site',

  findItems() {
    if (!document.body) return [];
    const found = new Set();
    for (const el of document.querySelectorAll('article, [role="article"]')) {
      if (looksLikeItem(el, 6000)) found.add(el);
    }
    // Repeated siblings: a container whose children mostly share a tag and each look like a card.
    for (const c of document.body.querySelectorAll(CONTAINERS)) {
      if (c.childElementCount < 4) continue;
      const groups = new Map();
      for (const k of c.children) {
        if (k.classList.contains('picky-label')) continue;
        const sig = k.tagName + (k.getAttribute('role') || '');
        if (!groups.has(sig)) groups.set(sig, []);
        groups.get(sig).push(k);
      }
      let group = [];
      for (const g of groups.values()) if (g.length > group.length) group = g;
      if (group.length < 4) continue;
      const good = group.filter((k) => looksLikeItem(k, 2000));
      if (good.length >= 4 && good.length >= group.length * 0.6) good.forEach((k) => found.add(k));
    }
    // Keep the innermost candidates: a row of cards should yield the cards.
    const containers = new Set();
    for (const el of found) {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        if (found.has(p)) containers.add(p);
      }
    }
    return [...found].filter((el) => !containers.has(el));
  },

  key(el) {
    let best = null;
    let bestLen = -1;
    for (const a of realLinks(el)) {
      const len = a.textContent.trim().length;
      if (len > bestLen) [best, bestLen] = [a, len];
    }
    if (best) {
      try {
        const u = new URL(best.href);
        u.hash = '';
        return `g:${u.href}`;
      } catch {}
    }
    return `g:t:${clean(el.textContent).slice(0, 160)}`;
  },

  extract(el) {
    // innerText keeps line breaks between blocks, but is empty while Picky hides the item.
    const text = clean(el.classList.contains('picky-hidden') ? el.textContent : el.innerText).slice(0, 500);
    const alts = [...el.querySelectorAll('img[alt]')].map((i) => clean(i.alt)).filter((a) => a.length > 3).slice(0, 3);
    if (!text && !alts.length) return null;
    const heading = textOf(el.querySelector('h1, h2, h3, h4, [role="heading"]'));
    const state = { site: location.hostname };
    if (heading) state.title = heading.slice(0, 200);
    if (text) state.text = text;
    if (alts.length) state.image_descriptions = alts;
    const aria = clean(el.getAttribute('aria-label'));
    if (aria) state.label = aria.slice(0, 200);
    return { feed_item: state };
  },

  image(el) {
    let best = null;
    let bestArea = 0;
    for (const img of el.querySelectorAll('img')) {
      if (img.naturalWidth < 200 || img.naturalHeight < 120) continue;
      const r = img.getBoundingClientRect();
      if (r.width * r.height > bestArea) [best, bestArea] = [img, r.width * r.height];
    }
    return best?.currentSrc || best?.src || null;
  },

  shape() {
    return 'row';
  },

  isDark() {
    for (const el of [document.body, document.documentElement]) {
      const m = getComputedStyle(el).backgroundColor.match(/[\d.]+/g);
      if (m && (m[3] === undefined || Number(m[3]) > 0.5)) {
        return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255 < 0.45;
      }
    }
    return matchMedia('(prefers-color-scheme: dark)').matches;
  },
};

// ---- Instagram: feed posts (<article>), grid tiles (profile, explore, tags) and the reels viewer.
// Class names are obfuscated, so only tags, roles, hrefs and alt text are used. Keys are post shortcodes.

const IG_POST_LINK = 'a[href*="/p/"], a[href*="/reel/"], a[href*="/reels/"]';
const igCode = (href) => href?.match(/\/(?:p|reels?)\/(?!audio\/)([\w-]{5,})/)?.[1] || null;
const IG_NOT_USERS = new Set(['explore', 'reels', 'reel', 'p', 'direct', 'accounts', 'stories', 'about', 'legal']);
const isProfilePic = (img) => /profile picture/i.test(img.alt || '');

// Reels viewer: walk up from a <video> to the element whose siblings also hold videos.
function reelItem(video) {
  if (video.closest('article')) return null;
  for (let el = video; el.parentElement && el.parentElement !== document.body; el = el.parentElement) {
    const siblings = [...el.parentElement.children].filter((c) => c !== el && c.querySelector('video'));
    if (siblings.length) return el;
  }
  return null;
}

function igUser(el) {
  const own = el.matches('a[href]') && el.getAttribute('href').match(/^\/([\w.]+)\/(?:p|reel)\//);
  if (own) return own[1];
  for (const a of el.querySelectorAll('a[href]')) {
    const m = a.getAttribute('href').match(/^\/([\w.]{2,30})\/?$/);
    if (m && !IG_NOT_USERS.has(m[1]) && textOf(a)) return m[1];
  }
  return '';
}

// The caption is the longest piece of text that isn't a button, timestamp or feed chrome.
const IG_CHROME_TEXT = /^(liked by|view all|add a comment|see translation|original audio|\d[\d,.]*\s*(likes?|comments?|views?)\b)/i;
function igCaption(el) {
  let best = '';
  for (const n of el.querySelectorAll('h1, span[dir="auto"], div[dir="auto"]')) {
    if (n.closest('button, time, [role="button"]')) continue;
    const t = textOf(n);
    if (IG_CHROME_TEXT.test(t)) continue;
    if (t.length > best.length) best = t;
  }
  return best.length >= 3 ? best : '';
}

// Pick a srcset candidate near 640px wide: enough detail for Jev, cheap to fetch.
function pickSrc(img, want = 640) {
  const set = (img.getAttribute('srcset') || '').split(',').map((part) => {
    const [url, size] = part.trim().split(/\s+/);
    return { url, w: parseInt(size, 10) || 0 };
  }).filter((c) => c.url);
  const usable = set.filter((c) => c.w >= 320).sort((a, b) => Math.abs(a.w - want) - Math.abs(b.w - want));
  const url = usable[0]?.url || img.currentSrc || img.getAttribute('src');
  return url ? new URL(url, location.href).href : null;
}

const instagram = {
  name: 'Instagram',
  site: 'instagram.com',

  findItems() {
    const items = new Set();
    for (const post of document.querySelectorAll('article')) {
      if (post.querySelector(IG_POST_LINK)) items.add(post);
    }
    for (const a of document.querySelectorAll(IG_POST_LINK)) {
      if (!a.closest('article') && a.querySelector('img') && igCode(a.getAttribute('href'))) items.add(a);
    }
    for (const video of document.querySelectorAll('video')) {
      const item = reelItem(video);
      if (item) items.add(item);
    }
    return [...items];
  },

  key(el) {
    const links = el.matches(IG_POST_LINK) ? [el] : el.querySelectorAll(IG_POST_LINK);
    for (const a of links) {
      const code = igCode(a.getAttribute('href'));
      if (code) return `ig:${code}`;
    }
    // Reels in the viewer may carry no post link; fall back to who posted what.
    // textContent, not innerText: a hidden item's text must still give the same key.
    const text = clean(el.textContent).slice(0, 160);
    return text.length >= 10 ? `ig:t:${text}` : null;
  },

  extract(el) {
    const alts = [...el.querySelectorAll('img[alt]')].filter((i) => !isProfilePic(i))
      .map((i) => clean(i.alt)).filter((a) => a.length > 3).slice(0, 3);
    const tags = [...new Set([...el.querySelectorAll('a[href*="/explore/tags/"]')].map(textOf).filter(Boolean))].slice(0, 10);
    const username = igUser(el);
    let caption = igCaption(el);
    if (username && caption.startsWith(username)) caption = caption.slice(username.length).trim(); // "user caption…"
    if (!caption && !alts.length) return null;
    const href = (el.matches(IG_POST_LINK) ? el : el.querySelector(IG_POST_LINK))?.getAttribute('href') || '';
    const state = { platform: 'Instagram', kind: /\/reels?\//.test(href) || el.querySelector('video') ? 'reel' : 'post' };
    if (username) state.username = username;
    if (caption) state.caption = caption.slice(0, 500);
    if (tags.length) state.hashtags = tags;
    if (alts.length) state.image_descriptions = alts;
    return { feed_item: state };
  },

  image(el) {
    const imgs = [...el.querySelectorAll('img')].filter((i) => !isProfilePic(i));
    const img = imgs.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
    if (img) return pickSrc(img);
    const poster = el.querySelector('video[poster]')?.getAttribute('poster');
    return poster ? new URL(poster, location.href).href : null;
  },

  shape(el) {
    return el.matches('a') ? 'tile' : 'row';
  },

  isDark() {
    return generic.isDark();
  },
};

globalThis.PickyAdapters = { youtube, instagram, generic };
