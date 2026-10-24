// Clean feed on YouTube, against the live site and Jev: removed videos never reach the DOM, infinite
// scroll keeps going, search/watch pages work, slow Jev falls back to the original response, the
// "nothing nearby" cap stops runaway loading, and switching it off restores normal hiding.
// Usage: node scripts/e2e-clean.js     Screenshots go to .e2e/clean-*.png
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const extDir = path.join(root, 'extension');
const outDir = path.join(root, '.e2e');
const apiKey = fs.readFileSync(path.join(root, '.env'), 'utf8').match(/^TYPESAFE_API_KEY=(.*)$/m)?.[1].trim().replace(/^["']|["']$/g, '');
if (!apiKey) throw new Error('TYPESAFE_API_KEY missing in .env');

const report = [];
let failed = false;
const record = (check, ok, details = {}) => {
  if (!ok) failed = true;
  report.push({ check, ok, ...details });
};
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null;
};

async function open(theme) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picky-clean-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium', headless: true, locale: 'en-US', colorScheme: theme, viewport: { width: 1400, height: 1000 },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--autoplay-policy=no-user-gesture-required'],
  });
  const errors = [];
  context.on('console', (m) => m.type() === 'error' && /chrome-extension:\/\//.test(m.location()?.url || '') && errors.push(m.text()));
  context.on('weberror', (e) => /chrome-extension:\/\//.test(e.error().stack || '') && errors.push(e.error().message));
  const feedRequests = { browse: 0, search: 0, next: 0 };
  context.on('request', (r) => {
    const m = r.url().match(/youtubei\/v1\/(browse|search|next)\b/);
    if (m) feedRequests[m[1]]++;
  });
  let jevDelay = 0; // ms added to every Jev answer, to force Clean feed timeouts
  await context.route('https://api.typesafe.ai/v1/systemone', async (route) => {
    const res = await route.fetch();
    if (jevDelay) await new Promise((r) => setTimeout(r, jevDelay));
    await route.fulfill({ response: res });
  });
  const sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;
  // The first run opens the options page (no key yet); let it open, then close it.
  if (!context.pages().some((p) => p.url().startsWith('chrome-extension://'))) await context.waitForEvent('page', { timeout: 3000 }).catch(() => {});
  for (const p of context.pages()) if (p.url().startsWith('chrome-extension://')) await p.close();
  const page = await context.newPage();
  // Every video id that ever appears in the page's DOM (links), from document start.
  await page.addInitScript(() => {
    window.__seen = new Set();
    const note = () => {
      for (const a of document.querySelectorAll('a[href*="watch?v="], a[href*="/shorts/"]')) {
        const m = a.getAttribute('href').match(/v=([\w-]{11})|shorts\/([\w-]{11})/);
        if (m) window.__seen.add(m[1] || m[2]);
      }
    };
    new MutationObserver(note).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
  });
  if (theme === 'dark') {
    await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => {
      if (location.hostname.endsWith('youtube.com')) document.documentElement.setAttribute('dark', '');
    }));
  }
  const setRules = (texts, polarity) => sw.evaluate(({ texts, polarity }) => chrome.storage.local.set({
    rules: texts.map((text, i) => ({ id: `r${i}`, text, polarity, polaritySource: 'user' })),
  }), { texts, polarity });
  const tabId = async () => {
    await page.bringToFront();
    return (await sw.evaluate(() => chrome.tabs.query({ active: true })))[0].id;
  };
  const timings = async () => sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'getTimings' }), await tabId());
  const spaSearch = async (q, wait = 6000) => {
    await page.fill('input[name="search_query"]', q);
    await page.keyboard.press('Enter');
    await page.waitForURL(new RegExp(encodeURIComponent(q).replace(/%20/g, '\\+')));
    await page.waitForTimeout(wait);
  };
  const noteText = () => page.evaluate(() => {
    const n = document.querySelector('.picky-end-note');
    return n?.getBoundingClientRect().height ? n.shadowRoot.querySelector('.text').textContent.replace(/\s+/g, ' ').trim() : null;
  });
  await sw.evaluate((k) => chrome.storage.local.set({ apiKey: k, enabled: true }), apiKey);
  return { context, sw, extId, page, errors, feedRequests, setJevDelay: (ms) => { jevDelay = ms; }, setRules, tabId, timings, spaSearch, noteText, userDataDir };
}

// ---------------- light run: behaviour ----------------
const L = await open('light');
const { page, sw } = L;
await L.setRules(['정치 얘기 싫어'], 'avoid');
await page.goto('https://www.youtube.com/results?search_query=weather', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);

