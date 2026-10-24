// Finds feed items, asks the service worker for Jev probabilities, and hides, blurs or labels them.
(() => {
  const host = location.hostname.replace(/^www\./, '');
  const builtIn = /(^|\.)youtube\.com$/.test(host) ? PickyAdapters.youtube
    : /(^|\.)instagram\.com$/.test(host) ? PickyAdapters.instagram : null;
  const adapter = builtIn || PickyAdapters.generic;
  const site = builtIn?.site || host; // key for the per-site switch; YouTube and Instagram default to on
  const page = Math.random().toString(36).slice(2); // this page load, for Feed Facts
  const HIDE_AT = 0.65; // "avoid" at or above, or best "want" below BLUR_AT -> hide
  const BLUR_AT = 0.35; // in between -> blur, never hide
  const STATES = ['picky-pending', 'picky-hidden', 'picky-blurred', 'picky-revealed', 'picky-anchor'];

  let enabled = false;
  let siteOn = false;
  let rules = []; // [{ id, text, polarity: 'want' | 'avoid' | null }]
  let blocked = null; // 'no-key' | 'bad-key': stop asking until settings change
  const tracked = new Set(); // item elements we manage
  const near = new Set(); // tracked items within the prefetch margin of the viewport
  const results = new Map(); // content key -> { [rule text]: probability }
  const decisions = new Map(); // content key -> decide() result
  const seenWithPicture = new Set(); // content keys Jev judged with their image
  const revealed = new Set(); // content keys the user chose to see anyway
  const tokens = new WeakMap(); // item -> latest judge() call, to drop stale answers
  const labels = new WeakMap(); // item -> label host

  const alive = () => Boolean(chrome.runtime?.id);
  const active = () => enabled && siteOn && rules.length > 0 && alive();
  const decisive = () => rules.some((r) => r.polarity === 'want' || r.polarity === 'avoid');

  // ---- settings ----
  function loadSettings() {
    chrome.storage.local.get(['enabled', 'rules', 'sites']).then((s) => {
      const before = rules.map((r) => `${r.text}:${r.polarity}`).join('\n');
      enabled = s.enabled !== false;
      siteOn = s.sites?.[site] ?? Boolean(builtIn);
      rules = (s.rules || []).filter((r) => r.text?.trim()).map((r) => ({ ...r, text: r.text.trim() }));
      blocked = null;
      if (rules.map((r) => `${r.text}:${r.polarity}`).join('\n') !== before) redecide();
      if (active()) {
        observe();
        scan();
      } else {
        unobserve();
      }
      for (const el of tracked) judge(el);
      reportStats();
    });
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.enabled || changes.rules || changes.sites || changes.apiKey)) loadSettings();
  });

  // Rules changed: keep the tallies for items whose answers we already have.
  function redecide() {
    for (const key of decisions.keys()) {
      const probs = results.get(key) || {};
      if (rules.every((r) => r.text in probs) && decisive()) decisions.set(key, decide(probs));
      else decisions.delete(key);
    }
  }

  // ---- judging ----
  async function judge(el) {
    const key = adapter.key(el);
    el.dataset.pickyKey = key || '';
    if (!active() || !key) return clear(el);

    const have = results.get(key) || {};
    const missing = rules.map((r) => r.text).filter((t) => !(t in have));
    if (!missing.length) return apply(el, key);
    if (!near.has(el) || blocked) return clear(el);

    const state = adapter.extract(el);
    el.dataset.pickyWaiting = state ? '' : '1'; // title not rendered yet; a mutation will retry
    if (!state) return clear(el);
    if (decisive()) setClass(el, 'picky-pending');

    const token = {};
    tokens.set(el, token);
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'judge', key, state, rules: missing, image: adapter.image(el) });
    } catch {
      return clear(el); // extension reloaded underneath us
    }
    if (res?.probs) results.set(key, { ...(results.get(key) || {}), ...res.probs });
    if (res?.vision) seenWithPicture.add(key);
    if (res?.error === 'no-key' || res?.error === 'bad-key') blocked = res.error;
    if (tokens.get(el) !== token || el.dataset.pickyKey !== key) return; // node recycled meanwhile
    const now = results.get(key) || {};
    if (rules.every((r) => r.text in now)) apply(el, key);
    else clear(el);
  }

  function decide(probs) {
    let avoid = null;
    let want = null;
    for (const rule of rules) {
      const p = probs[rule.text];
      if (p === undefined) continue;
      if (rule.polarity === 'avoid' && (!avoid || p > avoid.p)) avoid = { rule, p };
      if (rule.polarity === 'want' && (!want || p > want.p)) want = { rule, p };
    }
    if (avoid && avoid.p >= HIDE_AT) return { state: 'hide', kind: 'avoid', ...avoid };
    if (want && want.p < BLUR_AT) return { state: 'hide', kind: 'want', ...want };
    if (avoid && avoid.p >= BLUR_AT) return { state: 'blur', kind: 'avoid', ...avoid };
    if (want && want.p < HIDE_AT) return { state: 'blur', kind: 'want', ...want };
    return want ? { state: 'show', kind: 'want', ...want } : { state: 'show' };
  }

  function apply(el, key) {
    const d = decide(results.get(key));
    if (decisive()) decisions.set(key, d);
    reportStats();
    if (d.state === 'show') return clear(el);
    const state = revealed.has(key) ? 'revealed' : d.state === 'hide' ? 'hidden' : 'blurred';
    // Tiles keep their height when hidden so grids stay aligned.
    const height = el.classList.contains('picky-hidden') ? 0 : el.getBoundingClientRect().height;
    setClass(el, `picky-${state}`);
    if (state !== 'hidden' && getComputedStyle(el).position === 'static') el.classList.add('picky-anchor');
    renderLabel(el, state, d, key, height);
  }

  function setClass(el, cls) {
    for (const c of STATES) if (c !== cls) el.classList.remove(c);
    el.classList.add(cls);
  }

  function clear(el) {
    el.classList.remove(...STATES);
  }

  // ---- labels (shadow DOM so page styles can't reach them) ----
  const MARK = '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="10" fill="#FFD43B"/><path d="M7.2 15.5V8.4a3 3 0 1 1 3 3H7.2" fill="none" stroke="#1B1838" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function labelFor(el) {
    let host = labels.get(el);
    if (!host) {
      host = document.createElement('div');
      host.className = 'picky-label';
      host.attachShadow({ mode: 'open' }).innerHTML = `<style>${LABEL_CSS}</style><div class="card" role="note"></div>`;
      // Keep clicks on the label from opening the video or post underneath (some cards are one big link).
      for (const t of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'keydown']) {
        host.addEventListener(t, (e) => e.stopPropagation());
      }
      host.addEventListener('click', (e) => e.preventDefault());
      labels.set(el, host);
    }
    if (host.parentElement !== el) el.append(host);
    return host;
  }

  function renderLabel(el, state, d, key, height) {
    const host = labelFor(el);
    if (height > 60) {
      host.style.setProperty('--picky-h', `${Math.round(height)}px`);
      host.setAttribute('sized', '');
    }
    host.setAttribute('theme', adapter.isDark() ? 'dark' : 'light');
    host.setAttribute('shape', adapter.shape(el));
    host.setAttribute('state', state);
    host.setAttribute('kind', d.kind);
    const card = host.shadowRoot.querySelector('.card');
    const score = d.p.toFixed(2);
    const rule = `<span class="rule">${escapeHtml(d.rule.text)}</span>`;
    const prefix = d.kind === 'want' && state !== 'blurred' ? '<span class="prefix">doesn’t fit</span>' : '';
    const reason = `<span class="line">${prefix}${rule}<span class="score">(${score})</span></span>`;
    if (state === 'revealed') {
      card.innerHTML = `${MARK}${reason}<button type="button">Hide again</button>`;
    } else {
      const title = state === 'hidden' ? 'Picky hid this' : 'Picky isn’t sure';
      card.innerHTML = `${MARK}<span class="text"><span class="title">${title}</span><span class="sep" aria-hidden="true">·</span>${reason}</span><button type="button">${state === 'hidden' ? 'Show anyway' : 'Show'}</button>`;
    }
    card.querySelector('button').onclick = () => {
      if (revealed.has(key)) revealed.delete(key);
      else revealed.add(key);
      for (const item of tracked) if (item.dataset.pickyKey === key) apply(item, key);
    };
  }

  const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  const LABEL_CSS = `
    :host { all: initial; display: block; box-sizing: border-box;
      --surface: #F4F3FA; --ink: #1B1838; --muted: #6B6886; --line: #E1DFEC; --hatch: rgba(27,24,56,.07);
      --avoid-bg: #FCE7EA; --avoid-fg: #B4232C; --want-bg: #DDF3E9; --want-fg: #0B6B47;
      --glass: rgba(255,255,255,.88); --btn: #1B1838; --btn-fg: #FFFFFF;
      font: 500 13px/1.35 Roboto, system-ui, -apple-system, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
      color: var(--ink); }
    :host([theme=dark]) { --surface: #1E1C31; --ink: #F1EFFA; --muted: #A6A3BF; --line: #34314F; --hatch: rgba(255,255,255,.05);
      --avoid-bg: rgba(229,72,77,.2); --avoid-fg: #FF9EA4; --want-bg: rgba(16,185,129,.2); --want-fg: #7DE8BF;
      --glass: rgba(24,22,40,.86); --btn: #F1EFFA; --btn-fg: #1B1838; }
    :host([state=hidden]), :host([state=blurred]) { container: picky / inline-size; }
    * { box-sizing: border-box; }
    .card { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 12px;
      border: 1px solid var(--line); color: var(--ink);
      background: repeating-linear-gradient(135deg, var(--hatch) 0 1px, transparent 1px 8px), var(--surface); }
    svg { width: 20px; height: 20px; flex: none; }
    .text { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; align-items: center; column-gap: 6px; row-gap: 3px; }
    .title { font-weight: 700; white-space: nowrap; }
    .sep, .prefix, .score { color: var(--muted); }
    .line { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; }
    .score { font-variant-numeric: tabular-nums; white-space: nowrap; }
    .prefix { white-space: nowrap; }
    .rule { min-width: 0; padding: 2px 8px; border-radius: 999px; line-height: 16px;
      background: var(--avoid-bg); color: var(--avoid-fg); font-weight: 600; font-size: 12px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    :host([kind=want]) .rule { background: var(--want-bg); color: var(--want-fg); }
    button { all: unset; flex: none; cursor: pointer; padding: 5px 11px; border-radius: 999px; font-weight: 600; font-size: 12px;
      background: var(--btn); color: var(--btn-fg); white-space: nowrap; }
    button:hover { opacity: .88; }
    button:focus-visible { outline: 2px solid #FFD43B; outline-offset: 2px; }

    @container picky (max-width: 480px) {
      .sep { display: none; }
      .text { flex-direction: column; align-items: flex-start; }
    }

    :host([state=hidden]) .card { margin: 4px 0; min-height: 52px; }
    :host([state=hidden][shape=tile]) .card,
    :host([state=hidden][shape=short]) .card { flex-direction: column; justify-content: center; text-align: center; gap: 8px;
      margin: 0; aspect-ratio: 16 / 9; height: var(--picky-h, auto); }
    :host([state=hidden][shape=short]) .card { aspect-ratio: 9 / 16; }
    :host([state=hidden][sized]) .card { aspect-ratio: auto; width: 100%; } /* height is the item's own */
    :host([state=hidden][shape=tile]) .text,
    :host([state=hidden][shape=short]) .text { flex: none; flex-direction: column; align-items: center; max-width: 100%; }
    :host([state=hidden][shape=tile]) .sep,
    :host([state=hidden][shape=short]) .sep { display: none; }

    :host([state=blurred]) .card { max-width: 100%; background: var(--glass); backdrop-filter: blur(6px);
      box-shadow: 0 6px 24px rgba(27,24,56,.18); }

    :host([state=revealed]) .card { padding: 3px 4px 3px 5px; gap: 6px; font-size: 12px; background: var(--glass);
      box-shadow: 0 2px 10px rgba(27,24,56,.16); }
    :host([state=revealed]) svg { width: 16px; height: 16px; }
    :host([state=revealed]) button { padding: 3px 9px; font-size: 11px; background: transparent; color: var(--ink); border: 1px solid var(--line); }
  `;

  // ---- discovery ----
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        near.add(e.target);
        judge(e.target);
      } else {
        near.delete(e.target);
      }
    }
  }, { rootMargin: '1200px 0px' });

  // Only watch the page while Picky is on for this site: unpicked sites cost nothing.
  let observing = false;
  function observe() {
    if (observing) return;
    observing = true;
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
  }
  function unobserve() {
    if (!observing) return;
    observing = false;
    mo.disconnect();
  }

  function scan() {
    if (!active()) return;
    for (const el of adapter.findItems()) {
      if (tracked.has(el)) continue;
      tracked.add(el);
      io.observe(el);
    }
    for (const el of tracked) {
      if (el.isConnected) continue;
      tracked.delete(el);
      near.delete(el);
      io.unobserve(el);
    }
  }

  let scanTimer = null;
  function scanSoon() {
    scanTimer ??= setTimeout(() => {
      scanTimer = null;
      scan();
    }, adapter === PickyAdapters.youtube ? 200 : 700);
  }

  function trackedItemOf(node) {
    if (adapter.itemOf) return adapter.itemOf(node);
    for (let n = node.nodeType === 1 ? node : node.parentElement; n && n !== document.body; n = n.parentElement) {
      if (tracked.has(n)) return n;
    }
    return null;
  }

  // Node contents change under us (recycling, lazy titles): re-judge when the content key changes.
  const dirty = new Set();
  let flushTimer = null;
  const mo = new MutationObserver((records) => {
    if (!alive()) return teardown();
    if (!active()) return;
    let added = false;
    for (const r of records) {
      if (r.type === 'childList' && r.addedNodes.length) added = true;
      const item = trackedItemOf(r.target);
      if (item) dirty.add(item);
    }
    if (added) scanSoon();
    flushTimer ??= setTimeout(flush, 60);
  });

  function flush() {
    flushTimer = null;
    for (const el of dirty) {
      if (!tracked.has(el)) continue;
      const key = adapter.key(el) || '';
      if (key !== el.dataset.pickyKey) {
        clear(el);
        judge(el);
      } else if (el.dataset.pickyWaiting === '1') {
        judge(el);
      } else if (el.matches('.picky-hidden, .picky-blurred, .picky-revealed') && labels.get(el)?.parentElement !== el) {
        apply(el, key); // the site re-rendered the item and dropped our label
      }
    }
    dirty.clear();
  }

  function teardown() {
    unobserve();
    io.disconnect();
    for (const el of tracked) clear(el);
  }

  // ---- stats for the popup and the toolbar badge ----
  function stats() {
    const f = { judged: 0, hidden: 0, blurred: 0, shown: 0, hiddenBy: {}, offTopicFor: {}, fitBy: {}, withPicture: 0 };
    const bump = (map, rule) => { map[rule.text] = (map[rule.text] || 0) + 1; };
    for (const [key, d] of decisions) {
      f.judged++;
      f[d.state === 'hide' ? 'hidden' : d.state === 'blur' ? 'blurred' : 'shown']++;
      if (d.state === 'hide') bump(d.kind === 'want' ? f.offTopicFor : f.hiddenBy, d.rule);
      if (d.state === 'show' && d.kind === 'want') bump(f.fitBy, d.rule);
      if (seenWithPicture.has(key)) f.withPicture++;
    }
    return {
      hidden: f.hidden, blurred: f.blurred, shown: f.shown, facts: f, page,
      site, siteOn, builtIn: Boolean(builtIn), adapter: adapter.name, active: active(), blocked,
    };
  }
  let statsTimer = null;
  function reportStats() {
    clearTimeout(statsTimer);
    statsTimer = setTimeout(() => {
      if (alive()) chrome.runtime.sendMessage({ type: 'stats', ...stats() }).catch(() => {});
    }, 250);
  }
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'getStats') sendResponse(stats());
  });

  loadSettings();
})();
