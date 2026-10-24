// Loads the unpacked extension in Playwright's Chromium (headless) and checks, against the live Jev API:
// first-run key entry in the popup, YouTube (regression), per-site opt-in on other sites, the picture path,
// Instagram (live profile grid + saved home-feed and reels fixtures), usage/cost counters, the popup,
// Feed Facts and the options page.
// Usage: node scripts/e2e.js     Screenshots go to .e2e/
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

const YOUTUBE = [
  { name: 'yt-home', url: 'https://www.youtube.com/', rules: ['정치 얘기 싫어', 'No crypto hype'], optional: true },
  { name: 'yt-search-news', url: 'https://www.youtube.com/results?search_query=news+today', rules: ['정치 얘기 싫어', 'No crypto hype'] },
  { name: 'yt-channel-grid', url: 'https://www.youtube.com/@CNN/videos', rules: ['정치 얘기 싫어', 'No crypto hype'] },
  { name: 'yt-search-cats-only', url: 'https://www.youtube.com/results?search_query=funny+animals', rules: ['고양이 영상만'] },
  { name: 'yt-watch-sidebar', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', rules: ['고양이 영상만'] },
];

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picky-e2e-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: true,
  locale: 'en-US',
  viewport: { width: 1400, height: 1000 },
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});

const extErrors = [];
const isOurs = (msg) => /chrome-extension:\/\//.test(msg.location()?.url || '') || /picky/i.test(msg.text());
context.on('console', (msg) => {
  if (msg.type() === 'error' && isOurs(msg)) extErrors.push(`[console] ${msg.text()} @ ${msg.location()?.url}`);
});
context.on('weberror', (err) => {
  if (/chrome-extension:\/\//.test(err.error().stack || '')) extErrors.push(`[uncaught] ${err.error().message}`);
});

const sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
const extId = new URL(sw.url()).host;
sw.on('console', (msg) => msg.type() === 'error' && extErrors.push(`[sw] ${msg.text()}`));
await sw.evaluate(() => {
  self.__pickyErrors = [];
  self.addEventListener('error', (e) => self.__pickyErrors.push(String(e.message)));
  self.addEventListener('unhandledrejection', (e) => self.__pickyErrors.push(String(e.reason)));
});
for (const p of context.pages()) if (p.url().includes(extId)) await p.close(); // options tab opened on install
await sw.evaluate(() => chrome.storage.local.set({ enabled: true })); // no API key yet: the popup asks for it

// Independent tally of what Jev billed: every Jev call (service worker and pages) goes through this
// proxy, which reads the response's usage. (Response events can miss bodies; the proxy can't.)
const net = { calls: 0, tokens: 0 };
const otherStatuses = {}; // non-200 Jev responses, e.g. 429 rate limits the client retried
await context.route('https://api.typesafe.ai/v1/systemone', async (route) => {
  const res = await route.fetch();
  const body = await res.text();
  if (res.status() === 200) {
    net.calls++;
    net.tokens += JSON.parse(body).usage?.input_tokens || 0;
  } else {
    otherStatuses[res.status()] = (otherStatuses[res.status()] || 0) + 1;
  }
  await route.fulfill({ response: res, body });
});
const usageNow = () => sw.evaluate(() => chrome.storage.session.get('usage').then((s) => s.usage || { calls: 0, tokens: 0, saved: 0 }));
// Wait until no Jev response has arrived for a while and the counters have been written.
async function quiet() {
  let last = -1;
  for (let i = 0; i < 40 && last !== net.calls; i++) {
    last = net.calls;
    await new Promise((r) => setTimeout(r, 1200));
  }
  return usageNow();
}

const swStatus = () => sw.evaluate(() => chrome.storage.session.get('status').then((s) => s.status || {}));
const setSites = (sites) => sw.evaluate((sites) => chrome.storage.local.set({ sites }), sites);
async function setRules(texts) {
  const rules = texts.map((text, i) => ({ id: `r${i}-${Date.now()}`, text, polarity: null }));
  await sw.evaluate((rules) => chrome.storage.local.set({ rules }), rules);
  for (let i = 0; i < 150; i++) {
    const now = await sw.evaluate(() => chrome.storage.local.get('rules').then((s) => s.rules));
    if (now.every((r) => r.polarity)) return now;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('rule polarity was not classified');
}

// Read item states from the page (main world sees our classes, data attributes and open shadow roots).
const readState = (youtube) => {
  const items = [...document.querySelectorAll('[data-picky-key]')].filter((el) => el.dataset.pickyKey);
  const label = (el) => [...el.children].find((c) => c.classList.contains('picky-label'))?.shadowRoot?.querySelector('.card')?.textContent.replace(/\s+/g, ' ').trim();
  const ytKey = (el) => {
    for (const a of el.querySelectorAll('a[href]')) {
      const h = a.getAttribute('href');
      const m = h.match(/[?&]v=([\w-]{6,})/) || h.match(/\/shorts\/([\w-]{6,})/) || h.match(/[?&]list=([\w-]+)/);
      if (m) return m[1];
    }
    return null;
  };
  return {
    keyed: items.length,
    pending: document.querySelectorAll('.picky-pending').length,
    hidden: document.querySelectorAll('.picky-hidden').length,
    blurred: document.querySelectorAll('.picky-blurred').length,
    revealed: document.querySelectorAll('.picky-revealed').length,
    staleKeys: youtube ? items.filter((el) => !el.dataset.pickyKey.endsWith(':' + ytKey(el))).length : 0,
    // A hidden item's label must stay inside the item's own box (grids must not overflow).
    overflow: [...document.querySelectorAll('.picky-hidden')].filter((el) => {
      const card = [...el.children].find((c) => c.classList.contains('picky-label'))?.shadowRoot?.querySelector('.card');
      return card && card.getBoundingClientRect().width > el.getBoundingClientRect().width + 1;
    }).length,
    keys: items.map((el) => el.dataset.pickyKey),
    prehide: document.documentElement.hasAttribute('data-picky-prehide'),
    labels: [...document.querySelectorAll('.picky-hidden, .picky-blurred')].slice(0, 3).map(label),
  };
};

async function settle(page, youtube = false, minRounds = 4) {
  let s;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(500);
    s = await page.evaluate(readState, youtube);
    if (s.keyed > 0 && s.pending === 0 && i >= minRounds) break;
  }
  return s;
}

async function tryReveal(page, youtube) {
  const label = page.locator('.picky-hidden .picky-label').first();
  if (!(await label.count())) return null;
  await label.evaluate((host) => host.shadowRoot.querySelector('button').click());
  await page.waitForTimeout(200);
  return (await page.evaluate(readState, youtube)).revealed > 0;
}

const report = [];
let failed = false;
function record(name, ok, details, { optional = false } = {}) {
  if (!ok && !optional) failed = true;
  const { keys, labels, ...rest } = details;
  report.push({ check: name, ok, ...rest });
}

const page = await context.newPage();
const tabIdOf = async (p) => {
  await p.bringToFront();
  const [tab] = await sw.evaluate(() => chrome.tabs.query({ active: true }));
  return tab.id;
};

// ---- 0. First run: no key, so the popup shows the inline form; saving it starts judging ----
await setRules(['정치 얘기 싫어', 'No crypto hype']);
await page.goto('https://www.youtube.com/results?search_query=news+today', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
const noKey = await page.evaluate(readState, true);
const firstTab = await tabIdOf(page);
const popup = await context.newPage();
await popup.setViewportSize({ width: 360, height: 620 });
await popup.goto(`chrome-extension://${extId}/popup.html?tab=${firstTab}`);
await popup.waitForTimeout(600);
const formShown = await popup.isVisible('#keyForm');
await popup.screenshot({ path: path.join(outDir, 'popup-no-key.png'), fullPage: true });
await popup.fill('#keyInput', apiKey);
await popup.click('#keySave');
await popup.waitForFunction(() => document.getElementById('keyBanner').hidden, null, { timeout: 15000 });
const keySaved = await sw.evaluate(() => chrome.storage.local.get('apiKey').then((s) => Boolean(s.apiKey)));
await page.bringToFront();
const withKey = await settle(page, true);
record('popup-key-entry', formShown && noKey.hidden + noKey.blurred === 0 && keySaved && withKey.hidden + withKey.blurred > 0,
  { formShown, judgedBeforeKey: noKey.hidden + noKey.blurred, keySaved, judgedAfterKey: withKey.hidden + withKey.blurred });
// Pre-hide (items invisible until judged) must never apply without a key.
record('prehide-needs-key', !noKey.prehide && withKey.prehide, { prehideWithoutKey: noKey.prehide, prehideWithKey: withKey.prehide });

// ---- 1. YouTube regression (on by default) ----
for (const sc of YOUTUBE) {
  await setRules(sc.rules);
  await page.goto(sc.url, { waitUntil: 'domcontentloaded' });
  await settle(page, true);
  await page.mouse.wheel(0, 2500);
  const s = await settle(page, true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(outDir, `${sc.name}.png`) });
  const revealOk = await tryReveal(page, true);
  record(sc.name, s.keyed > 0 && s.pending === 0 && s.staleKeys === 0 && s.overflow === 0 && s.hidden + s.blurred > 0 && revealOk !== false,
    { ...s, revealOk }, { optional: sc.optional });
}
// SPA navigation reuses item nodes: every keyed item must still match its own video.
await setRules(['정치 얘기 싫어', 'No crypto hype']);
await page.goto('https://www.youtube.com/results?search_query=news+today', { waitUntil: 'domcontentloaded' });
await settle(page, true);
await page.fill('input[name="search_query"]', 'one piece anime');
await page.keyboard.press('Enter');
await page.waitForURL(/one\+piece/);
const spa = await settle(page, true);
record('yt-spa-recycle', spa.staleKeys === 0 && spa.pending === 0 && spa.keyed > 0, spa);

// ---- 1b. Usage counters match what Jev billed ----
const ytUsage = await quiet();
record('usage-matches-jev', ytUsage.tokens > 0 && ytUsage.tokens === net.tokens && ytUsage.calls === net.calls,
  { counted: { calls: ytUsage.calls, tokens: ytUsage.tokens, saved: ytUsage.saved }, billedByJev: { ...net } });

// ---- 2. Picture path: unsure YouTube items should have been re-asked with their thumbnail ----
const afterYt = await swStatus();
record('image-path-youtube', (afterYt.images?.ok || 0) > 0, { images: afterYt.images });

// ---- 2b. Turning YouTube off removes pre-hide and judging ----
await setSites({ 'youtube.com': false });
await page.goto('https://www.youtube.com/results?search_query=news+today', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3500);
const ytOff = await page.evaluate(readState, true);
record('site-off-no-prehide', !ytOff.prehide && ytOff.keyed === 0, { prehide: ytOff.prehide, keyed: ytOff.keyed });

// ---- 3. Per-site opt-in on a generic site ----
await setRules(['No posts about C, C++ or Rust']);
await setSites({});
await page.goto('https://lobste.rs/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
const before = await page.evaluate(readState, false);
const lobstersTab = await tabIdOf(page);
await popup.goto(`chrome-extension://${extId}/popup.html?tab=${lobstersTab}`);
await popup.waitForTimeout(600);
await popup.screenshot({ path: path.join(outDir, 'popup-unpicked.png'), fullPage: true });
const pickVisible = await popup.isVisible('#pick');
await popup.click('#pick');
await popup.waitForTimeout(300);
const sitesNow = await sw.evaluate(() => chrome.storage.local.get('sites').then((s) => s.sites));
await page.bringToFront();
const after = await settle(page);
await page.screenshot({ path: path.join(outDir, 'generic-lobsters.png') });
await popup.reload();
await popup.waitForTimeout(600);
await popup.screenshot({ path: path.join(outDir, 'popup-picked.png'), fullPage: true });
record('opt-in-toggle', before.keyed === 0 && pickVisible && sitesNow?.['lobste.rs'] === true && after.keyed > 0 && after.pending === 0 && !after.prehide,
  { keyedBeforePick: before.keyed, keyedAfterPick: after.keyed, hidden: after.hidden, blurred: after.blurred, sites: sitesNow, prehide: after.prehide });

await setRules(['No AI or LLM posts']);
await setSites({ 'lobste.rs': true, 'dev.to': true });
await page.goto('https://dev.to/', { waitUntil: 'domcontentloaded' });
await settle(page);
await page.mouse.wheel(0, 2500);
const devto = await settle(page);
await page.screenshot({ path: path.join(outDir, 'generic-devto.png') });
record('generic-devto', devto.keyed > 0 && devto.pending === 0, { ...devto, revealOk: await tryReveal(page, false) });

// ---- 4. Instagram ----
// Adapter output read in the main world (a second copy of adapters.js; the content script runs separately).
// Passed as a string so it runs over CDP, which Instagram's CSP doesn't block.
const adaptersSrc = fs.readFileSync(path.join(extDir, 'adapters.js'), 'utf8');
const adapterDump = (p) => p.evaluate(`(() => { ${adaptersSrc}
  const ig = globalThis.PickyAdapters.instagram;
  return ig.findItems().map((el) => ({ key: ig.key(el), shape: ig.shape(el), state: ig.extract(el)?.feed_item, image: ig.image(el)?.slice(0, 90) }));
})()`);

// 4a. Live, logged out: a profile grid is the only feed Instagram shows without an account.
await setRules(['No wild animals', '정치 얘기 싫어']);
await page.goto('https://www.instagram.com/natgeo/', { waitUntil: 'domcontentloaded' });
const igLive = await settle(page, false, 6);
await page.screenshot({ path: path.join(outDir, 'instagram-profile-grid.png') });
const igLiveDump = await adapterDump(page);
// The profile's posts are embedded in the first HTML: prefetch.js should have sent them for judging early.
const igTimings = await sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'getTimings' }), await tabIdOf(page));
record('instagram-prefetch', igTimings.prefetched > 0 && igTimings.prehide, {
  prefetched: igTimings.prefetched, decided: igTimings.timings.length,
  decidedBeforeNode: igTimings.timings.filter((x) => x.pre).length, late: igTimings.late,
});
record('instagram-live-grid', igLive.keyed > 0 && igLive.pending === 0 && igLive.overflow === 0 && igLive.keys.every((k) => /^ig:[\w-]+$/.test(k)),
  { ...igLive, sample: igLiveDump.slice(0, 2) });