// 1. The switch lives in the popup, on YouTube only.
const popup = await L.context.newPage();
await popup.setViewportSize({ width: 360, height: 640 });
await popup.goto(`chrome-extension://${L.extId}/popup.html?tab=${await L.tabId()}`);
await popup.waitForTimeout(600);
const switchShown = await popup.isVisible('#cleanFeed');
await popup.click('.clean-row');
await popup.waitForTimeout(900);
const cleanOn = await sw.evaluate(() => chrome.storage.local.get('cleanFeed').then((s) => s.cleanFeed));
await popup.screenshot({ path: path.join(outDir, 'clean-popup-switch.png'), fullPage: true });
record('popup-switch', switchShown && cleanOn === true, { switchShown, cleanFeed: cleanOn });

// 2. Removed videos never appear in the DOM (SPA search: the response passes through Clean feed).
await L.spaSearch('election news');
let t = await L.timings();
let seen = await page.evaluate(() => [...window.__seen]);
const leaked = t.removed.filter((k) => seen.includes(k.slice(5)));
const pill = await page.evaluate(() => document.querySelector('.picky-clean-ui')?.shadowRoot?.querySelector('.pill:not([hidden])')?.textContent || null);
record('removed-never-in-dom', t.removed.length > 0 && leaked.length === 0 && /Picky removed \d+ video/.test(pill || ''),
  { removed: t.removed.length, leakedIntoDom: leaked.length, pill });

// 2b. The first page (no waiting possible there): hidden videos fold away instead of leaving tombstones,
//     go into the removed list, and the panel's Show unfolds one in place.
await page.goto('https://www.youtube.com/results?search_query=senate+election+news', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);
const firstPage = await page.evaluate(() => ({
  tombstones: document.querySelectorAll('.picky-hidden').length,
  folded: document.querySelectorAll('.picky-collapsed').length,
  pill: document.querySelector('.picky-clean-ui')?.shadowRoot?.querySelector('.pill:not([hidden])')?.textContent || '',
  // Shelves still on screen with nothing visible inside (a header and "Show more" with no videos).
  emptyShelves: [...document.querySelectorAll('grid-shelf-view-model, ytd-reel-shelf-renderer, ytd-shelf-renderer')]
    .filter((sh) => sh.offsetHeight > 0 && ![...sh.querySelectorAll('ytm-shorts-lockup-view-model-v2, ytm-shorts-lockup-view-model, ytd-video-renderer, ytd-reel-item-renderer')].some((i) => i.offsetHeight > 0)).length,
}));
await page.screenshot({ path: path.join(outDir, 'clean-first-page-light.png') });
await page.evaluate(() => document.querySelector('.picky-clean-ui').shadowRoot.querySelector('.pill').click());
await page.waitForTimeout(300);
const unfold = await page.evaluate(async () => {
  const button = document.querySelector('.picky-clean-ui').shadowRoot.querySelector('.toggle');
  if (!button) return { button: false };
  button.click();
  await new Promise((r) => setTimeout(r, 400));
  const el = document.querySelector('.picky-revealed');
  return { button: true, unfolded: Boolean(el && el.offsetHeight > 0), label: button.textContent };
});
await page.evaluate(() => document.querySelector('.picky-clean-ui').shadowRoot.querySelector('.close').click());
record('first-page-folds-away', firstPage.tombstones === 0 && firstPage.emptyShelves === 0 && firstPage.folded > 0 && /removed \d+/.test(firstPage.pill) && unfold.unfolded,
  { ...firstPage, ...unfold });

// 2c. A grid closes up around folded items: every row but the last is full.
await page.goto('https://www.youtube.com/@CNN/videos', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);
const grid = await page.evaluate(() => {
  const items = [...document.querySelectorAll('ytd-rich-item-renderer')].filter((el) => el.offsetHeight > 0);
  const rows = new Map();
  for (const el of items) {
    const top = Math.round(el.getBoundingClientRect().top + scrollY);
    rows.set(top, (rows.get(top) || 0) + 1);
  }
  const counts = [...rows.keys()].sort((a, b) => a - b).map((k) => rows.get(k));
  const perRow = Number(document.querySelector('ytd-rich-item-renderer')?.getAttribute('items-per-row')) || 3;
  return { visible: items.length, folded: document.querySelectorAll('ytd-rich-item-renderer.picky-collapsed').length, tombstones: document.querySelectorAll('.picky-hidden').length, rowCounts: counts.join(','), perRow, gridRows: document.querySelectorAll('ytd-rich-grid-row').length };
});
const rowCounts = grid.rowCounts ? grid.rowCounts.split(',').map(Number) : [];
record('grid-closes-up', grid.folded > 0 && grid.tombstones === 0 && rowCounts.slice(0, -1).every((n) => n === grid.perRow), grid);

