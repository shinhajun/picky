// Measures how early YouTube items get judged, with feed-data prejudging + pre-hide on vs off
// (storage `prejudge: false`), each in a fresh browser so the answer cache starts empty.
// Per scenario: items decided before their node appeared, ms from node appearing to decided, items that
// entered the viewport undecided, and animation frames in which an undecided original was visible.
// Usage: node scripts/measure-prejudge.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const extDir = path.join(root, 'extension');
const apiKey = fs.readFileSync(path.join(root, '.env'), 'utf8').match(/^TYPESAFE_API_KEY=(.*)$/m)?.[1].trim().replace(/^["']|["']$/g, '');
if (!apiKey) throw new Error('TYPESAFE_API_KEY missing in .env');
const RULES = ['정치 얘기 싫어', 'No crypto hype'];

// Runs in the page's world from document start: every frame, look at feed items inside the viewport.
// An item counts as decided only once content.js marked it data-picky-ready="" for its current video.
function frameChecker() {
  const SEL = 'ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, ytd-reel-item-renderer, yt-lockup-view-model, ytm-shorts-lockup-view-model-v2, ytm-shorts-lockup-view-model';
  const st = { frames: 0, leakFrames: 0, leakItems: 0, entered: 0, enteredUndecided: 0 };
  const entered = new WeakMap();
  const leaked = new WeakMap();
  const idOf = (el) => {
    for (const a of el.querySelectorAll('a[href]')) {
      const m = a.getAttribute('href').match(/[?&]v=([\w-]{11})|\/shorts\/([\w-]{11})/);
      if (m) return m[1] || m[2];
    }
    return null;
  };
  const originalVisible = (el) => [...el.children].some((c) => {
    if (c.classList.contains('picky-label')) return false;
    const cs = getComputedStyle(c);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && c.getBoundingClientRect().height > 0;
  });
  function tick() {
    try {
      st.frames++;
      let leak = false;
      for (const el of document.querySelectorAll(SEL)) {
        if (el.parentElement?.closest(SEL)) continue;
        const r = el.getBoundingClientRect();
        if (r.height === 0 || r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) continue;
        const id = idOf(el);
        if (!id) continue; // ads and the like: Picky has nothing to judge
        const decided = (el.dataset.pickyKey || '').endsWith(':' + id) && el.getAttribute('data-picky-ready') === '';
        if (entered.get(el) !== id) {
          entered.set(el, id);
          st.entered++;
          if (!decided) st.enteredUndecided++;
        }
        if (decided || el.classList.contains('picky-pending') || !originalVisible(el)) continue;
        leak = true;
        if (leaked.get(el) !== id) {
          leaked.set(el, id);
          st.leakItems++;
        }
      }
      if (leak) st.leakFrames++;
    } catch {}
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  window.__pickyFrames = st;
}

const SCENARIOS = [
  { name: 'search (first load)', run: (p) => go(p, 'https://www.youtube.com/results?search_query=news+today') },
  { name: 'search infinite scroll', run: async (p) => { for (let i = 0; i < 5; i++) { await p.mouse.wheel(0, 2500); await p.waitForTimeout(1200); } } },
  { name: 'SPA search navigation', run: async (p) => { await p.fill('input[name="search_query"]', 'one piece anime'); await p.keyboard.press('Enter'); await p.waitForTimeout(5000); } },
  { name: 'channel grid + scroll', run: async (p) => { await go(p, 'https://www.youtube.com/@CNN/videos'); for (let i = 0; i < 3; i++) { await p.mouse.wheel(0, 2500); await p.waitForTimeout(1200); } } },
  { name: 'watch sidebar', run: (p) => go(p, 'https://www.youtube.com/watch?v=jNQXAC9IVRw') },
];
async function go(p, url) {
  await p.goto(url, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(6000);
}

async function measure(prejudge) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picky-measure-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium', headless: true, locale: 'en-US', viewport: { width: 1400, height: 1000 },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  const errors = [];
  context.on('console', (m) => m.type() === 'error' && /chrome-extension:\/\//.test(m.location()?.url || '') && errors.push(m.text()));
  const sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  for (const p of context.pages()) if (p.url().startsWith('chrome-extension://')) await p.close();
  await sw.evaluate(({ k, rules, prejudge }) => chrome.storage.local.set({
    apiKey: k, enabled: true, prejudge, rules: rules.map((text, i) => ({ id: `r${i}`, text, polarity: 'avoid', polaritySource: 'user' })),
  }), { k: apiKey, rules: RULES, prejudge });
  const page = await context.newPage();
  await page.addInitScript(frameChecker);

  const rows = [];
  let before = { timings: [], frames: { frames: 0, leakFrames: 0, leakItems: 0, entered: 0, enteredUndecided: 0 } };
  for (const sc of SCENARIOS) {
    const urlBefore = page.url();
    await sc.run(page);
    await page.bringToFront();
    const [tab] = await sw.evaluate(() => chrome.tabs.query({ active: true }));
    const t = await sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'getTimings' }), tab.id);
    const frames = await page.evaluate(() => ({ ...window.__pickyFrames }));
    // Full page loads start fresh counters; same-page steps (scroll, SPA) report the difference.
    const samePage = sc.name.includes('scroll') && !sc.name.includes('channel') || sc.name.startsWith('SPA');
    const base = samePage && urlBefore !== 'about:blank' ? before : { timings: [], frames: { frames: 0, leakFrames: 0, leakItems: 0, entered: 0, enteredUndecided: 0 } };
    const items = t.timings.slice(base.timings.length);
    const waits = items.map((x) => x.wait).sort((a, b) => a - b);
    const q = (p) => (waits.length ? Math.round(waits[Math.min(waits.length - 1, Math.floor(p * waits.length))]) : null);
    const f = Object.fromEntries(Object.keys(frames).map((k) => [k, frames[k] - base.frames[k]]));
    rows.push({
      scenario: sc.name, decided: items.length,
      decidedBeforeNode: items.length ? `${Math.round((100 * items.filter((x) => x.pre).length) / items.length)}%` : '-',
      waitP50: q(0.5), waitP95: q(0.95),
      enteredViewport: f.entered, enteredUndecided: f.enteredUndecided,
      originalVisibleFrames: `${f.leakFrames}/${f.frames}`, originalVisibleItems: f.leakItems, late: t.late,
    });
    before = { timings: t.timings, frames };
  }
  await context.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
  return { rows, errors };
}

for (const prejudge of [false, true]) {
  const { rows, errors } = await measure(prejudge);
  console.log(`\n== prejudge ${prejudge ? 'ON (feed data + pre-hide)' : 'OFF (DOM only)'} ==`);
  console.table(rows);
  if (errors.length) console.log('extension errors:', errors.slice(0, 5));
}
