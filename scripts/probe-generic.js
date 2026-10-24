// What the generic adapter finds on real pages, without Jev: item count, ad slots, a sample of what each
// would send, and a screenshot with items outlined yellow and ads red. No extension, no API key.
// Usage: node scripts/probe-generic.js [url ...]     Screenshots go to .e2e/probe-*.png
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, '.e2e');
fs.mkdirSync(outDir, { recursive: true });
const adaptersSrc = ['adapters.js', 'ads.js'].map((f) => fs.readFileSync(path.join(root, 'extension', f), 'utf8')).join('\n');

const URLS = process.argv.slice(2).length ? process.argv.slice(2) : [
  'https://news.ycombinator.com/',
  'https://www.theguardian.com/international',
  'https://www.allrecipes.com/recipes/17562/dinner/',
  'https://stackoverflow.com/questions',
  'https://www.ebay.com/sch/i.html?_nkw=headphones',
];

const browser = await chromium.launch({ channel: 'chromium', headless: true });
const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1400, height: 1000 } });
const page = await context.newPage();
for (const url of URLS) {
  const name = new URL(url).hostname.replace(/^www\./, '');
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);
    await page.mouse.wheel(0, 3000);
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);
    const out = await page.evaluate(`(() => { ${adaptersSrc}
      const g = globalThis.PickyAdapters.generic;
      const all = g.findItems();
      const ads = globalThis.PickyAds.findSlots();
      const fresh = (el) => !ads.some((a) => a.contains(el) || el.contains(a));
      const items = all.filter(fresh);
      for (const el of items) el.style.outline = '3px solid #FFD43B';
      for (const el of ads) el.style.outline = '3px solid #E5484D';
      const area = innerWidth * document.documentElement.scrollHeight;
      return {
        items: items.length,
        ads: ads.length,
        biggest: Math.round(Math.max(0, ...items.map((el) => { const r = el.getBoundingClientRect(); return r.width * r.height; })) / area * 100) + '% of page',
        inChrome: items.filter((el) => el.closest('nav, header, footer, aside')).length,
        big: items.filter((el) => { const r = el.getBoundingClientRect(); return r.height > innerHeight * 1.5; }).map((el) => ({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 50), h: Math.round(el.getBoundingClientRect().height), text: el.textContent.trim().length })),
        sample: items.slice(0, 6).map((el) => ({ tag: el.tagName.toLowerCase(), key: g.key(el)?.slice(0, 80), text: g.extract(el)?.feed_item?.text?.slice(0, 90) })),
        adSample: ads.slice(0, 6).map((el) => ({ tag: el.tagName.toLowerCase(), id: el.id.slice(0, 40), cls: String(el.className).slice(0, 40), size: Math.round(el.getBoundingClientRect().width) + 'x' + Math.round(el.getBoundingClientRect().height), state: globalThis.PickyAds.slotState(el).feed_item })),
      };
    })()`);
    await page.screenshot({ path: path.join(outDir, `probe-${name}.png`) });
    console.log(JSON.stringify({ name, ...out }));
  } catch (err) {
    console.log(JSON.stringify({ name, error: err.message.split('\n')[0] }));
  }
}
await browser.close();
