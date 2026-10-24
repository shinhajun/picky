// Screenshots of the waiting skeletons and of the result, light and dark. Jev's answers are held back
// (under the 3 s pre-hide timeout) so the in-between state can be captured.
// Usage: node scripts/shots-skeleton.js     Screenshots go to .e2e/skeleton-*.png
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const extDir = path.join(root, 'extension');
const outDir = path.join(root, '.e2e');
const apiKey = fs.readFileSync(path.join(root, '.env'), 'utf8').match(/^TYPESAFE_API_KEY=(.*)$/m)?.[1].trim().replace(/^["']|["']$/g, '');
if (!apiKey) throw new Error('TYPESAFE_API_KEY missing in .env');
const fixture = fs.readFileSync(path.join(root, 'scripts', 'fixtures', 'instagram-home.html'), 'utf8');

const PAGES = [
  { name: 'yt-search', url: 'https://www.youtube.com/results?search_query=news+today', items: 'ytd-video-renderer' },
  { name: 'yt-grid', url: 'https://www.youtube.com/@CNN/videos', items: 'ytd-rich-item-renderer' },
  { name: 'yt-sidebar', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', items: 'yt-lockup-view-model' },
  { name: 'ig-fixture', url: 'https://www.instagram.com/', items: 'article' },
];

for (const theme of ['light', 'dark']) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picky-shots-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium', headless: true, locale: 'en-US', colorScheme: theme, viewport: { width: 1280, height: 860 },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  const errors = [];
  context.on('console', (m) => m.type() === 'error' && /chrome-extension:\/\//.test(m.location()?.url || '') && errors.push(m.text()));
  let release = () => {};
  let gate = Promise.resolve();
  await context.route('https://api.typesafe.ai/v1/systemone', async (route) => {
    const res = await route.fetch();
    await gate;
    await route.fulfill({ response: res });
  });
  await context.route((url) => url.hostname === 'www.instagram.com', (route) => route.fulfill({
    contentType: 'text/html',
    body: theme === 'dark' ? fixture.replace('</style>', 'body{background:#000;color:#f5f5f5}a{color:#e0f1ff}</style>') : fixture,
  }));
  const sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  for (const p of context.pages()) if (p.url().startsWith('chrome-extension://')) await p.close();
  await sw.evaluate((k) => chrome.storage.local.set({
    apiKey: k, enabled: true,
    rules: [{ id: 'a', text: '정치 얘기 싫어', polarity: 'avoid', polaritySource: 'user' }, { id: 'b', text: 'No crypto hype', polarity: 'avoid', polaritySource: 'user' }],
  }), apiKey);
  const page = await context.newPage();
  // Logged-out YouTube ignores the emulated colour scheme; its dark theme is the html[dark] attribute.
  if (theme === 'dark') {
    await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => {
      if (location.hostname.endsWith('youtube.com')) document.documentElement.setAttribute('dark', '');
    }));
  }

  for (const pg of PAGES) {
    gate = new Promise((r) => { release = r; });
    await page.goto(pg.url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((sel) => document.querySelectorAll(sel).length >= 3, pg.items, { timeout: 15000 });
    await page.waitForTimeout(600);
    const waiting = await page.evaluate((sel) => [...document.querySelectorAll(sel)].filter((el) => !el.hasAttribute('data-picky-ready')).length, pg.items);
    await page.screenshot({ path: path.join(outDir, `skeleton-${pg.name}-${theme}-waiting.png`) });
    release();
    await page.waitForTimeout(2500);
    const after = await page.evaluate((sel) => ({
      waiting: [...document.querySelectorAll(sel)].filter((el) => el.dataset.pickyKey && !el.hasAttribute('data-picky-ready')).length,
      hidden: document.querySelectorAll('.picky-hidden').length,
    }), pg.items);
    await page.screenshot({ path: path.join(outDir, `skeleton-${pg.name}-${theme}-after.png`) });
    console.log(`${theme} ${pg.name}: ${waiting} waiting with skeletons -> after: ${after.waiting} still waiting, ${after.hidden} hidden`);
  }
  if (errors.length) console.log('extension errors:', errors);
  await context.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
