// Shared site navigation: renders the menu from /api/nav, spaces it properly,
// hides items flagged hidden, and collapses into a toggle on small screens.
(function () {
  var css = ''
    + '.nav{position:relative}'
    + '#nav-links{display:flex;align-items:center;gap:22px}'
    + '#nav-links a{white-space:nowrap;text-decoration:none}'
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

  var wrap = document.getElementById('nav-links');
  if (!wrap) return;
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
})();