// 3. Infinite scroll keeps loading with Clean feed on (rule that removes only some videos).
await L.setRules(['No crypto hype'], 'avoid');
await L.spaSearch('stock market today', 4000);
const before = { search: L.feedRequests.search, items: await page.evaluate(() => document.querySelectorAll('ytd-video-renderer').length) };
for (let i = 0; i < 5; i++) {
  await page.mouse.wheel(0, 5000);
  await page.waitForTimeout(1800);
}
const after = { search: L.feedRequests.search, items: await page.evaluate(() => document.querySelectorAll('ytd-video-renderer').length) };
record('infinite-scroll-continues', after.search - before.search >= 2 && after.items > before.items,
  { continuationRequests: after.search - before.search, videosBefore: before.items, videosAfter: after.items });

// 4. Watch page and YouTube basics: playback, sidebar, comments, search.
await page.evaluate(() => window.scrollTo(0, 0));
await page.click('ytd-video-renderer a#video-title');
await page.waitForURL(/\/watch\?v=/);
await page.waitForTimeout(6000);
const watch = await page.evaluate(() => {
  const v = document.querySelector('video');
  return { playing: Boolean(v && v.currentTime > 0.5), sidebar: document.querySelectorAll('#secondary yt-lockup-view-model, #secondary ytd-compact-video-renderer').length };
});
await page.mouse.wheel(0, 1600);
await page.waitForTimeout(5000);
watch.comments = await page.evaluate(() => document.querySelectorAll('ytd-comment-thread-renderer').length);
await L.spaSearch('cooking pasta', 4000);
watch.searchResults = await page.evaluate(() => document.querySelectorAll('ytd-video-renderer').length);
record('youtube-basics', watch.playing && watch.sidebar > 0 && watch.comments > 0 && watch.searchResults > 0, watch);

// 5. Slow Jev: nothing is decided within 700 ms, so YouTube gets the original response ('kept' when the
//    content script answered "nothing yet" in time, 'timeout' when it didn't answer at all).
L.setJevDelay(1500);
const removedBefore = (await L.timings()).removed.length;
await L.spaSearch('senate vote', 7000);
t = await L.timings();
const last = t.cleanTimings.filter((x) => !x.continuation).at(-1);
const shownWhileSlow = await page.evaluate(() => document.querySelectorAll('ytd-video-renderer').length);
record('timeout-falls-back', ['timeout', 'kept'].includes(last?.outcome) && last.ms < 800 && shownWhileSlow > 0 && t.removed.length === removedBefore,
  { lastOutcome: last?.outcome, heldMs: last?.ms, videosRendered: shownWhileSlow, removedAdded: t.removed.length - removedBefore });
L.setJevDelay(0);

// 6. "Only show" with nothing that fits: loading stops after 3 empty continuations, with a way on.
await L.setRules(['고양이 영상만'], 'want');
await page.goto('https://www.youtube.com/@CNN/videos', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
const browseStart = L.feedRequests.browse;
for (let i = 0; i < 8; i++) {
  await page.mouse.wheel(0, 6000);
  await page.waitForTimeout(1500);
}
const capText = await L.noteText();
const atPause = L.feedRequests.browse;
await page.waitForTimeout(6000);
const whilePaused = L.feedRequests.browse - atPause;
// While paused, only Picky's note shows: YouTube's loading spinner is hidden.
const spinnerWhilePaused = await page.evaluate(() => [...document.querySelectorAll('ytd-continuation-item-renderer')]
  .some((el) => getComputedStyle(el).visibility !== 'hidden' && el.getClientRects().length));
await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(outDir, 'clean-end-note-light.png') });
await page.evaluate(() => document.querySelector('.picky-end-note')?.shadowRoot.querySelector('.more').click());
await page.waitForTimeout(6000);
const afterMore = L.feedRequests.browse - atPause;
const pausedAfterMore = await page.evaluate(() => document.documentElement.hasAttribute('data-picky-paused'));
record('want-mode-cap', Boolean(capText?.includes('Nothing that fits 고양이 영상만')) && atPause - browseStart <= 4 && whilePaused === 0 && afterMore >= 1,
  { note: capText, requestsBeforePause: atPause - browseStart, requestsWhilePaused: whilePaused, requestsAfterKeepLooking: afterMore });
record('paused-hides-spinner', !spinnerWhilePaused, { spinnerVisibleWhilePaused: spinnerWhilePaused, stillPausedRightAfterKeepLooking: pausedAfterMore });

