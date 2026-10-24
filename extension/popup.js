import { costOf, formatUsd } from './jev.js';
import { keyErrorMessage, testAndSaveKey } from './key.js';

const $ = (id) => document.getElementById(id);

let rules = [];
let hasKey = false;
let lastStatus = null;
let sessionUsage = null;
let editing = false;
let tabId = null;
let site = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---- rules ----
function saveRules(next) {
  rules = next;
  chrome.storage.local.set({ rules });
  renderRules();
}

function updateRule(id, patch) {
  saveRules(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));
}

function addRules(raw) {
  const seen = new Set(rules.map((r) => r.text.toLowerCase()));
  const fresh = [];
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    fresh.push({ id: crypto.randomUUID(), text, polarity: null });
  }
  if (fresh.length) saveRules([...rules, ...fresh]);
}

function ruleRow(rule) {
  const li = el('li', 'rule');
  const text = el('button', 'rule-text', rule.text);
  text.type = 'button';
  text.title = 'Edit rule';
  text.onclick = () => editRule(li, text, rule);

  const polarity = rule.polarity || 'pending';
  const chip = el('button', 'chip', polarity === 'want' ? 'Only show' : polarity === 'avoid' ? 'Hide' : 'Reading');
  chip.type = 'button';
  chip.dataset.polarity = polarity;
  chip.title = polarity === 'pending'
    ? 'Jev is working out whether this is something to hide or to keep'
    : `Switch to “${polarity === 'want' ? 'Hide' : 'Only show'}”`;
  chip.onclick = () => {
    if (polarity === 'pending') return;
    updateRule(rule.id, { polarity: polarity === 'want' ? 'avoid' : 'want', polaritySource: 'user' });
  };

  // Rules about ads apply only to ads.
  const scope = rule.scope === 'every_ad' ? el('span', 'scope', 'every ad') : rule.scope === 'some_ads' ? el('span', 'scope', 'ads') : null;
  if (scope) scope.title = rule.scope === 'every_ad' ? 'Applies to every ad Picky finds' : 'Applies only to ads';

  const remove = el('button', 'remove', '×');
  remove.type = 'button';
  remove.setAttribute('aria-label', `Remove rule “${rule.text}”`);
  remove.onclick = () => saveRules(rules.filter((r) => r.id !== rule.id));

  li.append(...[text, scope, chip, remove].filter(Boolean));
  return li;
}

function editRule(li, textButton, rule) {
  editing = true;
  const input = el('input', 'rule-edit');
  input.value = rule.text;
  input.maxLength = 120;
  input.setAttribute('aria-label', 'Edit rule');
  textButton.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    editing = false;
    const text = input.value.trim();
    if (!commit || text === rule.text) return renderRules();
    if (!text) return saveRules(rules.filter((r) => r.id !== rule.id));
    updateRule(rule.id, { text, polarity: null, polaritySource: null, polarityConf: null });
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => finish(true));
}

function renderRules() {
  if (editing) return;
  $('ruleList').replaceChildren(...rules.map(ruleRow));
  $('empty').hidden = rules.length > 0;
  const wants = rules.filter((r) => r.polarity === 'want' && (r.scope || 'content') === 'content');
  const mode = $('mode');
  mode.hidden = wants.length === 0;
  if (wants.length) {
    mode.replaceChildren('Only-show mode: anything that matches no ', el('b', '', 'Only show'), ' rule gets hidden.');
  }
}

// ---- this tab ----
function showStats(s) {
  site = s.site;
  $('tab').classList.toggle('idle', !s.active);
  $('site').replaceChildren(el('b', '', s.site));
  $('pick').hidden = false;
  $('pickSite').checked = s.siteOn;
  $('siteNote').hidden = s.siteOn && !s.loginPage;
  $('siteNote').textContent = !s.siteOn ? 'Picky leaves this site alone.' : 'Paused on this page: it has a password field, so Picky reads nothing here.';
  // "Leave no trace" shows nothing on the page, so this is where hidden items can come back.
  $('here').hidden = !(s.noTrace && s.hiddenHere > 0);
  if (s.hiddenHere) {
    const all = s.shownHere >= s.hiddenHere;
    $('hereText').textContent = `${s.hiddenHere} hidden on this page${all ? ', showing now' : ''}`;
    $('hereToggle').textContent = all ? 'Hide again' : 'Show them';
    $('hereToggle').dataset.show = all ? '' : '1';
  }
  $('hidden').textContent = s.hidden;
  $('removed').textContent = s.removed ? `${s.removed} removed` : '';
  $('clean').hidden = !s.cleanAvailable || !s.siteOn;
  $('blurred').textContent = s.blurred;
  $('shown').textContent = s.shown;
}

function showUnavailable() {
  $('tab').classList.add('idle');
  $('pick').hidden = true;
  $('site').textContent = 'Picky can’t read this page. Open a feed, like YouTube.';
}

