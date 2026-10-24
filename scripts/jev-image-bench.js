// Live Jev check with pictures. Runs inside an extension page in Playwright's Chromium so it uses
// the extension's own image.js (fetch -> OffscreenCanvas -> JPEG) and jev.js.
// Usage: node scripts/jev-image-bench.js   (reads TYPESAFE_API_KEY from .env; never prints it)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const extDir = path.join(root, 'extension');
const apiKey = fs.readFileSync(path.join(root, '.env'), 'utf8').match(/^TYPESAFE_API_KEY=(.*)$/m)?.[1].trim().replace(/^["']|["']$/g, '');
if (!apiKey) throw new Error('TYPESAFE_API_KEY missing in .env');

const RULES = ['고양이 영상만', '정치 얘기 싫어', 'No crypto hype', 'No food videos'];
const YT = (id, file = 'hqdefault') => `https://i.ytimg.com/vi/${id}/${file}.jpg`;
const WM = 'https://upload.wikimedia.org/wikipedia/commons';
// Titles are deliberately unhelpful so the picture has to carry the decision.
const ITEMS = [
  { kind: 'youtube', title: 'you have to see this 😂', image: YT('JpjWBbNZqwQ'), expect: 'cat' },
  { kind: 'youtube', title: 'omg 😭😭', image: YT('hmQRBfUfs-Q'), expect: 'cat' },
  { kind: 'youtube', title: 'Me at the zoo', image: YT('jNQXAC9IVRw'), expect: '-' },
  { kind: 'youtube', title: 'Me at the zoo (120x90 thumbnail)', image: YT('jNQXAC9IVRw', 'default'), expect: '-' },
  { kind: 'youtube', title: 'classic', image: YT('dQw4w9WgXcQ'), expect: '-' },
  { kind: 'youtube', title: 'this one', image: YT('9bZkp7q19f0'), expect: '-' },
  { kind: 'photo', title: 'my afternoon', image: `${WM}/thumb/3/3a/Cat03.jpg/960px-Cat03.jpg`, expect: 'cat' },
  { kind: 'photo', title: 'my afternoon (full size)', image: `${WM}/3/3a/Cat03.jpg`, expect: 'cat' },
  { kind: 'photo', title: 'good boy', image: `${WM}/thumb/2/26/YellowLabradorLooking_new.jpg/960px-YellowLabradorLooking_new.jpg`, expect: '-' },
  { kind: 'photo', title: 'today in DC', image: `${WM}/thumb/a/a3/United_States_Capitol_west_front_edit2.jpg/960px-United_States_Capitol_west_front_edit2.jpg`, expect: 'politics?' },
  { kind: 'photo', title: 'dinner', image: `${WM}/thumb/a/a3/Eq_it-na_pizza-margherita_sep2005_sml.jpg/500px-Eq_it-na_pizza-margherita_sep2005_sml.jpg`, expect: 'food' },
  { kind: 'photo (png)', title: 'to the moon 🚀', image: `${WM}/thumb/4/46/Bitcoin.svg/500px-Bitcoin.svg.png`, expect: 'crypto' },
  { kind: 'photo (png alpha)', title: 'rolled a six', image: `${WM}/thumb/4/47/PNG_transparency_demonstration_1.png/500px-PNG_transparency_demonstration_1.png`, expect: '-' },
  { kind: 'photo (webp)', title: 'weekend', image: 'https://www.gstatic.com/webp/gallery/1.webp', expect: '-' },
  { kind: 'photo (webp)', title: 'weekend 2', image: 'https://www.gstatic.com/webp/gallery/4.webp', expect: '-' },
];
const ROUNDS = 2;

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picky-bench-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});
const sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
const extId = new URL(sw.url()).host;
const page = await context.newPage();
await page.goto(`chrome-extension://${extId}/options.html`);

