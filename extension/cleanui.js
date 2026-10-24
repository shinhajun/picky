// Clean feed UI on YouTube: the "Picky removed N videos" pill, the panel listing what was removed, and
// the end-of-feed note when the rules leave nothing nearby. Shadow DOM, styled like the item labels.
// content.js drives it through globalThis.PickyCleanUI.
(() => {
  const MARK = '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="10" fill="#FFD43B"/><path d="M7.2 15.5V8.4a3 3 0 1 1 3 3H7.2" fill="none" stroke="#1B1838" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const TOKENS = `
    :host { all: initial; --surface: #FFFFFF; --wash: #F4F3FA; --ink: #1B1838; --muted: #6B6886; --line: #E1DFEC;
      --avoid-bg: #FCE7EA; --avoid-fg: #B4232C; --want-bg: #DDF3E9; --want-fg: #0B6B47; --btn: #1B1838; --btn-fg: #FFFFFF;
      --shadow: 0 10px 30px rgba(27,24,56,.18);
      font: 500 13px/1.4 Roboto, system-ui, -apple-system, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif; color: var(--ink); }
    :host([theme=dark]) { --surface: #1E1C31; --wash: #26243B; --ink: #F1EFFA; --muted: #A6A3BF; --line: #34314F;
      --avoid-bg: rgba(229,72,77,.2); --avoid-fg: #FF9EA4; --want-bg: rgba(16,185,129,.2); --want-fg: #7DE8BF;
      --btn: #F1EFFA; --btn-fg: #1B1838; --shadow: 0 10px 30px rgba(0,0,0,.5); }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    svg { width: 18px; height: 18px; flex: none; }
    button { font: inherit; color: inherit; cursor: pointer; }
    button:focus-visible, a:focus-visible { outline: 2px solid #FFD43B; outline-offset: 2px; }
    .rule { padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%;
      background: var(--avoid-bg); color: var(--avoid-fg); }
    .rule.want { background: var(--want-bg); color: var(--want-fg); }
    .muted { color: var(--muted); }
    @media (prefers-reduced-motion: no-preference) { .pop { animation: pop .14s ease-out; } }
    @keyframes pop { from { opacity: 0; transform: translateY(6px); } }
  `;

  // ---- pill + panel ----
  const PANEL_CSS = `${TOKENS}
    .pill { position: fixed; left: 16px; bottom: 16px; z-index: 2147483000;
      display: inline-flex; align-items: center; gap: 8px; padding: 7px 14px 7px 8px; border-radius: 999px;
      border: 1px solid var(--line); background: var(--surface); box-shadow: var(--shadow); font-weight: 600; }
    .pill:hover { background: var(--wash); }
    .panel { position: fixed; left: 16px; bottom: 64px; z-index: 2147483001; width: min(380px, calc(100vw - 32px));
      max-height: calc(100vh - 140px); display: flex; flex-direction: column; border-radius: 14px;
      border: 1px solid var(--line); background: var(--surface); box-shadow: var(--shadow); }
    .head { display: flex; align-items: center; gap: 8px; padding: 12px 10px 10px 14px; border-bottom: 1px solid var(--line); }
    .head h2 { margin: 0; flex: 1; font-size: 14px; font-weight: 700; }
    .close { border: 0; background: transparent; width: 28px; height: 28px; border-radius: 8px; font-size: 18px; line-height: 1; color: var(--muted); }
    .close:hover { background: var(--wash); color: var(--ink); }
    ol { list-style: none; margin: 0; padding: 4px 0; overflow: auto; }
    li { padding: 9px 14px; border-bottom: 1px solid var(--line); }
    li:last-child { border-bottom: 0; }
    li a { color: var(--ink); font-weight: 600; text-decoration: none; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .row-top { display: flex; align-items: flex-start; gap: 10px; }
    .row-top a { flex: 1; min-width: 0; }
    .toggle { flex: none; border: 1px solid var(--line); background: transparent; border-radius: 999px; padding: 3px 10px; font-size: 12px; font-weight: 600; }
    .toggle:hover { background: var(--wash); }
    li a:hover { text-decoration: underline; text-decoration-color: #FFD43B; text-decoration-thickness: 2px; text-underline-offset: 3px; }
    .meta { display: flex; align-items: center; gap: 6px; margin-top: 4px; min-width: 0; font-size: 12px; }
    .meta .channel { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .score { font-variant-numeric: tabular-nums; }
    .foot { margin: 0; padding: 10px 14px 12px; border-top: 1px solid var(--line); font-size: 12px; }
  `;
  let host = null;
  let state = { items: [], dark: false, open: false, onToggle: null };

  function ensureHost() {
    if (host?.isConnected) return host.shadowRoot;
    host = document.createElement('div');
    host.className = 'picky-clean-ui';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${PANEL_CSS}</style>
      <button class="pill pop" type="button" aria-expanded="false" hidden></button>
      <section class="panel pop" role="dialog" aria-label="Videos Picky removed" hidden>
        <div class="head">${MARK}<h2></h2><button class="close" type="button" aria-label="Close">×</button></div>
        <ol></ol>
        <p class="foot muted">Most never reached the page. Use Show to unfold one that did, or turn off Clean feed in the Picky popup.</p>
      </section>`;
    root.querySelector('.pill').onclick = () => setOpen(!state.open);
    root.querySelector('.close').onclick = () => setOpen(false);
    for (const t of ['click', 'mousedown', 'pointerdown', 'keydown']) host.addEventListener(t, (e) => e.stopPropagation());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.open) setOpen(false);
    });
    (document.body || document.documentElement).append(host);
    return root;
  }

  function setOpen(open) {
    state.open = open;
    render();
  }

  const label = (n) => `Picky removed ${n} ${n === 1 ? 'video' : 'videos'}`;

  function render() {
    if (!state.items.length && !host) return;
    const root = ensureHost();
    host.setAttribute('theme', state.dark ? 'dark' : 'light');
    const pill = root.querySelector('.pill');
    const panel = root.querySelector('.panel');
    pill.hidden = !state.items.length;
    pill.innerHTML = `${MARK}<span></span>`;
    pill.querySelector('span').textContent = label(state.items.length);
    pill.setAttribute('aria-expanded', String(state.open));
    panel.hidden = !state.open || !state.items.length;
    if (panel.hidden) return;
    panel.querySelector('h2').textContent = label(state.items.length);
    panel.querySelector('ol').replaceChildren(...[...state.items].reverse().map((it) => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = it.url;
      a.textContent = it.title || it.url;
      const meta = document.createElement('div');
      meta.className = 'meta';
      const chip = document.createElement('span');
      chip.className = it.kind === 'want' ? 'rule want' : 'rule';
      chip.textContent = it.kind === 'want' ? `doesn’t fit ${it.rule}` : it.rule;
      const score = document.createElement('span');
      score.className = 'score muted';
      score.textContent = typeof it.p === 'number' ? it.p.toFixed(2) : '';
      meta.append(chip, score);
      if (it.channel) {
        const ch = document.createElement('span');
        ch.className = 'channel muted';
        ch.textContent = `· ${it.channel}`;
        meta.append(ch);
      }
      const top = document.createElement('div');
      top.className = 'row-top';
      top.append(a);
      if (it.canShow) { // still on the page, folded away: unfold it in place
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'toggle';
        toggle.textContent = it.shown ? 'Hide again' : 'Show';
        toggle.onclick = () => state.onToggle?.(it.key);
        top.append(toggle);
      }
      li.append(top, meta);
      return li;
    }));
  }

  // ---- end-of-feed note ----
  const NOTE_CSS = `${TOKENS}
    :host { display: block; margin: 16px 0 24px; }
    .note { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 14px 16px; border-radius: 14px;
      border: 1px dashed var(--line); background: var(--wash); }
    .text { flex: 1; min-width: 200px; }
    .text b { display: block; font-size: 14px; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .actions button { border: 0; border-radius: 999px; padding: 7px 14px; font-weight: 600; font-size: 12.5px; }
    .more { background: var(--btn); color: var(--btn-fg); }
    .search { background: transparent; border: 1px solid var(--line) !important; }
    .actions button:hover { opacity: .88; }
  `;
  let note = null;
  let noteArgs = null;

  function showEndNote(args) {
    hideEndNote();
    noteArgs = args;
    placeEndNote();
  }

  // YouTube re-renders the end of the list as responses land; put the note back if it got dropped.
  function placeEndNote() {
    if (!noteArgs || note?.isConnected) return;
    const { title, detail, searchFor, onMore, dark } = noteArgs;
    note = document.createElement('div');
    note.className = 'picky-end-note';
    note.setAttribute('theme', dark ? 'dark' : 'light');
    const root = note.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${NOTE_CSS}</style>
      <div class="note pop" role="status">${MARK}<div class="text"><b></b><span class="muted"></span></div>
        <div class="actions"><button class="more" type="button">Keep looking</button></div></div>`;
    root.querySelector('b').textContent = title;
    root.querySelector('.muted').textContent = detail;
    root.querySelector('.more').onclick = () => {
      hideEndNote();
      onMore();
    };
    if (searchFor) {
      const search = document.createElement('button');
      search.type = 'button';
      search.className = 'search';
      search.textContent = `Search YouTube for ${searchFor}`;
      search.onclick = () => location.assign(`/results?search_query=${encodeURIComponent(searchFor)}`);
      root.querySelector('.actions').append(search);
    }
    for (const t of ['click', 'mousedown', 'pointerdown', 'keydown']) note.addEventListener(t, (e) => e.stopPropagation());
    // At the end of the feed: right after the list that holds YouTube's "load more" marker (YouTube
    // re-renders inside that list, not around it); floating if there is no marker.
    const marker = [...document.querySelectorAll('ytd-continuation-item-renderer')].filter((el) => el.getClientRects().length).pop();
    if (marker) {
      (marker.closest('#contents') || marker).after(note);
    } else {
      note.style.cssText = 'position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:2147483000;width:min(560px,calc(100vw - 32px))';
      (document.body || document.documentElement).append(note);
    }
  }

  function hideEndNote() {
    noteArgs = null;
    note?.remove();
    note = null;
  }

  globalThis.PickyCleanUI = {
    setRemoved(items, dark, onToggle) {
      state = { ...state, items, dark, onToggle };
      if (!items.length) state.open = false;
      render();
    },
    showEndNote,
    hideEndNote,
    placeEndNote,
  };
})();
