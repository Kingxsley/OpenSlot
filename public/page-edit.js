// Shared inline editor for content pages. A page sets window.__PAGE_KEY__ and
// marks editable text with data-edit="fieldName". Saved overrides render for
// everyone; a signed-in content manager or super admin can edit in place.
(function () {
  var KEY = window.__PAGE_KEY__;
  if (!KEY) return;
  function getCsrf() { var m = document.cookie.match(/(?:^|; )csrf=([^;]+)/); return m ? decodeURIComponent(m[1]) : ''; }
  var editing = false;
  // The floating editor only appears in edit mode (?edit=1), which the console
  // uses inside its preview iframe. Public visitors never see a button.
  var EDIT_MODE = new URLSearchParams(location.search).get('edit') === '1';

  // Apply any saved overrides so the public sees edited content.
  fetch('/api/page/' + KEY).then(function (r) { return r.json(); }).then(function (cfg) {
    document.querySelectorAll('[data-edit]').forEach(function (el) {
      var k = el.getAttribute('data-edit');
      if (cfg && cfg[k] != null) el.innerHTML = cfg[k];
    });
  }).catch(function () {});

  if (!EDIT_MODE) return; // no floating editor on the public site

  // Floating control.
  var bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:9999;display:flex;gap:8px;font-family:Inter,system-ui,sans-serif';
  document.body.appendChild(bar);
  function btn(label, primary) {
    var b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'border:0;border-radius:10px;padding:10px 16px;font:600 13px Inter,sans-serif;cursor:pointer;box-shadow:0 6px 18px rgba(10,12,30,.18);' + (primary ? 'background:#0F9D7A;color:#fff' : 'background:#fff;color:#15162A;border:1px solid #e7e8f0');
    return b;
  }
  var editBtn = btn('Edit page');
  bar.appendChild(editBtn);

  function setEditing(on) {
    editing = on;
    document.querySelectorAll('[data-edit]').forEach(function (el) {
      el.setAttribute('contenteditable', on ? 'true' : 'false');
      el.style.outline = on ? '1px dashed rgba(15,157,122,.5)' : '';
      el.style.borderRadius = '4px';
    });
    bar.innerHTML = '';
    if (on) {
      var save = btn('Save and publish', true), cancel = btn('Done');
      bar.appendChild(save); bar.appendChild(cancel);
      save.onclick = doSave; cancel.onclick = function () { setEditing(false); bar.appendChild(editBtn); };
    } else { bar.appendChild(editBtn); }
  }

  function doSave() {
    var fields = {};
    document.querySelectorAll('[data-edit]').forEach(function (el) { fields[el.getAttribute('data-edit')] = el.innerHTML.trim(); });
    fetch('/api/page/' + KEY, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrf() }, credentials: 'same-origin', body: JSON.stringify({ fields: fields }) })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || 'Save failed'); }); })
      .then(function () { toast('Saved and published'); setEditing(false); bar.appendChild(editBtn); })
      .catch(function (e) { toast(e.message); });
  }

  function toast(msg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;bottom:70px;transform:translateX(-50%);background:#15162A;color:#fff;padding:10px 18px;border-radius:10px;font:600 13px Inter,sans-serif;z-index:10000';
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, 1800);
  }

  function showLogin() {
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(8,10,22,.5);z-index:10001;display:flex;align-items:center;justify-content:center';
    ov.innerHTML = '<div style="background:#fff;border-radius:16px;padding:24px;width:340px;font-family:Inter,sans-serif"><h3 style="margin:0 0 12px;font:700 18px Space Grotesk,sans-serif">Sign in to edit</h3><input id="pe-email" type="email" placeholder="Email" style="width:100%;border:1px solid #e7e8f0;border-radius:9px;padding:10px;margin-bottom:10px"><input id="pe-pass" type="password" placeholder="Password" style="width:100%;border:1px solid #e7e8f0;border-radius:9px;padding:10px;margin-bottom:10px"><button id="pe-go" style="width:100%;background:#0F9D7A;color:#fff;border:0;border-radius:10px;padding:11px;font:600 14px Inter,sans-serif;cursor:pointer">Sign in</button><div id="pe-err" style="color:#C0392B;font-size:13px;margin-top:8px;min-height:16px"></div></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove(); });
    ov.querySelector('#pe-go').onclick = function () {
      var err = ov.querySelector('#pe-err'); err.textContent = '';
      fetch('/api/console/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ email: ov.querySelector('#pe-email').value.trim(), password: ov.querySelector('#pe-pass').value }) })
        .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || 'Login failed'); return d; }); })
        .then(function () { ov.remove(); setEditing(true); }) // session cookie set by login
        .catch(function (e) { err.textContent = e.message; });
    };
  }

  // Are we signed in? Ask the server (cookie sent automatically), else prompt login.
  editBtn.onclick = function () {
    fetch('/api/console/me', { credentials: 'same-origin' }).then(function (r) { if (r.ok) setEditing(true); else showLogin(); }).catch(showLogin);
  };
})();