const out = await page.evaluate(async ({ apiKey, ITEMS, RULES, ROUNDS }) => {
  const { imageAsset, fit } = await import(chrome.runtime.getURL('image.js'));
  const { callJev, ruleQuestion } = await import(chrome.runtime.getURL('jev.js'));
  const questions = Object.fromEntries(RULES.map((r, i) => [`r${i}`, ruleQuestion(r)]));
  const fits = [[120, 90], [480, 360], [4000, 3000], [6000, 500], [300, 2400]].map(([w, h]) => {
    const f = fit(w, h);
    return `${w}x${h} -> ${f.width}x${f.height}${f.sw !== w || f.sh !== h ? ` (crop ${f.sw}x${f.sh})` : ''}`;
  });

  async function one(item) {
    const r = { title: item.title, kind: item.kind, expect: item.expect };
    let t = performance.now();
    const state = { feed_item: { platform: item.kind.startsWith('youtube') ? 'YouTube' : 'Instagram', title: item.title } };
    try {
      const textRes = await callJev(apiKey, { state, questions });
      r.textMs = performance.now() - t;
      r.text = RULES.map((_, i) => textRes.answers[`r${i}`].noul);
    } catch (e) {
      r.textError = e.message;
    }
    t = performance.now();
    try {
      const { ref, asset, width, height } = await imageAsset(item.image);
      r.prepMs = performance.now() - t;
      r.size = `${width}x${height}`;
      r.kb = Math.round((asset.data_base64.length * 3) / 4 / 1024);
      const t2 = performance.now();
      const res = await callJev(apiKey, { state: { feed_item: { ...state.feed_item, picture: ref } }, questions, assets: { [ref]: asset } }, { retries: 2 });
      r.apiMs = performance.now() - t2;
      r.totalMs = performance.now() - t;
      r.pic = RULES.map((_, i) => res.answers[`r${i}`].noul);
      r.tokens = res.usage.input_tokens;
      r.ok = true;
    } catch (e) {
      r.ok = false;
      r.error = `${e.status ?? ''} ${e.message}`.slice(0, 200);
    }
    return r;
  }

  const results = [];
  for (let round = 0; round < ROUNDS; round++) {
    const queue = [...ITEMS];
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (queue.length) results.push({ round, ...(await one(queue.shift())) });
    }));
  }
  return { fits, results };
}, { apiKey, ITEMS, RULES, ROUNDS });

await context.close();
fs.rmSync(userDataDir, { recursive: true, force: true });

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]) : NaN;
};
const f2 = (xs) => (xs ? xs.map((x) => x.toFixed(2).padStart(5)).join('') : '  (failed)');

console.log('fit():', out.fits.join(' | '));
console.log(`\nrules: ${RULES.map((r, i) => `r${i}=${r}`).join('  ')}`);
console.log(`${'item'.padEnd(36)}${'size'.padEnd(10)}text r0..r3          picture r0..r3`);
for (const r of out.results.filter((x) => x.round === 0)) {
  console.log(`${`${r.title} [${r.kind}]`.slice(0, 34).padEnd(36)}${(r.size || '-').padEnd(10)}${f2(r.text)}   ${r.ok ? f2(r.pic) : `FAIL ${r.error}`}`);
}
const ok = out.results.filter((r) => r.ok);
console.log(`\nimage requests: ${ok.length}/${out.results.length} succeeded (${ROUNDS} rounds x ${ITEMS.length} images, 4 at a time)`);
for (const r of out.results.filter((x) => !x.ok)) console.log(`  failed: ${r.title}: ${r.error}`);
console.log(`Jev call with picture:   p50 ${pct(ok.map((r) => r.apiMs), 50)}ms  p95 ${pct(ok.map((r) => r.apiMs), 95)}ms`);
console.log(`fetch + JPEG prep:       p50 ${pct(ok.map((r) => r.prepMs), 50)}ms  p95 ${pct(ok.map((r) => r.prepMs), 95)}ms`);
console.log(`picture path end to end: p50 ${pct(ok.map((r) => r.totalMs), 50)}ms  p95 ${pct(ok.map((r) => r.totalMs), 95)}ms`);
console.log(`same items, text only:   p50 ${pct(out.results.filter((r) => r.textMs).map((r) => r.textMs), 50)}ms  p95 ${pct(out.results.filter((r) => r.textMs).map((r) => r.textMs), 95)}ms`);
console.log(`input tokens per picture request: p50 ${pct(ok.map((r) => r.tokens), 50)} (~$${((pct(ok.map((r) => r.tokens), 50) * 0.042) / 1e6).toFixed(6)} each); JPEG p50 ${pct(ok.map((r) => r.kb), 50)} KB`);
