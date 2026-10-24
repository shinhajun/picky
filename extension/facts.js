// Feed Facts: tallies the content scripts report (one snapshot per page load, kept in
// chrome.storage.session by the service worker), for one tab or the whole browser session.
import { costOf, formatUsd } from './jev.js';

const $ = (id) => document.getElementById(id);
const tabId = Number(new URLSearchParams(location.search).get('tab')) || null;
let scope = tabId ? 'tab' : 'session';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function total(snapshots) {
  const t = { feeds: snapshots.length, judged: 0, hidden: 0, blurred: 0, shown: 0, removed: 0, hiddenAds: 0, withPicture: 0, hiddenBy: {}, offTopicFor: {}, fitBy: {}, sites: {} };
  for (const s of snapshots) {
    for (const k of ['judged', 'hidden', 'blurred', 'shown', 'removed', 'hiddenAds', 'withPicture']) t[k] += s[k] || 0;
    for (const map of ['hiddenBy', 'offTopicFor', 'fitBy']) {
      for (const [rule, n] of Object.entries(s[map] || {})) t[map][rule] = (t[map][rule] || 0) + n;
    }
    t.sites[s.site] = (t.sites[s.site] || 0) + (s.judged || 0);
  }
  return t;
}

const byCount = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]);

function row(what, n, judged, { sub = false, bold = '' } = {}) {
  const li = el('li', sub ? 'row sub' : 'row');
  const label = el('span', 'what');
  if (bold) label.append(el('b', '', bold), ' ');
  label.append(what === '' ? '' : `${what} `, String(n));
  const share = judged ? (n / judged) * 100 : 0;
  li.append(label, el('span', 'pct', share > 0 && share < 1 ? '<1%' : `${Math.round(share)}%`));
  return li;
}

function render({ facts = {}, status = {}, usage = {}, rules = [] }) {
  const snapshots = Object.values(facts).filter((s) => scope === 'session' || s.tabId === tabId);
  const t = total(snapshots);
  const per = scope === 'tab' ? 'tab' : 'session';

  $('servings').textContent = `${t.feeds} ${t.feeds === 1 ? 'feed' : 'feeds'} per ${per}`;
  $('servingSize').textContent = `1 scroll (${t.judged} items)`;
  $('amount').textContent = `Amount per ${per}`;
  // Session cost includes rule sorting and key tests; a tab's cost is its own judge calls.
  const spent = (scope === 'tab' ? usage.byTab?.[tabId] : usage) || { calls: 0, tokens: 0, saved: 0 };
  const cost = costOf(spent.tokens);
  $('cost').textContent = formatUsd(cost);
  $('costNote').replaceChildren(
    el('span', '', t.judged && cost ? `≈ ${formatUsd(cost / t.judged, { perUnit: true })} per decision` : 'Nothing spent yet'),
    el('span', '', `${spent.tokens.toLocaleString('en-US')} input tokens`),
  );

  const rows = [];
  if (!t.judged) {
    rows.push(el('li', 'row empty', 'Nothing judged yet. Scroll a feed with Picky on.'));
  } else {
    rows.push(row('', t.hidden, t.judged, { bold: 'Hidden' }));
    if (t.removed) rows.push(row('Removed before drawn', t.removed, t.judged, { sub: true }));
    if (t.hiddenAds) rows.push(row('Ads', t.hiddenAds, t.judged, { sub: true }));
    const reasons = [...byCount(t.hiddenBy), ...byCount(t.offTopicFor).map(([rule, n]) => [`Off-topic for ${rule}`, n])];
    for (const [what, n] of reasons.sort((a, b) => b[1] - a[1])) rows.push(row(what, n, t.judged, { sub: true }));
    rows.push(row('', t.blurred, t.judged, { bold: 'Unsure' }));
    rows.push(row('', t.shown, t.judged, { bold: 'Shown' }));
    for (const [rule, n] of byCount(t.fitBy)) rows.push(row(`Fits ${rule}`, n, t.judged, { sub: true }));
  }
  $('rows').replaceChildren(...rows);

  const sites = byCount(t.sites);
  $('sites').replaceChildren(...(sites.length
    ? sites.map(([site, n]) => row(site, n, t.judged))
    : [el('li', 'row empty', 'No sites yet.')]));

  const extras = [row('Judged with a picture', t.withPicture, t.judged)];
  const saved = el('li', 'row');
  saved.append(el('span', 'what', `Jev calls ${spent.calls.toLocaleString('en-US')}`), el('span', 'pct', `${spent.saved.toLocaleString('en-US')} saved by cache`));
  extras.push(saved);
  const timing = el('li', 'row');
  timing.append(el('span', 'what', 'Jev decision time'), el('span', 'pct', status.p50 ? `${status.p50} ms` : '—'));
  extras.push(timing);
  if (status.images?.p50) {
    const pic = el('li', 'row sub');
    pic.append(el('span', 'what', 'with a picture'), el('span', 'pct', `${status.images.p50} ms`));
    extras.push(pic);
  }
  $('extras').replaceChildren(...extras);

  const ruleList = rules.map((r) => r.text).join(', ');
  $('ingredients').replaceChildren(
    el('b', '', 'Ingredients: '),
    'titles, captions, channel names, hashtags, ad text and landing sites, image descriptions, pictures (only when Jev wasn’t sure)',
    ruleList ? `, and your rules (${ruleList}).` : '.',
  );
}

async function refresh() {
  const [session, local] = await Promise.all([
    chrome.storage.session.get(['facts', 'status', 'usage']),
    chrome.storage.local.get('rules'),
  ]);
  render({ facts: session.facts, status: session.status, usage: session.usage, rules: local.rules });
}

function setScope(next) {
  scope = next;
  $('scopeTab').setAttribute('aria-checked', String(scope === 'tab'));
  $('scopeSession').setAttribute('aria-checked', String(scope === 'session'));
  refresh();
}

$('scopeTab').disabled = !tabId;
$('scopeTab').onclick = () => setScope('tab');
$('scopeSession').onclick = () => setScope('session');
chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === 'session' && (changes.facts || changes.status || changes.usage)) || (area === 'local' && changes.rules)) refresh();
});
setScope(scope);