// 4b. Saved fixtures served at instagram.com URLs (home feed and reels need a login).
const fixture = (file) => fs.readFileSync(path.join(root, 'scripts', 'fixtures', file), 'utf8');
await page.route((url) => url.hostname === 'www.instagram.com', (route) => route.fulfill({
  contentType: 'text/html',
  body: fixture(new URL(route.request().url()).pathname.startsWith('/reels') ? 'instagram-reels.html' : 'instagram-home.html'),
}));
// "cats only", not "고양이 영상만": Jev reads "videos" literally and a cat photo isn't one.
await setRules(['cats only', 'No crypto hype']);
await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' });
const igHome = await settle(page, false, 6);
await page.screenshot({ path: path.join(outDir, 'instagram-home-fixture.png'), fullPage: true });
const igHomeDump = await adapterDump(page);
const expectedHome = ['ig:C9xCatPic01', 'ig:C9xPolit002', 'ig:C9xPizza003', 'ig:C9xCrypt004', 'ig:C9xDogPic05', 'ig:C9xCatReel6'];
const shown = await page.evaluate(() => [...document.querySelectorAll('[data-picky-key]')]
  .filter((el) => !el.matches('.picky-hidden, .picky-blurred')).map((el) => el.dataset.pickyKey));
record('instagram-home-fixture',
  igHome.pending === 0 && expectedHome.every((k) => igHome.keys.includes(k)) && igHome.keyed === expectedHome.length
    && shown.includes('ig:C9xCatPic01') && igHome.hidden >= 3
    && !igHomeDump.some((d) => /liked by/i.test(d.state?.caption || '')),
  { ...igHome, shownKeys: shown, extracted: igHomeDump.map((d) => ({ key: d.key, caption: d.state?.caption, user: d.state?.username, tags: d.state?.hashtags, image: d.image?.replace(/^.*\//, '…/') })) });

// Revisit: a new page load asks again, but every answer comes from the service worker's cache.
const beforeRevisit = await quiet();
await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' });
const revisit = await settle(page, false, 6);
const afterRevisit = await quiet();
record('cache-revisit-free', revisit.keyed === 6 && afterRevisit.tokens === beforeRevisit.tokens && afterRevisit.saved - beforeRevisit.saved >= 6,
  { tokensBefore: beforeRevisit.tokens, tokensAfter: afterRevisit.tokens, savedAdded: afterRevisit.saved - beforeRevisit.saved });

await page.goto('https://www.instagram.com/reels/C9xReelCat1/', { waitUntil: 'domcontentloaded' });
const igReels = await settle(page, false, 6);
await page.screenshot({ path: path.join(outDir, 'instagram-reels-fixture.png'), fullPage: true });
const igReelsDump = await adapterDump(page);
record('instagram-reels-fixture', igReels.keyed === 3 && igReels.pending === 0 && igReels.keys.includes('ig:C9xReelBtc3'),
  { ...igReels, extracted: igReelsDump.map((d) => ({ key: d.key?.slice(0, 40), caption: d.state?.caption, image: d.image?.replace(/^.*\//, '…/') })) });
await page.unroute((url) => url.hostname === 'www.instagram.com');

const finalStatus = await swStatus();
record('image-path-total', (finalStatus.images?.ok || 0) > 0, { images: finalStatus.images, jevP50: finalStatus.p50 });

// ---- 5. Feed Facts for this tab, then for the session ----
await setRules(['정치 얘기 싫어', 'No crypto hype', '고양이 영상만']);
await page.goto('https://www.youtube.com/results?search_query=cat+news', { waitUntil: 'domcontentloaded' });
await settle(page, true);
const mainTab = await tabIdOf(page);
const facts = await context.newPage();
await facts.setViewportSize({ width: 1000, height: 1250 });
await facts.goto(`chrome-extension://${extId}/facts.html?tab=${mainTab}`);
await facts.waitForTimeout(900);
await facts.screenshot({ path: path.join(outDir, 'feed-facts-tab.png'), fullPage: true });
const factsTab = await facts.evaluate(() => ({ cost: document.getElementById('cost').textContent, costNote: document.getElementById('costNote').textContent, rows: [...document.querySelectorAll('#rows .row, #sites .row')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()) }));
await facts.click('#scopeSession');
await facts.waitForTimeout(400);
await facts.screenshot({ path: path.join(outDir, 'feed-facts-session.png'), fullPage: true });
await facts.emulateMedia({ colorScheme: 'dark' });
await facts.waitForTimeout(200);
await facts.screenshot({ path: path.join(outDir, 'feed-facts-dark.png'), fullPage: true });
record('feed-facts', /^\$0\.\d{4}$/.test(factsTab.cost) && /per decision/.test(factsTab.costNote) && factsTab.rows.length > 3,
  { cost: factsTab.cost, costNote: factsTab.costNote, rows: factsTab.rows.slice(0, 6) });

await popup.goto(`chrome-extension://${extId}/popup.html?tab=${mainTab}`);
await popup.waitForTimeout(700);
await popup.screenshot({ path: path.join(outDir, 'popup.png'), fullPage: true });

const popupCost = await popup.textContent('#cost');
const options = await context.newPage();
await options.goto(`chrome-extension://${extId}/options.html`);
await options.waitForTimeout(500);
await options.screenshot({ path: path.join(outDir, 'options.png'), fullPage: true });
const finalUsage = await quiet();
const optionsCost = await options.textContent('#uCost');
record('cost-shown', /this session$/.test(popupCost) && optionsCost.startsWith('$') && finalUsage.tokens === net.tokens,
  { popup: popupCost, options: optionsCost, counted: finalUsage.tokens, billedByJev: net.tokens });
report.push({ check: 'run-total', jevCalls: net.calls, inputTokens: net.tokens, usd: +costOf(net.tokens).toFixed(5), nonOkResponses: otherStatuses });

const swErrors = await sw.evaluate(() => self.__pickyErrors);
await context.close();
fs.rmSync(userDataDir, { recursive: true, force: true });

for (const r of report) console.log(JSON.stringify(r));
const errors = [...extErrors, ...swErrors.map((e) => `[sw] ${e}`)];
console.log(errors.length ? `EXTENSION ERRORS:\n${errors.join('\n')}` : 'extension console errors: none');
console.log(failed || errors.length ? 'E2E FAIL' : 'E2E PASS');
process.exit(failed || errors.length ? 1 : 0);
