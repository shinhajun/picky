// Service worker: calls Jev for content scripts, caches answers, classifies rule polarity.
import { imageAsset } from './image.js';
import { callJev, polarityQuestion, ruleKey, ruleQuestion } from './jev.js';

// A page's feed data arrives in bursts of 20-50 items. Jev answered 30 parallel single-item requests in
// ~300 ms, so a high limit is what lets items be judged before they are drawn (429s are retried).
const MAX_CONCURRENT = 20;
const CACHE_LIMIT = 5000;
// Same band content.js blurs. A text answer in it, or an item with almost no text, gets a second
// look with its picture.
const UNSURE_FROM = 0.35;
const UNSURE_TO = 0.65;
const SHORT_TEXT = 20; // letters and digits

// ---- concurrency limit ----
let running = 0;
const waiting = [];
async function limited(fn) {
  while (running >= MAX_CONCURRENT) await new Promise((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

// ---- answer cache: `${contentKey}|${ruleKey}` -> probability, persisted for the browser session ----
const cache = new Map();
const cacheReady = chrome.storage.session.get('cache').then(({ cache: saved }) => {
  for (const [k, v] of saved || []) cache.set(k, v);
});
let saveTimer;
function remember(k, v) {
  cache.delete(k);
  cache.set(k, v);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.session.set({ cache: [...cache] }), 1000);
}

async function getApiKey() {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  return apiKey?.trim() || '';
}

// ---- usage: every Jev call's input tokens, per session (and per tab) and in total ----
// `saved` counts judge requests answered from the cache, without a call.
const emptyUsage = () => ({ calls: 0, tokens: 0, saved: 0 });
let usage = { ...emptyUsage(), byTab: {} }; // chrome.storage.session
let usageTotal = { ...emptyUsage(), since: Date.now() }; // chrome.storage.local
const usageReady = Promise.all([chrome.storage.session.get('usage'), chrome.storage.local.get('usageTotal')]).then(([s, l]) => {
  if (s.usage) usage = s.usage;
  if (l.usageTotal) usageTotal = l.usageTotal;
});
let usageTimer;
async function countUsage({ tokens = 0, calls = 0, saved = 0 }, tabId) {
  await usageReady;
  const tab = tabId == null ? null : (usage.byTab[tabId] ??= emptyUsage());
  for (const u of [usage, usageTotal, tab]) {
    if (!u) continue;
    u.calls += calls;
    u.tokens += tokens;
    u.saved += saved;
  }
  clearTimeout(usageTimer);
  usageTimer = setTimeout(() => {
    chrome.storage.session.set({ usage });
    chrome.storage.local.set({ usageTotal });
  }, 300);
}
const countCall = (res, tabId) => countUsage({ tokens: res.usage?.input_tokens || 0, calls: 1 }, tabId);

// ---- status shown in the popup and Feed Facts ----
const latencies = [];
const imageLatencies = [];
const status = { ok: true, p50: null, images: { ok: 0, failed: 0, p50: null } };
let statusTimer;
const median = (xs) => Math.round([...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]);
function saveStatus() {
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => chrome.storage.session.set({ status: { ...status, at: Date.now() } }), 300);
}
function noteSuccess(ms) {
  latencies.push(ms);
  if (latencies.length > 50) latencies.shift();
  Object.assign(status, { ok: true, p50: median(latencies), httpStatus: undefined, error: undefined });
  saveStatus();
}
function noteError(err) {
  Object.assign(status, { ok: false, httpStatus: err.status ?? 0, error: err.message });
  saveStatus();
}
function noteImage(ok, ms) {
  if (ok) {
    imageLatencies.push(ms);
    if (imageLatencies.length > 50) imageLatencies.shift();
    status.images = { ...status.images, ok: status.images.ok + 1, p50: median(imageLatencies) };
  } else {
    status.images = { ...status.images, failed: status.images.failed + 1 };
  }
  saveStatus();
}

// ---- judge one feed item against every rule in a single Jev request ----
// rules: rule texts. Answers are keyed by rule text; polarity is applied by the content script.
const inflight = new Map();
async function judge({ key, state, rules, image }, tabId) {
  await cacheReady;
  const probs = {};
  const missing = [];
  for (const text of rules) {
    const v = cache.get(`${key}|${ruleKey(text)}`);
    if (v === undefined) missing.push(text);
    else probs[text] = v;
  }
  if (!missing.length) {
    countUsage({ saved: 1 }, tabId);
    return { probs };
  }

  const apiKey = await getApiKey();
  if (!apiKey) return { error: 'no-key', probs };

  const flightKey = `${key}|${missing.map(ruleKey).join(',')}`;
  let request = inflight.get(flightKey);
  if (request) {
    countUsage({ saved: 1 }, tabId); // same item already being asked about
  } else {
    request = limited(() => askItem(apiKey, state, missing, image, tabId)).finally(() => inflight.delete(flightKey));
    inflight.set(flightKey, request);
  }
  try {
    const { answers, vision } = await request;
    for (const [text, v] of Object.entries(answers)) {
      probs[text] = v;
      remember(`${key}|${ruleKey(text)}`, v);
    }
    return { probs, vision };
  } catch (err) {
    noteError(err);
    return { error: err.status === 401 ? 'bad-key' : 'failed', probs };
  }
}

const questionsFor = (texts) => Object.fromEntries(texts.map((text, i) => [`r${i}`, ruleQuestion(text)]));
const answersFor = (res, texts, into = {}) => {
  texts.forEach((text, i) => {
    const v = res.answers[`r${i}`]?.noul;
    if (typeof v === 'number') into[text] = v;
  });
  return into;
};

function isShort(state) {
  const f = state.feed_item || {};
  const text = [f.title, f.caption, f.text].filter(Boolean).join(' ');
  return (text.match(/[\p{L}\p{N}]/gu) || []).length < SHORT_TEXT;
}

// Text first. Only unsure answers (or every answer, when there is barely any text) are asked again
// with the picture; if anything about the image fails, the text answers stand.
async function askItem(apiKey, state, texts, image, tabId) {
  const t = performance.now();
  const first = await callJev(apiKey, { state, questions: questionsFor(texts) });
  countCall(first, tabId);
  const answers = answersFor(first, texts);
  noteSuccess(performance.now() - t);
  if (!image) return { answers };
  const again = isShort(state) ? texts : texts.filter((x) => answers[x] >= UNSURE_FROM && answers[x] < UNSURE_TO);
  if (!again.length) return { answers };
  const t2 = performance.now();
  try {
    const { ref, asset } = await imageAsset(image);
    const withPicture = { ...state, feed_item: { ...state.feed_item, picture: ref } };
    const res = await callJev(apiKey, { state: withPicture, questions: questionsFor(again), assets: { [ref]: asset } }, { retries: 2 });
    countCall(res, tabId);
    answersFor(res, again, answers);
    noteImage(true, performance.now() - t2);
    return { answers, vision: true };
  } catch {
    noteImage(false);
    return { answers };
  }
}

// ---- rule polarity: one Jev choice per new rule, written back into storage ----
const classifying = new Set();
async function classifyRules({ retryGuesses = false } = {}) {
  const { rules = [] } = await chrome.storage.local.get('rules');
  const apiKey = await getApiKey();
  const todo = rules.filter((r) =>
    !classifying.has(r.id) && (!r.polarity || (retryGuesses && apiKey && r.polaritySource === 'guess')));
  await Promise.all(todo.map(async (rule) => {
    classifying.add(rule.id);
    try {
      const result = await classify(rule.text, apiKey);
      const { rules: now = [] } = await chrome.storage.local.get('rules');
      const target = now.find((r) => r.id === rule.id);
      // Leave rules the user edited or toggled in the meantime alone.
      if (!target || target.text !== rule.text || target.polaritySource === 'user') return;
      Object.assign(target, result);
      await chrome.storage.local.set({ rules: now });
    } finally {
      classifying.delete(rule.id);
    }
  }));
}

async function classify(text, apiKey) {
  if (apiKey) {
    try {
      // Not behind the feed's queue: one call per rule, and the popup is waiting on it.
      const res = await callJev(apiKey, polarityQuestion(text));
      countCall(res);
      const a = res.answers.polarity;
      return { polarity: a.choice, polaritySource: 'jev', polarityConf: a.probabilities?.[a.choice] ?? null };
    } catch (err) {
      noteError(err);
    }
  }
  return { polarity: guessPolarity(text), polaritySource: 'guess', polarityConf: null };
}

// Offline fallback only; Jev decides whenever a key is set.
function guessPolarity(text) {
  return /\b(only|just|more)\b|만\s*$|만\s|보여|좋아/i.test(text) ? 'want' : 'avoid';
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.apiKey) classifyRules({ retryGuesses: true });
  else if (changes.rules) classifyRules();
});
classifyRules();

