// In-place visual editor for marketing pages. Include with:
//   <script src="/site-edit.js" data-page="about"></script>
// Any element with a data-edit="key" attribute becomes editable for a signed-in
// content manager or super admin, and the saved text is shown to all visitors.
(function () {
  var script = document.currentScript;
  var page = script && script.getAttribute('data-page');
  if (!page) return;
  var EP = '/api/page/' + page;
  var editing = false;
  var loggedIn = false; // resolved from the server (httpOnly cookie), not readable JS
  // The editing bar only appears when the page is opened in edit mode (?edit=1),
  // which the console does inside its preview iframe. On the public site there is
  // no floating button — but saved content is still applied below.
  var EDIT_MODE = new URLSearchParams(location.search).get('edit') === '1';
  function getCsrf() { var m = document.cookie.match(/(?:^|; )csrf=([^;]+)/); return m ? decodeURIComponent(m[1]) : ''; }
  function nodes() { return document.querySelectorAll('[data-edit]'); }

  function applyOverrides(cfg) {
    if (!cfg) return;
    nodes().forEach(function (el) {
      var k = el.getAttribute('data-edit');
      if (typeof cfg[k] === 'string' && cfg[k].length) el.innerHTML = cfg[k];
    });
  }
  function gather() {
    var o = {};
    nodes().forEach(function (el) { o[el.getAttribute('data-edit')] = el.innerHTML.trim(); });
    return o;
  }

  fetch(EP).then(function (r) { return r.json(); }).then(applyOverrides).catch(function () {});

  var bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:9999;display:flex;gap:8px;font-family:Inter,system-ui,sans-serif';

  function mkBtn(label, primary) {
    var b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'border:0;border-radius:10px;padding:10px 16px;font:600 13px Inter,sans-serif;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.18);' +
      (primary ? 'background:#0F9D7A;color:#fff' : 'background:#fff;color:#15162A;border:1px solid #e5e7eb');
    return b;
  }
  function toast(msg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;bottom:74px;transform:translateX(-50%);background:#15162A;color:#fff;padding:10px 18px;border-radius:10px;font:600 13px Inter,sans-serif;z-index:10000';
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 1800);
  }
  function renderBar() {
    bar.innerHTML = '';
    if (!loggedIn) { var a = mkBtn('Admin'); a.onclick = login; bar.appendChild(a); return; }
    if (!editing) { var e = mkBtn('Edit page', true); e.onclick = function () { setEditing(true); }; bar.appendChild(e); return; }
    var s = mkBtn('Save and publish', true); s.onclick = save;
    var d = mkBtn('Done'); d.onclick = function () { setEditing(false); };
    bar.appendChild(s); bar.appendChild(d);
  }
  function setEditing(on) {
    editing = on;
    nodes().forEach(function (el) {
      el.setAttribute('contenteditable', on ? 'true' : 'false');
      el.style.outline = on ? '1px dashed rgba(15,157,122,.6)' : '';
      el.style.outlineOffset = on ? '3px' : '';
      el.style.borderRadius = '4px';
    });
    renderBar();
  }
  function save() {
    fetch(EP, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrf() }, credentials: 'same-origin', body: JSON.stringify({ fields: gather() }) })
      .then(function (r) { if (r.status === 401 || r.status === 403) { loggedIn = false; toast('Sign in as a content admin to save'); login(); throw 0; } return r.json(); })
      .then(function () { toast('Saved and published'); setEditing(false); })
      .catch(function () {});
  }
  function login() {
    var email = prompt('Console email'); if (!email) return;
    var pass = prompt('Password'); if (!pass) return;
    fetch('/api/console/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ email: email, password: pass }) })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || 'Login failed'); return d; }); })
      .then(function () { loggedIn = true; toast('Signed in. Click Edit page.'); renderBar(); }) // cookie set by login
      .catch(function (e) { toast(e.message); });
  }
  function mount() {
    if (!EDIT_MODE) return; // no floating editor on the public site
    document.body.appendChild(bar); renderBar();
    fetch('/api/console/me', { credentials: 'same-origin' }).then(function (r) { loggedIn = r.ok; renderBar(); }).catch(function () {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
