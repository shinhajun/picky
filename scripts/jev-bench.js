// Live Jev check: rule polarity + 20 sample YouTube items x rules, with latency p50/p95.
// Usage: node scripts/jev-bench.js   (reads TYPESAFE_API_KEY from .env; never prints it)
import fs from 'node:fs';
import { callJev, polarityQuestion, ruleQuestion } from '../extension/jev.js';

const env = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
const apiKey = env.match(/^TYPESAFE_API_KEY=(.*)$/m)?.[1].trim().replace(/^["']|["']$/g, '');
if (!apiKey) throw new Error('TYPESAFE_API_KEY missing in .env');

const RULES = ['고양이 영상만', '정치 얘기 싫어', '원피스 스포일러 빼줘', 'No crypto hype'];

const ITEMS = [
  ['My cat learned to open the fridge 😹', 'Mochi the Cat'],
  ['Kitten rescue: tiny stray finds a forever home', 'The Dodo'],
  ['24 hours with 10 cats in Tokyo cat cafe', 'Abroad in Japan'],
  ['Cute golden retriever puppy compilation', 'Doggo Daily'],
  ['Senate passes immigration bill after late-night vote', 'CNN'],
  ['Presidential debate 2026: full highlights', 'NBC News'],
  ['윤석열 탄핵 심판 결과 총정리', 'KBS News'],
  ['Why housing prices keep going up (economics explained)', 'Economics Explained'],
  ['One Piece Chapter 1165 spoilers: Luffy vs Imu revealed!', 'Anime Leaks'],
  ['One Piece episode 1 reaction — first time watching', 'Weeb Reacts'],
  ['원피스 1160화 스포 정리 (충격 반전)', '애니토크'],
  ['Every One Piece opening ranked', 'AnimeRank'],
  ['Bitcoin to $500K?! Buy this coin NOW', 'Crypto Moon'],
  ['How blockchains actually work (CS lecture)', 'MIT OpenCourseWare'],
  ['I built a mechanical keyboard from scratch', 'Linus Tech Tips'],
  ['10-minute garlic butter pasta', 'Joshua Weissman'],
  ['Lakers vs Celtics full game highlights', 'NBA'],
  ['Lofi hip hop radio — beats to relax/study to', 'Lofi Girl'],
  ['Cat vs cucumber: the science behind the jump', 'SciShow'],
  ['Trump and the cats of the White House: a history', 'History Channel'],
];

const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

async function timed(body) {
  const t = performance.now();
  const res = await callJev(apiKey, body);
  return { res, ms: performance.now() - t };
}

async function pool(tasks, n) {
  const out = new Array(tasks.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < tasks.length) { const j = i++; out[j] = await tasks[j](); }
  }));
  return out;
}

console.log('== Rule polarity (choice) ==');
const pol = await Promise.all(RULES.map((r) => timed(polarityQuestion(r))));
const polarity = {};
RULES.forEach((r, i) => {
  const a = pol[i].res.answers.polarity;
  polarity[r] = a.choice;
  console.log(`${r.padEnd(24)} -> ${a.choice}  p=${JSON.stringify(a.probabilities)}  conf=${a.confidence}  ${pol[i].ms.toFixed(0)}ms`);
});

const concurrency = Number(process.env.CONCURRENCY || 6);
console.log(`\n== ${ITEMS.length} items x ${RULES.length} rules (1 request per item, concurrency ${concurrency}) ==`);
const questions = Object.fromEntries(RULES.map((r, i) => [`r${i}`, ruleQuestion(r)]));
const t0 = performance.now();
const results = await pool(ITEMS.map(([title, channel]) => () =>
  timed({ state: { feed_item: { platform: 'YouTube', title, channel } }, questions })), concurrency);
const wall = performance.now() - t0;

const HIDE_AT = 0.65, BLUR_AT = 0.35;
const head = RULES.map((r, i) => `r${i}`.padStart(5)).join('');
console.log(`${'title'.padEnd(58)}${head}  decision`);
let tokens = 0;
results.forEach(({ res }, k) => {
  tokens += res.usage.input_tokens;
  const p = RULES.map((_, i) => res.answers[`r${i}`].noul);
  const want = p.filter((_, i) => polarity[RULES[i]] === 'want');
  const avoid = p.filter((_, i) => polarity[RULES[i]] === 'avoid');
  const maxAvoid = Math.max(0, ...avoid), maxWant = Math.max(0, ...want);
  let d = 'show';
  if (maxAvoid >= HIDE_AT || (want.length && maxWant < BLUR_AT)) d = 'HIDE';
  else if (maxAvoid >= BLUR_AT || (want.length && maxWant < HIDE_AT)) d = 'blur';
  console.log(`${ITEMS[k][0].slice(0, 56).padEnd(58)}${p.map((x) => x.toFixed(2).padStart(5)).join('')}  ${d}`);
});
RULES.forEach((r, i) => console.log(`  r${i} = ${r} (${polarity[r]})`));

const lat = results.map((r) => r.ms);
console.log(`\nlatency per request: p50 ${pct(lat, 50).toFixed(0)}ms  p95 ${pct(lat, 95).toFixed(0)}ms  min ${Math.min(...lat).toFixed(0)}  max ${Math.max(...lat).toFixed(0)}`);
console.log(`wall clock ${wall.toFixed(0)}ms, input tokens ${tokens} (~$${(tokens * 0.042e-6).toFixed(6)}), model ${results[0].res.model}`);
