// Runs in every frame. Ordinary frames stop at the first line. In an ad frame, the creative goes to Jev
// and its content key is passed up the frame chain to the top page, which takes the answers from the
// service worker (not from this frame) and hides the whole ad slot (content.js).
(() => {
  if (window === top || !PickyAds.isAdFrame()) return;

  const report = (key) => parent.postMessage({ __picky: 'ad-verdict', key }, '*');

  // Ad frames nested in this one report through it.
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m?.__picky !== 'ad-verdict' || typeof m.key !== 'string' || !e.source || e.source === window) return;
    if (e.source.parent === window) report(m.key);
  });

  let lastKey = null;
  let asked = 0; // a creative that keeps changing can't run up the bill
  let timer = null;
  async function check() {
    timer = null;
    if (!chrome.runtime?.id || asked >= 5) return;
    const item = PickyAds.creative();
    if (!item || item.key === lastKey) return;
    // The top page decides whether ads are judged here (site on, rules set, no password field).
    const gate = await chrome.runtime.sendMessage({ type: 'adGate' }).catch(() => null);
    if (!gate?.ok) return;
    lastKey = item.key;
    asked++;
    if (!gate.rules.length) return report(item.key); // only "every ad" rules: being an ad is enough
    const res = await chrome.runtime.sendMessage({ type: 'judge', key: item.key, state: item.state, rules: gate.rules, image: item.image }).catch(() => null);
    if (res?.probs && gate.rules.every((t) => t in res.probs)) report(item.key);
  }
  const soon = (ms) => {
    if (!timer) timer = setTimeout(check, ms); // not reset by every mutation: animated ads never settle
  };

  // Creatives render after load and sometimes change; look again once the frame settles. The document
  // itself is observed: ad scripts often document.open() a frame, which replaces its <html>.
  addEventListener('load', () => soon(300));
  addEventListener('resize', () => soon(400));
  const mo = new MutationObserver(() => soon(700));
  mo.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  setTimeout(() => mo.disconnect(), 20000);
  soon(700);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(changes.rules || changes.enabled || changes.sites || changes.apiKey)) return;
    lastKey = null;
    soon(300);
  });
})();
