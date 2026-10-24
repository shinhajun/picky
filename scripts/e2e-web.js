// Picky on any site, against live Jev, light and dark: generic pages (Hacker News table rows, lobste.rs),
// ads on a news fixture (a cross-origin creative nested in a safeframe, AdSense and Amazon iframes, a
// friendly GPT frame, an image-only creative, Taboola, a Sponsored card) with an "every ad" rule, a
// topical ad rule and an "only these ads" rule (iframe ads never hidden and then shown again), YouTube's
// and Instagram's native ads (fixtures, and live YouTube when headless gets ads), Clean feed taking ads
// out of YouTube's data, both hidden-item styles with the popup's undo, login pages left alone, the
// per-site off switch, and a real ad-heavy site (optional: needs ads in headless).
// Usage: node scripts/e2e-web.js     Screenshots go to .e2e/web-*.png
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { costOf } from '../extension/jev.js';

const root = path.resolve(import.meta.dirname, '..');
const extDir = path.join(root, 'extension');
const outDir = path.join(root, '.e2e');
fs.mkdirSync(outDir, { recursive: true });
const apiKey = fs.readFileSync(path.join(root, '.env'), 'utf8').match(/^TYPESAFE_API_KEY=(.*)$/m)?.[1].trim().replace(/^["']|["']$/g, '');
if (!apiKey) throw new Error('TYPESAFE_API_KEY missing in .env');
const fixture = (f) => fs.readFileSync(path.join(root, 'scripts', 'fixtures', f));

const NEWS = 'https://news.picky-fixture.test/';
const YT_ADS = 'https://www.youtube.com/results?search_query=picky+ads+fixture';
const IG_ADS = 'https://www.instagram.com/';
// The next page of YouTube results the fixture fetches: two videos between two ads.
const YT_NEXT = JSON.stringify({ onResponseReceivedCommands: [{ appendContinuationItemsAction: { continuationItems: [
  { itemSectionRenderer: { contents: [
    { searchPyvRenderer: { ads: [{ adSlotRenderer: { adSlotMetadata: { slotType: 'SLOT_TYPE_IN_FEED' } } }] } },
    { videoRenderer: { videoId: 'pkyAdsFix04', title: { runs: [{ text: 'Wiring a smart home on a budget' }] }, ownerText: { runs: [{ text: 'NetChuck' }] } } },
    { adSlotRenderer: { adSlotMetadata: { slotType: 'SLOT_TYPE_IN_FEED' } } },
    { videoRenderer: { videoId: 'pkyAdsFix05', title: { runs: [{ text: 'Sourdough for absolute beginners' }] }, ownerText: { runs: [{ text: 'Kitchen Notes' }] } } },
  ] } },
  { continuationItemRenderer: { continuationEndpoint: {} } },
] } }] });
const LOGIN = 'https://login.picky-fixture.test/';
const CREATIVES = {
  casino: { w: 728, h: 90, headline: 'Spin to win: $500 welcome bonus', body: 'Play slots and live casino tonight. 18+ only.', image: 'casino', landing: 'https://www.jackpotcity.example/welcome' },
  'casino-img': { w: 300, h: 250, image: 'casino', landing: 'https://www.spinpalace.example/' }, // a picture, nothing else
  tech: { w: 300, h: 250, headline: 'The new MacBook Pro with M5', body: 'Built for Apple Intelligence. Order today.', image: 'laptop', landing: 'https://www.apple.com/macbook-pro/' },
  crypto: { w: 300, h: 250, headline: 'Buy Bitcoin in 3 minutes', body: 'Trade 200+ coins with zero fees.', image: 'coin', landing: 'https://www.coinbase.com/' },
};
const creativeHtml = (c) => {
  const k = CREATIVES[c];
  const click = `https://adclick.g.doubleclick.net/pcs/click?adurl=${encodeURIComponent(k.landing)}`;
  const text = k.headline ? `<div style="flex:1;padding:8px 10px"><b style="display:block">${k.headline}</b><span>${k.body}</span></div>` : '';
  const img = `<img src="https://tpc.googlesyndication.com/simgad/${k.image}.png" alt="" width="${k.headline ? Math.min(k.h * 1.2, 150) : k.w}" height="${k.headline ? Math.min(k.h, 125) : k.h}" style="display:block;object-fit:cover">`;
  return `<!doctype html><html><body style="margin:0;font:14px system-ui,sans-serif;background:#fff;color:#111;overflow:hidden">
    <a href="${click}" target="_blank" style="display:flex;${k.w > 400 ? '' : 'flex-direction:column;'}align-items:center;width:${k.w}px;height:${k.h}px;color:inherit;text-decoration:none">${img}${text}</a>
    <a href="https://adssettings.google.com/whythisad" style="position:absolute;top:0;right:0;font-size:9px;color:#888">AdChoices</a></body></html>`;
};
const LOGIN_HTML = `<!doctype html><html><head><title>Sign in</title></head><body style="font:16px system-ui;margin:40px">
  <h1>Sign in to Zebrafish Weekly</h1>
  <form><label>Email <input type="email" name="email"></label> <label>Password <input type="password" name="password"></label> <button>Sign in</button></form>
  <h2>Popular this week</h2>
  <ul>${['Zebrafish regrow their hearts: what that means for us', 'Zebrafish politics: senators debate aquarium funding', 'Why zebrafish are the lab animal of the decade', 'Ten zebrafish facts that will surprise you', 'Zebrafish and the crypto aquarium bubble']
    .map((t, i) => `<li style="padding:10px 0"><a href="/story/${i}">${t}</a><p>Read the full zebrafish story and comments from our readers.</p></li>`).join('')}</ul></body></html>`;

const report = [];
let failed = false;
function record(check, ok, details = {}, { optional = false } = {}) {
  if (!ok && !optional) failed = true;
  report.push({ check, ok, ...(optional ? { optional } : {}), ...details });
}
const errors = [];
const net = { calls: 0, tokens: 0, bodies: [] };

async function open(theme) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picky-web-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium', headless: true, locale: 'en-US', colorScheme: theme, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  context.on('console', (m) => m.type() === 'error' && /chrome-extension:\/\//.test(m.location()?.url || '') && errors.push(`[${theme}] ${m.text()}`));
  context.on('weberror', (e) => /chrome-extension:\/\//.test(e.error().stack || '') && errors.push(`[${theme}] ${e.error().message}`));
  // Every Jev call passes through here: billed usage, and what was sent (the login page check).
  await context.route('https://api.typesafe.ai/v1/systemone', async (route) => {
    const res = await route.fetch();
    const body = await res.text();
    if (res.status() === 200) {
      net.calls++;
      net.tokens += JSON.parse(body).usage?.input_tokens || 0;
    }
    net.bodies.push(route.request().postData() || '');
    await route.fulfill({ response: res, body });
  });
  // The fixture site and its ads; nothing here reaches a real ad server.
  await context.route((url) => url.hostname.endsWith('picky-fixture.test'), (route) => {
    const url = new URL(route.request().url());
    if (url.hostname.startsWith('login.')) return route.fulfill({ contentType: 'text/html', body: LOGIN_HTML });
    return url.pathname === '/' ? route.fulfill({ contentType: 'text/html', body: fixture('ads-news.html') }) : route.fulfill({ status: 404, body: '' });
  });
  await context.route(/^https:\/\/(tpc\.googlesyndication\.com|ad\.doubleclick\.net|googleads\.g\.doubleclick\.net|aax-us-east\.amazon-adsystem\.com)\//, (route) => {
    const url = new URL(route.request().url());
    const c = url.searchParams.get('c') || url.pathname.match(/creative\/([\w-]+)\.html/)?.[1];
    const image = url.pathname.match(/^\/simgad\/(casino|laptop|coin|shoe)\.png$/)?.[1];
    if (image) return route.fulfill({ contentType: 'image/png', body: fixture(`ad-${image}.png`) });
    if (!CREATIVES[c]) return route.continue(); // a real site's ads (step 9)
    if (url.pathname.includes('/safeframe/')) { // a container frame whose creative is another cross-origin frame
      const k = CREATIVES[c];
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><body style="margin:0"><iframe src="https://ad.doubleclick.net/creative/${c}.html" width="${k.w}" height="${k.h}" style="border:0;display:block"></iframe></body>` });
    }
    return route.fulfill({ contentType: 'text/html', body: creativeHtml(c) });
  });

  // YouTube and Instagram ad fixtures; everything else on those sites goes through.
  await context.route((url) => url.hostname === 'www.youtube.com' && url.searchParams.get('search_query') === 'picky ads fixture',
    (route) => route.fulfill({ contentType: 'text/html', body: fixture('youtube-ads.html') }));
  await context.route('https://www.youtube.com/youtubei/v1/search**', (route) => (/picky-fixture/.test(route.request().postData() || '')
    ? route.fulfill({ contentType: 'application/json', body: YT_NEXT }) : route.continue()));
  await context.route((url) => url.hostname === 'www.instagram.com', (route) => {
    const image = new URL(route.request().url()).pathname.match(/^\/fixture\/(casino|laptop|coin|shoe)\.png$/)?.[1];
    return route.fulfill(image ? { contentType: 'image/png', body: fixture(`ad-${image}.png`) } : { contentType: 'text/html', body: fixture('instagram-ads.html') });
  });

  const sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;
  sw.on('console', (m) => m.type() === 'error' && errors.push(`[${theme} sw] ${m.text()}`));
  if (!context.pages().some((p) => p.url().startsWith('chrome-extension://'))) await context.waitForEvent('page', { timeout: 3000 }).catch(() => {});
  for (const p of context.pages()) if (p.url().startsWith('chrome-extension://')) await p.close();
  await sw.evaluate((k) => chrome.storage.local.set({ apiKey: k, enabled: true }), apiKey);
  const page = await context.newPage();
  await page.addInitScript(slotSampler);
  if (theme === 'dark') { // YouTube's dark theme is an attribute, not the colour scheme
    await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => {
      if (location.hostname.endsWith('youtube.com')) document.documentElement.setAttribute('dark', '');
    }));
  }
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 360, height: 640 });
  await page.bringToFront();

  // Rules as [text, polarity, scope]; polarity null lets Jev sort polarity and scope (and waits for it).
  async function setRules(list) {
    const rules = list.map(([text, polarity, scope], i) => ({ id: `r${i}-${Date.now()}`, text, polarity, polaritySource: polarity ? 'user' : null, scope }));
    await sw.evaluate((rules) => chrome.storage.local.set({ rules }), rules);
    for (let i = 0; i < 150; i++) {
      const now = await sw.evaluate(() => chrome.storage.local.get('rules').then((s) => s.rules));
      if (now.every((r) => r.polarity && r.scope)) return now;
      await page.waitForTimeout(200);
    }
    throw new Error('rules were not classified');
  }
  const set = (values) => sw.evaluate((v) => chrome.storage.local.set(v), values);
  const tabId = async () => {
    await page.bringToFront();
    return (await sw.evaluate(() => chrome.tabs.query({ active: true })))[0].id;
  };
  const openPopup = async () => {
    await popup.goto(`chrome-extension://${extId}/popup.html?tab=${await tabId()}`);
    await popup.waitForTimeout(700);
  };
  return { context, sw, page, popup, setRules, set, tabId, openPopup };
}

// ---- page state ----
// Every animation frame, in the page: each ad item's state as the user sees it. An ad that was hidden
// and is visible again in a later frame is a flicker.
function slotSampler() {
  const out = { flicker: [], seen: {} };
  const last = new WeakMap();
  const nameOf = (el) => el.querySelector('iframe')?.getAttribute('src')?.match(/c=([\w-]+)/)?.[1] || el.querySelector('iframe')?.id || el.dataset.pickyKey;
  const tick = () => {
    try {
      for (const el of document.querySelectorAll('[data-picky-key^="ad:"]')) {
        const now = el.matches('.picky-hidden, .picky-collapsed') ? 'gone' : el.matches('.picky-revealed') ? 'revealed'
          : el.matches('.picky-pending') ? 'pending' : 'visible';
        const before = last.get(el);
        if (before === 'gone' && (now === 'visible' || now === 'pending')) out.flicker.push(`${nameOf(el)}: ${before} -> ${now}`);
        last.set(el, now);
        const seen = (out.seen[nameOf(el)] ||= []);
        if (seen[seen.length - 1] !== now) seen.push(now);
      }
    } catch {}
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.__slots = out;
}

function readYtAds() {
  const st = (el) => (!el?.dataset.pickyKey ? 'untracked' : ['hidden', 'collapsed', 'blurred', 'revealed', 'pending'].find((c) => el.classList.contains(`picky-${c}`)) || 'shown');
  const casino = document.querySelector('ytd-search-pyv-renderer');
  const vpn = [...document.querySelectorAll('ytd-ad-slot-renderer')].find((el) => !el.closest('ytd-search-pyv-renderer'));
  const videos = [...document.querySelectorAll('ytd-video-renderer')];
  return {
    casino: st(casino), vpn: st(vpn), adKeys: [casino, vpn].map((el) => el?.dataset.pickyKey?.slice(0, 6)),
    videos: videos.length, videosJudged: videos.filter((v) => v.dataset.pickyKey).length,
    videosHidden: videos.filter((v) => v.matches('.picky-hidden, .picky-collapsed, .picky-blurred')).length,
    label: casino?.querySelector('.picky-label')?.shadowRoot?.querySelector('.card')?.textContent.replace(/\s+/g, ' ').trim().slice(0, 60) || '',
    response: window.__fixtureResponse || null,
  };
}

function readIgAds() {
  const st = (el) => (!el?.dataset.pickyKey ? 'untracked' : ['hidden', 'collapsed', 'blurred', 'revealed', 'pending'].find((c) => el.classList.contains(`picky-${c}`)) || 'shown');
  const post = (user) => [...document.querySelectorAll('article')].find((a) => a.textContent.includes(user));
  const reel = (user) => [...document.querySelectorAll('.reel')].find((r) => r.textContent.includes(user));
  return {
    posts: { cat: st(post('catlover.daily')), casinoAd: st(post('spinpalace.official')), shoeAd: st(post('strideworks')), bakes: st(post('weekend.bakes')) },
    reels: { cat: st(reel('catlover.daily')), coinAd: st(reel('coinrocket.app')), bakes: st(reel('weekend.bakes')) },
    adKeys: [...document.querySelectorAll('[data-picky-key^="ad:ig:"]')].length,
  };
}

function readGeneric() {
  const st = (el) => ['hidden', 'collapsed', 'blurred', 'revealed', 'pending'].find((c) => el.classList.contains(`picky-${c}`)) || 'shown';
  const items = [...document.querySelectorAll('[data-picky-key]')].filter((el) => el.dataset.pickyKey);
  const by = {};
  for (const el of items) by[st(el)] = (by[st(el)] || 0) + 1;
  const visibleLabels = [...document.querySelectorAll('.picky-label')].filter((l) => l.getClientRects().length && getComputedStyle(l).display !== 'none').length;
  const hiddenRows = [...document.querySelectorAll('tr.picky-hidden, tr.picky-collapsed')];
  return {
    keyed: items.length, ...by, visibleLabels,
    // A hidden Hacker News story takes its points/comments row with it.
    rowsWithCompanion: hiddenRows.filter((tr) => tr.nextElementSibling?.classList.contains('picky-companion-gone')).length, hiddenRows: hiddenRows.length,
    collapsedTakeSpace: [...document.querySelectorAll('.picky-collapsed')].filter((el) => el.getBoundingClientRect().height > 0).length,
    overflow: [...document.querySelectorAll('.picky-hidden')].filter((el) => {
      const card = el.querySelector('.picky-label')?.shadowRoot?.querySelector('.card');
      return card && card.getBoundingClientRect().width > el.getBoundingClientRect().width + 1;
    }).length,
    sample: [...document.querySelectorAll('.picky-hidden, .picky-collapsed')].slice(0, 3).map((el) => el.textContent.replace(/\s+/g, ' ').trim().slice(0, 70)),
  };
}

function readAds() {
  const st = (el) => (!el ? 'untracked' : ['hidden', 'collapsed', 'blurred', 'revealed', 'pending'].find((c) => el.classList.contains(`picky-${c}`)) || 'shown');
  const slot = (sel) => document.querySelector(sel)?.closest('[data-picky-key^="ad:"]');
  const stories = [...document.querySelectorAll('ul.stories li:not(.promo)')];
  return {
    slots: {
      casino: st(slot('iframe[src*="c=casino"]:not([src*="casino-img"])')),
      casinoImg: st(slot('iframe[src*="casino-img"]')),
      crypto: st(slot('iframe[src*="c=crypto"]')),
      tech: st(slot('iframe[src*="c=tech"]')),
      shoes: st(slot('iframe[id$="side_0"]')),
      taboola: st(slot('#taboola-below-article-thumbnails .card')),
      sponsoredCard: st(slot('li.promo h2')),
    },
    // The "Advertisement" labels and wrappers go with their ad.
    labelsInSlots: [...document.querySelectorAll('.ad-label, .inline-ad > p')].every((l) => l.closest('[data-picky-key^="ad:"]')),
    stories: stories.length,
    storiesJudged: stories.filter((li) => li.dataset.pickyKey).length,
    storiesHidden: stories.filter((li) => li.matches('.picky-hidden, .picky-collapsed, .picky-blurred')).length,
    bitcoinStory: st(document.querySelector('a[href*="bitcoin-etf"]').closest('li')),
    visibleLabels: [...document.querySelectorAll('.picky-label')].filter((l) => l.getClientRects().length).length,
    collapsedTakeSpace: [...document.querySelectorAll('.picky-collapsed')].filter((el) => el.getBoundingClientRect().height > 0).length,
  };
}

// Poll until the page stops changing (ads report from their frames a little after load).
async function settle(page, read, { min = 3000, max = 20000 } = {}) {
  const t = Date.now();
  let last = '';
  let same = 0;
  let s;
  for (;;) {
    await page.waitForTimeout(500);
    s = await page.evaluate(read);
    const now = JSON.stringify(s);
    same = now === last && !now.includes('pending') ? same + 1 : 0;
    last = now;
    if ((Date.now() - t > min && same >= 4) || Date.now() - t > max) return s;
  }
}
const allOf = (slots, state, names) => names.every((n) => slots[n] === state);

for (const theme of ['light', 'dark']) {
  const { context, sw, page, popup, setRules, set, tabId, openPopup } = await open(theme);
  const shot = (name, p = page) => p.screenshot({ path: path.join(outDir, `web-${name}-${theme}.png`) });

  // ---- 1. Generic sites, on by default ----
  await setRules([['No AI or LLM posts', 'avoid', 'content']]);
  await set({ hiddenStyle: 'card' });
  await page.goto('https://news.ycombinator.com/', { waitUntil: 'domcontentloaded' });
  const hn = await settle(page, readGeneric);
  await shot('hn-card');
  record(`${theme}:generic-hn-card`, hn.keyed >= 20 && (hn.hidden || 0) + (hn.blurred || 0) > 0 && hn.rowsWithCompanion === hn.hiddenRows && hn.overflow === 0 && !hn.pending, hn);
  await set({ hiddenStyle: 'none' });
  const hnNone = await settle(page, readGeneric, { min: 1500 });
  await shot('hn-notrace');
  record(`${theme}:generic-hn-notrace`, (hnNone.collapsed || 0) === (hn.hidden || 0) && !hnNone.hidden && hnNone.rowsWithCompanion === hnNone.hiddenRows && hnNone.collapsedTakeSpace === 0,
    { collapsed: hnNone.collapsed, blurred: hnNone.blurred, rowsWithCompanion: hnNone.rowsWithCompanion, collapsedTakeSpace: hnNone.collapsedTakeSpace });

  await set({ hiddenStyle: 'card' });
  await setRules([['No posts about C, C++ or Rust', 'avoid', 'content']]);
  await page.goto('https://lobste.rs/', { waitUntil: 'domcontentloaded' });
  const lob = await settle(page, readGeneric);
  await shot('lobsters-card');
  record(`${theme}:generic-lobsters-card`, lob.keyed >= 15 && (lob.hidden || 0) + (lob.blurred || 0) > 0 && lob.overflow === 0, lob);

  // ---- 2. Ads: every ad, card style ----
  const classified = await setRules([['No ads at all', null]]); // Jev sorts it: avoid, every ad
  record(`${theme}:rule-scope-classified`, classified[0].polarity === 'avoid' && classified[0].scope === 'every_ad', { polarity: classified[0].polarity, scope: classified[0].scope });
  await page.goto(NEWS, { waitUntil: 'domcontentloaded' });
  const all = await settle(page, readAds, { min: 5000 });
  await shot('ads-every-card');
  record(`${theme}:ads-every-ad-card`, allOf(all.slots, 'hidden', Object.keys(all.slots)) && all.labelsInSlots && all.storiesHidden === 0 && all.storiesJudged === all.stories, all);

  // ---- 3. Ads: a topical rule; the creative is read inside the (nested, cross-origin) frames ----
  await setRules([['No gambling or crypto ads', 'avoid', 'some_ads']]);
  await page.goto(NEWS, { waitUntil: 'domcontentloaded' });
  const topical = await settle(page, readAds, { min: 6000 });
  const topicalFrames = await page.evaluate(() => window.__slots);
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot('ads-topical-card');
  record(`${theme}:ads-topical-card`,
    allOf(topical.slots, 'hidden', ['casino', 'casinoImg', 'crypto']) && allOf(topical.slots, 'shown', ['tech', 'shoes'])
      && topical.storiesHidden === 0 && topical.bitcoinStory === 'shown' && topical.labelsInSlots && topicalFrames.flicker.length === 0,
    { ...topical, flicker: topicalFrames.flicker });

  // ---- 4. Leave no trace: the same ads fold away; the popup brings them back ----
  await set({ hiddenStyle: 'none' });
  const none = await settle(page, readAds, { min: 1500 });
  await shot('ads-topical-notrace');
  await openPopup();
  const popupBefore = await popup.evaluate(() => ({ visible: !document.getElementById('here').hidden, text: document.getElementById('here').textContent.replace(/\s+/g, ' ').trim() }));
  const hiddenCount = Number(popupBefore.text.match(/(\d+) hidden on this page/)?.[1] || 0);
  await popup.screenshot({ path: path.join(outDir, `web-popup-notrace-${theme}.png`), fullPage: true });
  await popup.click('#hereToggle');
  await popup.waitForTimeout(500);
  const shownAgain = await page.evaluate(readAds);
  const popupShown = await popup.evaluate(() => document.getElementById('here').textContent.replace(/\s+/g, ' ').trim());
  await page.bringToFront();
  await shot('ads-notrace-shown');
  await popup.click('#hereToggle');
  await popup.waitForTimeout(500);
  const hiddenAgain = await page.evaluate(readAds);
  record(`${theme}:ads-notrace`,
    allOf(none.slots, 'collapsed', ['casino', 'casinoImg', 'crypto']) && none.collapsedTakeSpace === 0 && none.visibleLabels === 0
      && popupBefore.visible && hiddenCount >= 3 && /Show them/.test(popupBefore.text)
      && allOf(shownAgain.slots, 'revealed', ['casino', 'casinoImg', 'crypto']) && /Hide again/.test(popupShown)
      && allOf(hiddenAgain.slots, 'collapsed', ['casino', 'casinoImg', 'crypto']),
    { slots: none.slots, collapsedTakeSpace: none.collapsedTakeSpace, visibleLabels: none.visibleLabels, popup: popupBefore.text, afterShow: shownAgain.slots, popupAfterShow: popupShown, afterHide: hiddenAgain.slots });

  // ---- 5. "Only these ads": other ads go, the articles stay ----
  await set({ hiddenStyle: 'card' });
  await setRules([['only tech ads', 'want', 'some_ads']]);
  await page.goto(NEWS, { waitUntil: 'domcontentloaded' });
  const want = await settle(page, readAds, { min: 6000 });
  const wantFrames = await page.evaluate(() => window.__slots);
  await shot('ads-only-tech');
  // A crypto exchange is borderline "tech" for Jev: blurred (unsure) is as fine as hidden.
  record(`${theme}:ads-only-tech`, want.slots.tech === 'shown' && allOf(want.slots, 'hidden', ['casino', 'casinoImg', 'shoes'])
    && ['hidden', 'blurred'].includes(want.slots.crypto) && want.storiesHidden === 0, want);
  // Iframe ads wait (pending) for their creative instead of hiding on a guess: never hidden, then shown.
  record(`${theme}:ads-no-flicker`, wantFrames.flicker.length === 0 && !wantFrames.seen.tech?.includes('gone') && wantFrames.seen.tech?.at(-1) === 'visible',
    { flicker: wantFrames.flicker, frames: wantFrames.seen });

  // ---- 5b. YouTube's own ads (fixture shaped like live search results) ----
  await setRules([['No ads at all', 'avoid', 'every_ad']]);
  await page.goto(YT_ADS, { waitUntil: 'domcontentloaded' });
  const ytAll = await settle(page, readYtAds, { min: 3000 });
  await shot('yt-ads-every');
  record(`${theme}:youtube-ads-every-ad`, ytAll.casino === 'hidden' && ytAll.vpn === 'hidden' && ytAll.adKeys.every((k) => k === 'ad:yt:')
    && ytAll.videosJudged === ytAll.videos && ytAll.videosHidden === 0 && /Picky hid this ad/.test(ytAll.label), ytAll);
  await setRules([['No gambling or crypto ads', 'avoid', 'some_ads']]);
  await page.goto(YT_ADS, { waitUntil: 'domcontentloaded' });
  const ytTopical = await settle(page, readYtAds, { min: 3000 });
  await shot('yt-ads-topical');
  record(`${theme}:youtube-ads-topical`, ytTopical.casino === 'hidden' && ytTopical.vpn === 'shown' && ytTopical.videosHidden === 0, ytTopical);
  // Clean feed with a rule against every ad: ads are taken out of YouTube's data, and the ones already
  // drawn fold away.
  await setRules([['No ads at all', 'avoid', 'every_ad']]);
  await set({ cleanFeed: true });
  await page.goto(YT_ADS, { waitUntil: 'domcontentloaded' });
  const ytClean = await settle(page, readYtAds, { min: 3000 });
  const ytCleanStats = await sw.evaluate(async (id) => chrome.tabs.sendMessage(id, { type: 'getStats' }), await tabId());
  await shot('yt-ads-clean');
  await set({ cleanFeed: false });
  record(`${theme}:youtube-clean-feed-ads`, ytClean.response?.adSlots === 0 && ytClean.response?.pyv === 0 && ytClean.response?.videos === 2
    && ytClean.casino === 'collapsed' && ytClean.vpn === 'collapsed' && ytCleanStats.prunedAds >= 2 && ytCleanStats.facts.hiddenAds >= 4,
  { response: ytClean.response, casino: ytClean.casino, vpn: ytClean.vpn, prunedAds: ytCleanStats.prunedAds, hiddenAds: ytCleanStats.facts.hiddenAds });

  // ---- 5c. Instagram's "Sponsored" posts and reels (fixture: the feed needs a login) ----
  await page.goto(IG_ADS, { waitUntil: 'domcontentloaded' });
  const igAll = await settle(page, readIgAds, { min: 3000 });
  await shot('ig-ads-every');
  record(`${theme}:instagram-ads-every-ad`, igAll.posts.casinoAd === 'hidden' && igAll.posts.shoeAd === 'hidden' && igAll.reels.coinAd === 'hidden'
    && igAll.posts.cat === 'shown' && igAll.posts.bakes === 'shown' && igAll.reels.cat === 'shown' && igAll.reels.bakes === 'shown' && igAll.adKeys === 3, igAll);
  await setRules([['No gambling or crypto ads', 'avoid', 'some_ads']]);
  await page.goto(IG_ADS, { waitUntil: 'domcontentloaded' });
  const igTopical = await settle(page, readIgAds, { min: 3000 });
  await shot('ig-ads-topical');
  record(`${theme}:instagram-ads-topical`, igTopical.posts.casinoAd === 'hidden' && igTopical.reels.coinAd === 'hidden' && igTopical.posts.shoeAd === 'shown'
    && igTopical.posts.cat === 'shown' && igTopical.posts.bakes === 'shown', igTopical);

  // ---- 6. A page with a password field is never read or sent ----
  await setRules([['no politics', 'avoid', 'content']]);
  const sentBefore = net.bodies.length;
  await page.goto(LOGIN, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  const login = await page.evaluate(readGeneric);
  const leaked = net.bodies.slice(sentBefore).filter((b) => /zebrafish/i.test(b)).length;
  await openPopup();
  const loginNote = await popup.evaluate(() => !document.getElementById('siteNote').hidden && document.getElementById('siteNote').textContent);
  record(`${theme}:login-page-skipped`, login.keyed === 0 && leaked === 0 && /password field/.test(loginNote || ''), { keyed: login.keyed, jevRequestsWithPageText: leaked, popupNote: loginNote });

  // ---- 7. Switching a site off in the popup (it's on by default) ----
  await setRules([['No gambling or crypto ads', 'avoid', 'some_ads']]);
  await page.goto(NEWS, { waitUntil: 'domcontentloaded' });
  const onBefore = await settle(page, readAds, { min: 3000 });
  await openPopup();
  const switchOn = await popup.isChecked('#pickSite');
  await popup.click('#pick');
  await popup.waitForTimeout(300);
  const sitesOff = await sw.evaluate(() => chrome.storage.local.get('sites').then((s) => s.sites));
  const callsBefore = net.calls;
  await page.bringToFront();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  const off = await page.evaluate(readAds);
  const offCalls = net.calls - callsBefore;
  await openPopup();
  await popup.screenshot({ path: path.join(outDir, `web-popup-site-off-${theme}.png`), fullPage: true });
  await popup.click('#pick');
  await popup.waitForTimeout(300);
  const sitesOn = await sw.evaluate(() => chrome.storage.local.get('sites').then((s) => s.sites));
  record(`${theme}:site-off-switch`, switchOn && onBefore.storiesJudged > 0 && sitesOff?.['news.picky-fixture.test'] === false && off.storiesJudged === 0
    && Object.values(off.slots).every((s) => s === 'untracked') && offCalls === 0 && !('news.picky-fixture.test' in (sitesOn || {})),
  { switchOnByDefault: switchOn, sitesOff, judgedWhenOff: off.storiesJudged, jevCallsWhenOff: offCalls, sitesAfterBackOn: sitesOn });

  // ---- 8. Feed Facts counts the hidden ads ----
  const facts = await sw.evaluate(() => chrome.storage.session.get('facts').then((s) => Object.values(s.facts || {})));
  const hiddenAds = facts.reduce((n, f) => n + (f.hiddenAds || 0), 0);
  record(`${theme}:feed-facts-ads`, hiddenAds > 0, { hiddenAds, snapshots: facts.length });

  // The same choice in the options page.
  const options = await context.newPage();
  await options.goto(`chrome-extension://${new URL(sw.url()).host}/options.html`);
  await options.waitForTimeout(400);
  await options.screenshot({ path: path.join(outDir, `web-options-${theme}.png`), fullPage: true });
  await options.close();

  // ---- 9. A real ad-heavy site (optional: headless doesn't always get ads) ----
  if (theme === 'light') {
    await setRules([['No ads at all', 'avoid', 'every_ad']]);
    await page.goto('https://weather.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(9000);
    const real = await page.evaluate(() => ({
      adSlots: [...document.querySelectorAll('[data-picky-key^="ad:"]')].length,
      hidden: document.querySelectorAll('[data-picky-key^="ad:"].picky-hidden').length,
      gptFrames: [...document.querySelectorAll('iframe[id^="google_ads_iframe"]')].filter((f) => f.getBoundingClientRect().width > 50).length,
      unhiddenGpt: [...document.querySelectorAll('iframe[id^="google_ads_iframe"]')].filter((f) => f.getBoundingClientRect().width > 50 && !f.closest('.picky-hidden')).length,
    }));
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot('real-weather');
    record('light:real-ad-site', real.hidden > 0 && real.unhiddenGpt === 0, real, { optional: true });

    // Live YouTube search ads, when headless gets any (they come and go).
    const live = { query: null, ads: 0 };
    for (const q of ['best vpn', 'vpn', 'web hosting', 'antivirus', 'best vpn']) {
      await page.goto(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(5000);
      live.ads = await page.evaluate(() => document.querySelectorAll('ytd-search-pyv-renderer, ytd-ad-slot-renderer').length);
      if (live.ads) {
        live.query = q;
        break;
      }
    }
    if (live.ads) {
      await page.waitForTimeout(2500);
      Object.assign(live, await page.evaluate(() => {
        const outer = [...document.querySelectorAll('ytd-search-pyv-renderer, ytd-ad-slot-renderer')].filter((el) => !el.parentElement.closest('ytd-search-pyv-renderer, ytd-ad-slot-renderer'));
        return { outer: outer.length, hidden: outer.filter((el) => el.matches('.picky-hidden') && el.dataset.pickyKey?.startsWith('ad:yt:')).length,
          sample: outer[0]?.dataset.pickyKey ? outer[0].textContent.replace(/\s+/g, ' ').trim().slice(0, 80) : '' };
      }));
      await shot('yt-live-ads');
    }
    record('light:youtube-live-ads', live.ads > 0 && live.hidden === live.outer, live, { optional: true });
  }

  const swErrors = await sw.evaluate(() => self.__pickyErrors || []);
  errors.push(...swErrors);
  await context.close();
}

report.push({ check: 'run-total', jevCalls: net.calls, inputTokens: net.tokens, usd: +costOf(net.tokens).toFixed(5) });
for (const r of report) console.log(JSON.stringify(r));
console.log(errors.length ? `EXTENSION ERRORS:\n${errors.join('\n')}` : 'extension console errors: none');
console.log(failed || errors.length ? 'E2E-WEB FAIL' : 'E2E-WEB PASS');
process.exit(failed || errors.length ? 1 : 0);
