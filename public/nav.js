// Shared site header + navigation. If the page already has a #nav-links element
// (the landing/about/demo pages build their own header), this just fills the menu.
// Otherwise it injects a full sticky header — a clickable "Enjeeoh" logo that
// returns home, plus the menu — so every page has navigation and a way back home.
(function () {
  var css = ''
    + '.ej-header{position:sticky;top:0;z-index:50;display:flex;align-items:center;justify-content:space-between;gap:16px;'
    + '  padding:12px 20px;background:color-mix(in srgb,var(--bg,#fff) 86%,transparent);backdrop-filter:saturate(1.2) blur(8px);'
    + '  border-bottom:1px solid var(--line,#ececf4)}'
    + '.ej-brand{font:700 18px "Space Grotesk",Inter,sans-serif;color:var(--ink,#15162a);text-decoration:none;letter-spacing:-.01em}'
    + '.ej-brand:hover{color:var(--accent,#0F9D7A)}'
    + '.nav{position:relative}'
    + '#nav-links{display:flex;align-items:center;gap:22px}'
    + '#nav-links a{white-space:nowrap;text-decoration:none;color:var(--ink,#15162a);font:600 14px Inter}'
    + '#nav-links a:hover{color:var(--accent,#0F9D7A)}'
    + '.nav-toggle{display:none;background:none;border:0;cursor:pointer;padding:8px;color:inherit}'
    + '.nav-toggle span{display:block;width:22px;height:2px;background:currentColor;margin:4px 0;border-radius:2px;transition:.2s}'
    + '@media (max-width:680px){'
    + '  .nav-toggle{display:block}'
    + '  #nav-links{position:absolute;top:calc(100% + 6px);right:0;flex-direction:column;align-items:flex-start;gap:0;'
    + '    background:var(--card,#fff);border:1px solid var(--line,#ececf4);border-radius:12px;padding:8px;min-width:170px;'
    + '    box-shadow:0 16px 34px rgba(10,12,30,.16);display:none;z-index:60}'
    + '  #nav-links.open{display:flex}'
    + '  #nav-links a{padding:11px 12px;width:100%;border-radius:8px}'
    + '}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  function mount() {
    var wrap = document.getElementById('nav-links');
    // No header on this page → inject one with a home logo.
    if (!wrap) {
      var header = document.createElement('header'); header.className = 'ej-header';
      header.innerHTML = '<a class="ej-brand" href="/" aria-label="Enjeeoh home">Enjeeoh</a><nav class="nav"><div id="nav-links"></div></nav>';
      document.body.insertBefore(header, document.body.firstChild);
      wrap = document.getElementById('nav-links');
    }
    var nav = wrap.closest('.nav') || wrap.parentNode;

    var tog = document.createElement('button');
    tog.className = 'nav-toggle'; tog.setAttribute('aria-label', 'Menu');
    tog.innerHTML = '<span></span><span></span><span></span>';
    tog.onclick = function () { wrap.classList.toggle('open'); };
    nav.appendChild(tog);

    var DEFAULT = [
      { label: 'Demo', href: '/demo' }, { label: 'About', href: '/about' },
      { label: 'Support', href: '/donate' }, { label: 'Apply', href: '/signup' }, { label: 'Sign in', href: '/admin' }
    ];
    function esc(s) { var d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
    function render(items) {
      wrap.innerHTML = items.filter(function (i) { return i && !i.hidden; })
        .map(function (i) { return '<a href="' + esc(i.href) + '">' + esc(i.label) + '</a>'; }).join('');
    }
    fetch('/api/nav').then(function (r) { return r.json(); })
      .then(function (items) { render(Array.isArray(items) && items.length ? items : DEFAULT); })
      .catch(function () { render(DEFAULT); });
  }

  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();
