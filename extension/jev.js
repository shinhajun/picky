// Jev (TypeSafe System One) client. Shared by the service worker and scripts/jev-bench.js.

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';

// Jev bills input tokens only ($0.042 per million); output tokens are free.
export const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;
export const costOf = (inputTokens) => inputTokens * USD_PER_INPUT_TOKEN;

// Amounts are tiny: totals show 4 decimals (or <$0.0001); per-unit costs show 2 significant digits.
export function formatUsd(usd, { perUnit = false } = {}) {
  if (!usd) return '$0';
  if (perUnit) return `$${usd.toFixed(Math.max(2, 1 - Math.floor(Math.log10(usd))))}`;
  if (usd < 0.0001) return '<$0.0001';
  return `$${usd.toFixed(usd < 1 ? 4 : 2)}`;
}

// One Noul per rule. The question asks only whether the item is about the rule's
// subject; whether that means "hide" or "keep" is decided in code from the rule's polarity.
export function ruleQuestion(ruleText) {
  return {
    type: 'noul',
    instructions: {
      question: 'Is `feed_item` about the subject that `user_rule` names?',
      user_rule: ruleText,
      note: '`user_rule` is a filter a viewer wrote, in any language. It may say they want or do not want something; ignore that and judge only whether `feed_item` is about that subject. When the rule narrows a subject, such as spoilers of a show or hype about a topic, the item must match the narrower subject.',
    },
    criteria: {
      true: 'The title, text, picture or channel shows the item is about that subject',
      false: 'The item is about something else, only mentions it in passing, or is about the broader topic but not the narrower subject the rule names',
    },
  };
}

export function polarityQuestion(ruleText) {
  return {
    state: { user_rule: ruleText },
    questions: {
      polarity: {
        type: 'choice',
        instructions: 'A viewer wrote `user_rule` to filter their social media feed. Does it name something they want to see more of or only see, or something they want hidden?',
        criteria: {
          want: 'They want to see this subject, or only this subject (e.g. "cats only", "just cooking videos", "고양이 영상만")',
          avoid: 'They want this subject hidden, removed or avoided (e.g. "no politics", "hide spoilers", "정치 얘기 싫어")',
        },
      },
    },
  };
}

export class JevError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// POST one System One request. Retries 429/529/network errors with exponential backoff.
// Requests with `assets` (images) need the Danger-Zone header.
export async function callJev(apiKey, { state, questions, assets }, { retries = 4, timeoutMs = 15000 } = {}) {
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  if (assets) headers['TypeSafe-Danger-Zone-Images'] = 'true';
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(JEV_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: JEV_MODEL, state, questions, assets }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (attempt >= retries) throw new JevError(0, `Network error: ${err.message}`);
      await sleep(backoff(attempt));
      continue;
    }
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status === 529) && attempt < retries) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
      continue;
    }
    const text = await res.text().catch(() => '');
    throw new JevError(res.status, `Jev ${res.status}: ${text.slice(0, 200)}`);
  }
}

function backoff(attempt) {
  return Math.min(8000, 400 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
}

// Stable short hash for cache keys (FNV-1a, 32-bit).
export function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function ruleKey(text) {
  return hash(text.trim().toLowerCase());
}
