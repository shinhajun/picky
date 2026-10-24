// Tests an API key with one small Jev request and saves it only if Jev accepts it.
// Shared by the popup (first run) and the options page.
import { callJev, ruleQuestion } from './jev.js';

export async function testAndSaveKey(apiKey) {
  const t = performance.now();
  const res = await callJev(apiKey, {
    state: { feed_item: { platform: 'YouTube', title: 'My cat learned to open the fridge', channel: 'Mochi the Cat' } },
    questions: { cats: ruleQuestion('cats only') },
  }, { retries: 1 });
  const ms = Math.round(performance.now() - t);
  chrome.runtime.sendMessage({ type: 'usage', tokens: res.usage?.input_tokens || 0 }).catch(() => {});
  await chrome.storage.local.set({ apiKey });
  return { ms, model: res.model };
}

export function keyErrorMessage(err) {
  if (err.status === 401) return 'Jev rejected this key. Check that you copied all of it.';
  return `Couldn’t reach Jev (${err.status || 'network'}). The key was not saved.`;
}