// ---- Feed Facts: one snapshot per page load per tab, kept for the browser session ----
let facts = {};
const factsReady = chrome.storage.session.get('facts').then((s) => {
  facts = { ...(s.facts || {}), ...facts };
});
let factsTimer;
async function recordFacts(tabId, msg) {
  await factsReady;
  if (!msg.facts?.judged) return;
  facts[`${tabId}:${msg.page}`] = { tabId, site: msg.site, ...msg.facts, at: Date.now() };
  const keys = Object.keys(facts);
  if (keys.length > 300) {
    keys.sort((a, b) => facts[a].at - facts[b].at).slice(0, keys.length - 300).forEach((k) => delete facts[k]);
  }
  clearTimeout(factsTimer);
  factsTimer = setTimeout(() => chrome.storage.session.set({ facts }), 400);
}

// ---- messages ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'judge') {
    judge(msg, sender.tab?.id).then(sendResponse);
    return true;
  }
  // Calls made from extension pages (the API key test in the popup and options page).
  if (msg.type === 'usage') {
    countUsage({ tokens: msg.tokens || 0, calls: 1 });
    return false;
  }
  if (msg.type === 'resetUsage') {
    usageReady.then(async () => {
      usageTotal = { ...emptyUsage(), since: Date.now() };
      await chrome.storage.local.set({ usageTotal });
      sendResponse(usageTotal);
    });
    return true;
  }
  if (msg.type === 'stats' && sender.tab?.id != null) {
    const tabId = sender.tab.id;
    recordFacts(tabId, msg);
    chrome.action.setBadgeText({ tabId, text: msg.hidden ? String(msg.hidden) : '' });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#1B1838' });
    chrome.action.setBadgeTextColor?.({ tabId, color: '#FFD43B' });
  }
  return false;
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const { enabled } = await chrome.storage.local.get('enabled');
  if (enabled === undefined) await chrome.storage.local.set({ enabled: true });
  if (reason === 'install' && !(await getApiKey())) chrome.runtime.openOptionsPage();
});