// 7. Switching it off: the next responses pass through untouched and hiding works as before.
await L.setRules(['정치 얘기 싫어'], 'avoid');
await popup.goto(`chrome-extension://${L.extId}/popup.html?tab=${await L.tabId()}`);
await popup.waitForTimeout(500);
await popup.click('.clean-row');
await popup.waitForTimeout(300);
const offStored = await sw.evaluate(() => chrome.storage.local.get('cleanFeed').then((s) => s.cleanFeed));
const cleanCount = (await L.timings()).cleanTimings.length;
await page.goto('https://www.youtube.com/results?search_query=weather', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
await L.spaSearch('election results');
t = await L.timings();
const tombstones = await page.evaluate(() => document.querySelectorAll('.picky-hidden').length);
record('switch-off-restores', offStored === false && t.cleanTimings.length === 0 && tombstones > 0,
  { cleanFeed: offStored, cleanResponsesAfterOff: t.cleanTimings.length, hiddenOnPage: tombstones, cleanResponsesBeforeReload: cleanCount });

// Added delay: from YouTube's response arriving to the cleaned copy being handed over.
const all = (await L.timings()).cleanTimings; // after reload: only this page; use what the earlier pages logged
report.push({ check: 'note', detail: `clean timings on last page: ${all.length}` });
await L.context.close();
fs.rmSync(L.userDataDir, { recursive: true, force: true });

// ---------------- latency run + dark screenshots ----------------
const D = await open('dark');
await D.sw.evaluate(() => chrome.storage.local.set({ cleanFeed: true }));
await D.setRules(['정치 얘기 싫어'], 'avoid');
await D.page.goto('https://www.youtube.com/results?search_query=senate+election+news', { waitUntil: 'domcontentloaded' });
await D.page.waitForTimeout(6000);
await D.page.screenshot({ path: path.join(outDir, 'clean-first-page-dark.png') });
await D.page.goto('https://www.youtube.com/results?search_query=weather', { waitUntil: 'domcontentloaded' });
await D.page.waitForTimeout(3000);
for (const q of ['election news', 'congress hearing', 'world news today']) {
  await D.spaSearch(q, 3500);
  for (let i = 0; i < 2; i++) {
    await D.page.mouse.wheel(0, 5000);
    await D.page.waitForTimeout(1500);
  }
}
const dt = (await D.timings()).cleanTimings.filter((x) => x.outcome !== 'error');
const nav = dt.filter((x) => !x.continuation).map((x) => x.ms);
const cont = dt.filter((x) => x.continuation).map((x) => x.ms);
report.push({
  check: 'added-delay', navigation: { n: nav.length, p50: pct(nav, 0.5), p95: pct(nav, 0.95) },
  continuation: { n: cont.length, p50: pct(cont, 0.5), p95: pct(cont, 0.95) },
  outcomes: dt.reduce((o, x) => ({ ...o, [x.outcome]: (o[x.outcome] || 0) + 1 }), {}),
});
await D.page.evaluate(() => window.scrollTo(0, 0));
await D.page.evaluate(() => document.querySelector('.picky-clean-ui').shadowRoot.querySelector('.pill').click());
await D.page.waitForTimeout(400);
await D.page.screenshot({ path: path.join(outDir, 'clean-panel-dark.png') });
await D.setRules(['고양이 영상만'], 'want');
await D.page.goto('https://www.youtube.com/@CNN/videos', { waitUntil: 'domcontentloaded' });
await D.page.waitForTimeout(4000);
for (let i = 0; i < 8 && !(await D.noteText()); i++) {
  await D.page.mouse.wheel(0, 6000);
  await D.page.waitForTimeout(1500);
}
await D.page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
await D.page.waitForTimeout(500);
await D.page.screenshot({ path: path.join(outDir, 'clean-end-note-dark.png') });
const errors = [...L.errors, ...D.errors];
await D.context.close();
fs.rmSync(D.userDataDir, { recursive: true, force: true });

// Light panel screenshot on a fresh page (no end note in the way).
const P = await open('light');
await P.sw.evaluate(() => chrome.storage.local.set({ cleanFeed: true }));
await P.setRules(['정치 얘기 싫어'], 'avoid');
await P.page.goto('https://www.youtube.com/results?search_query=weather', { waitUntil: 'domcontentloaded' });
await P.page.waitForTimeout(3000);
await P.spaSearch('congress news');
await P.page.evaluate(() => document.querySelector('.picky-clean-ui')?.shadowRoot.querySelector('.pill').click());
await P.page.waitForTimeout(400);
await P.page.screenshot({ path: path.join(outDir, 'clean-panel-light.png') });
errors.push(...P.errors);
await P.context.close();
fs.rmSync(P.userDataDir, { recursive: true, force: true });

for (const r of report) console.log(JSON.stringify(r));
console.log(errors.length ? `EXTENSION ERRORS:\n${errors.join('\n')}` : 'extension console errors: none');
console.log(failed || errors.length ? 'CLEAN E2E FAIL' : 'CLEAN E2E PASS');
process.exit(failed || errors.length ? 1 : 0);
