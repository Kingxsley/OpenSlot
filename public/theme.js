// Shared theming: makes every public page follow the theme, accent and colours
// set on the landing page (via the console). Apply this on all marketing/auth/legal
// pages so the whole site stays visually consistent. Booking pages keep their own
// per-organisation brand colour and should NOT include this script.
(function () {
  // One set of dark-mode variables that covers every page's CSS variable names
  // (--bg/--fg/--ink/--card/--line/--muted/--soft/--shadow). Injected once.
  var css = '.dark{--bg:#0C0D17;--fg:#F3F4FB;--ink:#F3F4FB;--muted:#9DA1B8;--card:#16182A;--line:#242639;--soft:#1B1D2E;--shadow:0 24px 60px rgba(0,0,0,.5)}';
  var st = document.createElement('style'); st.textContent = css;
  (document.head || document.documentElement).appendChild(st);

  function apply(t) {
    if (!t) return;
    var root = document.documentElement;
    if (t.accent) { root.style.setProperty('--accent', t.accent); root.style.setProperty('--accent2', t.accent2 || t.accent); }
    var dark = t.theme === 'dark';
    root.classList.toggle('dark', dark);
    if (document.body) document.body.classList.toggle('dark', dark);
  }

  // Apply the last known theme instantly (from cache) to avoid a light/dark flash,
  // then refresh from the server.
  try { apply(JSON.parse(localStorage.getItem('enjeeoh_theme') || 'null')); } catch (e) {}
  document.addEventListener('DOMContentLoaded', function () { try { apply(JSON.parse(localStorage.getItem('enjeeoh_theme') || 'null')); } catch (e) {} });

  fetch('/api/landing').then(function (r) { return r.json(); }).then(function (l) {
    var t = { accent: l.accent, accent2: l.accent2, theme: l.theme };
    try { localStorage.setItem('enjeeoh_theme', JSON.stringify(t)); } catch (e) {}
    apply(t);
  }).catch(function () {});
})();
