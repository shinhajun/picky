import { costOf, formatUsd, USD_PER_INPUT_TOKEN } from './jev.js';
import { keyErrorMessage, testAndSaveKey } from './key.js';

const $ = (id) => document.getElementById(id);
const input = $('apiKey');

function show(state, text) {
  $('result').dataset.state = state;
  $('result').textContent = text;
}

$('reveal').onclick = () => {
  const hidden = input.type === 'password';
  input.type = hidden ? 'text' : 'password';
  $('reveal').textContent = hidden ? 'Hide' : 'Show';
};

$('clear').onclick = async () => {
  await chrome.storage.local.remove('apiKey');
  input.value = '';
  show('', 'Key removed. Picky is paused until you add one.');
};

$('keyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const apiKey = input.value.trim();
  if (!apiKey) return show('error', 'Paste a key first.');
  $('save').disabled = true;
  show('', 'Testing the key with Jev…');
  try {
    const { ms, model } = await testAndSaveKey(apiKey);
    show('ok', `Saved. Jev (${model}) answered in ${ms} ms.`);
  } catch (err) {
    show('error', keyErrorMessage(err));
  } finally {
    $('save').disabled = false;
  }
});

// ---- usage since the last reset ----
function showUsage(u = { calls: 0, tokens: 0, saved: 0, since: Date.now() }) {
  $('uCost').textContent = formatUsd(costOf(u.tokens));
  $('uCalls').textContent = u.calls.toLocaleString('en-US');
  $('uTokens').textContent = u.tokens.toLocaleString('en-US');
  $('uSaved').textContent = u.saved.toLocaleString('en-US');
  $('uSince').textContent = new Date(u.since).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}
$('price').textContent = `$${+(USD_PER_INPUT_TOKEN * 1e6).toFixed(4)}`;
$('resetUsage').onclick = async () => showUsage(await chrome.runtime.sendMessage({ type: 'resetUsage' }));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.usageTotal) showUsage(changes.usageTotal.newValue);
});

const { apiKey, usageTotal } = await chrome.storage.local.get(['apiKey', 'usageTotal']);
showUsage(usageTotal);
if (apiKey) {
  input.value = apiKey;
  show('', 'A key is saved.');
}