// ---- key + Jev status ----
function renderStatus() {
  const status = $('status');
  const label = status.querySelector('span');
  const badKey = lastStatus && !lastStatus.ok && lastStatus.httpStatus === 401;
  $('keyBanner').hidden = hasKey && !badKey;
  $('keyBannerText').textContent = badKey
    ? 'Jev rejected your API key. Paste a new one.'
    : 'Paste your TypeSafe API key so Picky can read your feed. It stays in this browser.';
  $('cost').textContent = sessionUsage?.tokens ? `${formatUsd(costOf(sessionUsage.tokens))} this session` : '';

  if (!hasKey) {
    status.dataset.state = '';
    label.textContent = 'Jev · no API key yet';
  } else if (badKey) {
    status.dataset.state = 'error';
    label.textContent = 'Jev · API key rejected';
  } else if (lastStatus && !lastStatus.ok) {
    status.dataset.state = 'error';
    label.textContent = lastStatus.httpStatus === 429 ? 'Jev · rate limited, retrying' : 'Jev · can’t reach the API';
  } else if (lastStatus?.p50) {
    status.dataset.state = 'ok';
    label.textContent = `Jev · ${lastStatus.p50} ms per item`;
  } else {
    status.dataset.state = 'ok';
    label.textContent = 'Jev · ready';
  }
}

function setEnabled(on) {
  $('enabled').checked = on;
  document.body.classList.toggle('off', !on);
}

// ---- wiring ----
$('addForm').addEventListener('submit', (e) => {
  e.preventDefault();
  addRules($('ruleInput').value);
  $('ruleInput').value = '';
});
$('ruleInput').addEventListener('paste', (e) => {
  const text = e.clipboardData.getData('text');
  if (!text.includes('\n')) return;
  e.preventDefault();
  addRules(text);
});
for (const b of document.querySelectorAll('.example')) b.onclick = () => addRules(b.textContent);
$('enabled').addEventListener('change', (e) => {
  setEnabled(e.target.checked);
  chrome.storage.local.set({ enabled: e.target.checked });
});
$('settings').onclick = () => chrome.runtime.openOptionsPage();
// Every site is on; the switch remembers the ones turned off.
$('pickSite').addEventListener('change', async (e) => {
  const on = e.target.checked;
  $('siteNote').hidden = on;
  const { sites = {} } = await chrome.storage.local.get('sites');
  const next = { ...sites };
  if (on) delete next[site];
  else next[site] = false;
  await chrome.storage.local.set({ sites: next });
});
$('hereToggle').onclick = async () => {
  try {
    showStats(await chrome.tabs.sendMessage(tabId, { type: 'showHidden', show: Boolean($('hereToggle').dataset.show) }));
  } catch {}
};
function setStyle(style) {
  for (const b of document.querySelectorAll('.seg button')) b.setAttribute('aria-checked', String(b.dataset.style === style));
}
for (const b of document.querySelectorAll('.seg button')) {
  b.onclick = () => {
    setStyle(b.dataset.style);
    chrome.storage.local.set({ hiddenStyle: b.dataset.style });
  };
}
$('cleanFeed').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ cleanFeed: e.target.checked });
  $('cleanHint').hidden = false;
});
$('reloadTab').onclick = () => {
  if (tabId) chrome.tabs.reload(tabId);
  window.close();
};
$('openFacts').onclick = () => {
  chrome.tabs.create({ url: chrome.runtime.getURL(tabId ? `facts.html?tab=${tabId}` : 'facts.html') });
};
$('keyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const apiKey = $('keyInput').value.trim();
  const result = $('keyResult');
  result.dataset.state = '';
  if (!apiKey) {
    result.dataset.state = 'error';
    result.textContent = 'Paste a key first.';
    return;
  }
  $('keySave').disabled = true;
  result.textContent = 'Testing the key with Jev…';
  try {
    await testAndSaveKey(apiKey); // the storage change hides this banner and starts judging
    $('keyInput').value = '';
    result.textContent = '';
    lastStatus = null;
  } catch (err) {
    result.dataset.state = 'error';
    result.textContent = keyErrorMessage(err);
  } finally {
    $('keySave').disabled = false;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    if (changes.rules) {
      rules = changes.rules.newValue || [];
      renderRules();
    }
    if (changes.enabled) setEnabled(changes.enabled.newValue !== false);
    if (changes.cleanFeed) $('cleanFeed').checked = changes.cleanFeed.newValue === true;
    if (changes.hiddenStyle) setStyle(changes.hiddenStyle.newValue || 'card');
    if (changes.apiKey) {
      hasKey = Boolean(changes.apiKey.newValue?.trim());
      renderStatus();
    }
  }
  if (area === 'session' && (changes.status || changes.usage)) {
    if (changes.status) lastStatus = changes.status.newValue;
    if (changes.usage) sessionUsage = changes.usage.newValue;
    renderStatus();
  }
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'stats' && sender.tab?.id === tabId) showStats(msg);
});

const local = await chrome.storage.local.get(['enabled', 'rules', 'apiKey', 'cleanFeed', 'hiddenStyle']);
$('cleanFeed').checked = local.cleanFeed === true;
setStyle(local.hiddenStyle || 'card');
rules = local.rules || [];
hasKey = Boolean(local.apiKey?.trim());
const session = await chrome.storage.session.get(['status', 'usage']);
lastStatus = session.status || null;
sessionUsage = session.usage || null;
setEnabled(local.enabled !== false);
renderRules();
renderStatus();

// ?tab=<id> lets the popup be opened in a tab for a given page (used by scripts/e2e-youtube.js).
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
tabId = Number(new URLSearchParams(location.search).get('tab')) || tab?.id || null;
try {
  showStats(await chrome.tabs.sendMessage(tabId, { type: 'getStats' }));
} catch {
  showUnavailable();
}
