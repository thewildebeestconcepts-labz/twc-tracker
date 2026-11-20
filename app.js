/* =====================================================================
 *  TWC Outreach Tracker — split-architecture client (GitHub Pages)
 * ---------------------------------------------------------------------
 *  Mirrors JavaScript.html from the all-in-GAS version, but replaces
 *  every google.script.run call with fetch() to the GAS JSON API.
 *
 *  Sections:
 *    0. State + utils + GAS_API_URL discovery
 *    1. callAPI(action, params, opts) — fetch wrapper
 *    2. Auth (login / change password / logout)
 *    3. App shell rendering per role
 *    4. Navigation
 *    5. Coordinator views: outreaches, registration, personnel
 *    6. Patient queue + per-role capture forms
 *    7. Vital signs form (live BMI)
 *    8. Diagnostic form (unit toggle, fasting/random)
 *    9. Eye check form + Visual Acuity tool
 *         (Fullscreen API + getUserMedia front camera + pinhole
 *          distance math via face-width / 2.6 + Snellen tumbling-E
 *          chart + per-eye line selection + decimal acuity)
 *    10. Dental check form
 *    11. Referral slip + print
 *    12. SuperAdmin: sites, users, audit, executive report
 *    13. PWA: install prompt, SW registration
 *    14. Offline buffering + sync
 *    15. Toasts, validation, init
 *
 *  Author : TWC Labs
 * ===================================================================== */
'use strict';

/* =====================================================================
 *  0. STATE + UTILITIES
 * ===================================================================== */

/**
 * GAS_API_URL — read from <meta name="gas-api-url"> in index.html.
 * Falls back to the constant below if the meta tag is absent or still
 * holds the placeholder value. The deployer MUST edit the meta tag in
 * index.html (or set GAS_API_URL_FALLBACK here) for production.
 */
var GAS_API_URL_FALLBACK = 'https://script.google.com/macros/s/AKfycbxN1kDzI9NhJAryjOlPjxzBzgCoiZKdRE2tsKpwYN_4xShgsBBQ4v4A9xXiusKWU_tPiA/exec';

function resolveGasApiUrl_() {
  var meta = document.querySelector('meta[name="gas-api-url"]');
  if (meta) {
    var v = meta.getAttribute('content') || '';
    if (v && v.indexOf('REPLACE_WITH_') !== 0) return v.replace(/\/+$/, '');
  }
  if (GAS_API_URL_FALLBACK && GAS_API_URL_FALLBACK.indexOf('REPLACE_WITH_') !== 0) {
    return GAS_API_URL_FALLBACK.replace(/\/+$/, '');
  }
  // Last resort: assume the API is served from the same origin (only
  // useful for development on the GAS web app URL itself).
  return '';
}
var GAS_API_URL = resolveGasApiUrl_();

var APP = {
  token: localStorage.getItem('twc_token') || null,
  user:  null,
  boot:  null,
  outreaches: [],
  sites: [],
  currentOutreachId: null,
  currentPatientId: null,
  queueTimer: null,
  vaState: null,        // visual acuity tool state
  deferredInstall: null
};

/** Shortcut: querySelector */
function $(sel, ctx) { return (ctx || document).querySelector(sel); }
/** Shortcut: querySelectorAll -> array */
function $$(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }
/** Shortcut: createElement with class & text */
function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
/** Escape HTML to prevent XSS when injecting server data into innerHTML. */
function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, function (c) {
    return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c];
  });
}
function fmtDate(d) {
  if (!d) return '—';
  var date = new Date(d);
  if (isNaN(date.getTime())) return String(d);
  return date.toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' });
}
function fmtDateTime(d) {
  if (!d) return '—';
  var date = new Date(d);
  if (isNaN(date.getTime())) return String(d);
  return date.toLocaleString();
}

/* =====================================================================
 *  1. callAPI — fetch() wrapper for the GAS JSON API
 * ---------------------------------------------------------------------
 *  Convention (matches api/Code.gs):
 *    GET  for read-only actions: URL only, token on query string.
 *    POST for writes: body is JSON.stringify(params) sent with
 *         Content-Type: text/plain. (This avoids a CORS preflight —
 *         application/json would trigger OPTIONS, which GAS web apps
 *         do NOT support.)
 *
 *  Signature:
 *    callAPI('login', { email, password }, { method:'POST' })
 *
 *  Returns a Promise that resolves with the parsed JSON response object.
 *  On network/HTTP error, rejects with { error:String, network:true }.
 *  On 401-style UNAUTHORIZED from the server, also clears the stored
 *  token and reloads to the login view.
 * ===================================================================== */
function callAPI(action, params, opts) {
  params = params || {};
  opts = opts || {};

  var method = (opts.method || 'GET').toUpperCase();
  var token = APP.token || '';
  var url = GAS_API_URL + '?action=' + encodeURIComponent(action) +
            (token ? '&token=' + encodeURIComponent(token) : '');

  var fetchOpts = {
    method: method,
    // Always use CORS-mode 'cors' so the browser sends the Origin header.
    mode: 'cors',
    // 'include' would require cookies; we use token-based auth so
    // 'same-origin' (the default) is fine for credentials on the
    // request side. We do not need cookies.
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'follow'
  };

  if (method === 'POST') {
    // Body is sent as text/plain to keep this a "simple" request (no
    // CORS preflight). The server parses it as JSON via
    // e.postData.contents.
    fetchOpts.headers = { 'Content-Type': 'text/plain;charset=utf-8' };
    fetchOpts.body = JSON.stringify(params || {});
  } else {
    // For GET, we optionally append a few scalar params onto the URL
    // (helps when the server expects them in e.parameter rather than
    // the body).
    var extra = [];
    Object.keys(params).forEach(function (k) {
      var v = params[k];
      if (v === undefined || v === null) return;
      if (typeof v === 'object') return; // skip structured params on GET
      extra.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    });
    if (extra.length) url += '&' + extra.join('&');
  }

  return fetch(url, fetchOpts).then(function (resp) {
    // GAS ContentService always returns 200 even for app-level errors;
    // the real status rides inside the JSON body. But we still check.
    return resp.text().then(function (txt) {
      var data;
      try { data = txt ? JSON.parse(txt) : {}; }
      catch (e) { data = { error: 'INVALID_RESPONSE', message: txt.substring(0, 500) }; }

      // Auto-handle auth expiry: clear token + force re-login.
      if (data && data.error === 'UNAUTHORIZED') {
        APP.token = null;
        localStorage.removeItem('twc_token');
        if (typeof showLogin === 'function') showLogin();
      }
      return data;
    });
  }).catch(function (networkErr) {
    return { error: 'NETWORK', message: String(networkErr.message || networkErr), network: true };
  });
}

/* =====================================================================
 *  2. AUTH — login, change password, logout, "me"
 * ===================================================================== */
function initAuth() {
  if (!GAS_API_URL) {
    $('#loginError').textContent =
      'No GAS API URL configured. Edit <meta name="gas-api-url"> in index.html.';
    return;
  }

  // If we have a token, verify it via the `me` action; else show login.
  if (APP.token) {
    callAPI('me', {}, { method: 'GET' }).then(function (res) {
      if (res && res.success && res.user) {
        APP.user = res.user;
        if (res.user.mustChangePassword) showChangePw();
        else renderApp(res.user);
      } else {
        // Token invalid/expired — clear and show login
        localStorage.removeItem('twc_token');
        APP.token = null;
        showLogin();
      }
    });
  } else {
    showLogin();
  }

  // Login form submit
  $('#loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var email = $('#loginEmail').value.trim();
    var pw = $('#loginPassword').value;
    $('#loginError').textContent = '';
    $('#loginBtn').disabled = true;
    $('#loginBtn').textContent = 'Signing in…';
    callAPI('login', { email: email, password: pw }, { method: 'POST' }).then(function (res) {
      $('#loginBtn').disabled = false;
      $('#loginBtn').textContent = 'Sign In';
      if (res && res.error) {
        $('#loginError').textContent = res.error;
        return;
      }
      if (res && res.success) {
        APP.token = res.token;
        APP.user = res.user;
        localStorage.setItem('twc_token', res.token);
        if (res.user.mustChangePassword) showChangePw();
        else { hideAuth(); renderApp(res.user); }
      } else {
        $('#loginError').textContent = 'Login failed. Please try again.';
      }
    });
  });

  // Change password form
  $('#changePwForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var cur = $('#curPw').value;
    var np  = $('#newPw').value;
    var np2 = $('#newPw2').value;
    $('#changePwError').textContent = '';
    if (np !== np2) { $('#changePwError').textContent = 'Passwords do not match.'; return; }
    if (np.length < 8) { $('#changePwError').textContent = 'New password must be at least 8 characters.'; return; }
    callAPI('changePassword',
            { currentPassword: cur, newPassword: np },
            { method: 'POST' }).then(function (res) {
      if (res && res.error) { $('#changePwError').textContent = res.error; return; }
      APP.user.mustChangePassword = false;
      toast('Password updated.', 'success');
      hideAuth();
      renderApp(APP.user);
    });
  });

  // Logout button
  $('#logoutBtn').addEventListener('click', function () {
    callAPI('logout', {}, { method: 'POST' }).then(function () {
      localStorage.removeItem('twc_token');
      APP.token = null; APP.user = null;
      location.reload();
    });
  });
}

function showLogin() {
  $('#authView').classList.remove('hidden');
  $('#appView').classList.add('hidden');
  $('#loginCard').classList.remove('hidden');
  $('#changePwCard').classList.add('hidden');
}
function showChangePw() {
  $('#authView').classList.remove('hidden');
  $('#appView').classList.add('hidden');
  $('#loginCard').classList.add('hidden');
  $('#changePwCard').classList.remove('hidden');
}
function hideAuth() {
  $('#authView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
}

/* =====================================================================
 *  3. APP SHELL RENDERING PER ROLE
 * ===================================================================== */
function renderApp(user) {
  hideAuth();
  APP.user = user;
  $('#userName').textContent = user.fullName || user.email;
  $('#userAvatar').textContent = (user.fullName || user.email || 'U').charAt(0).toUpperCase();
  $('#sidebarRole').textContent = user.role;
  $('#dashName').textContent = user.fullName || 'User';

  var navItems = navForRole_(user.role);
  renderSidebar_(navItems);
  renderTabbar_(navItems);

  // Boot + initial data
  Promise.all([
    callAPI('getSites', {}, { method: 'GET' }).catch(function () { return { data: [] }; }),
    callAPI('getOutreaches', {}, { method: 'GET' }).catch(function () { return { data: [] }; })
  ]).then(function (results) {
    APP.sites = (results[0] && results[0].data) || [];
    APP.outreaches = (results[1] && results[1].data) || [];
    populateSiteDropdowns_();
    populateOutreachDropdowns_();
    navigate(navItems[0].id);
    hideLoading();
  }).catch(function (err) {
    showError('Failed to load', (err && err.error) || 'Unknown error');
  });
}

function navForRole_(role) {
  var map = {
    'SuperAdmin': [
      { id: 'view-dashboard',   label: 'Dashboard', icon: '🏠' },
      { id: 'view-sites',       label: 'Sites',     icon: '📍' },
      { id: 'view-users',       label: 'Users',     icon: '👥' },
      { id: 'view-outreaches',  label: 'Outreaches',icon: '📅' },
      { id: 'view-registration',label: 'Register',  icon: '➕' },
      { id: 'view-personnel',   label: 'Personnel', icon: '✉️' },
      { id: 'view-referral',    label: 'Referrals', icon: '📤' },
      { id: 'view-report',      label: 'Reports',   icon: '📊' },
      { id: 'view-audit',       label: 'Audit',     icon: '📜' }
    ],
    'Coordinator': [
      { id: 'view-dashboard',    label: 'Dashboard',  icon: '🏠' },
      { id: 'view-outreaches',   label: 'Outreaches', icon: '📅' },
      { id: 'view-registration', label: 'Register',   icon: '➕' },
      { id: 'view-personnel',    label: 'Personnel',  icon: '✉️' },
      { id: 'view-referral',     label: 'Referrals',  icon: '📤' },
      { id: 'view-report',       label: 'Reports',    icon: '📊' }
    ],
    'Nurse':         [ { id:'view-queue', label:'Queue',    icon:'❤️' }, { id:'view-referral', label:'Referrals', icon:'📤' } ],
    'LabTechnician': [ { id:'view-queue', label:'Queue',    icon:'🧪' }, { id:'view-referral', label:'Referrals', icon:'📤' } ],
    'Optometrist':   [ { id:'view-queue', label:'Queue',    icon:'👁️' }, { id:'view-referral', label:'Referrals', icon:'📤' } ],
    'Dentist':       [ { id:'view-queue', label:'Queue',    icon:'🦷' }, { id:'view-referral', label:'Referrals', icon:'📤' } ]
  };
  return map[role] || [];
}

function renderSidebar_(items) {
  var host = $('#sidebarNav');
  host.innerHTML = '';
  items.forEach(function (it) {
    var a = el('a', 'nav-item' + (it.id === 'view-dashboard' ? ' active' : ''));
    a.dataset.view = it.id;
    a.innerHTML = '<span class="icon">' + it.icon + '</span><span>' + it.label + '</span>';
    a.addEventListener('click', function () { navigate(it.id); });
    host.appendChild(a);
  });
}
function renderTabbar_(items) {
  var tb = $('#tabbar');
  tb.innerHTML = '';
  // Show only top 5 on tabbar (mobile); rest accessible via Dashboard.
  var top = items.slice(0, 5);
  top.forEach(function (it) {
    var b = el('button', 'tab');
    b.dataset.view = it.id;
    b.innerHTML = '<span class="icon">' + it.icon + '</span><span>' + it.label + '</span>';
    b.addEventListener('click', function () { navigate(it.id); });
    tb.appendChild(b);
  });
}

/* =====================================================================
 *  4. NAVIGATION
 * ===================================================================== */
function navigate(viewId) {
  $$('.view').forEach(function (v) { v.classList.add('hidden'); });
  var target = document.getElementById(viewId);
  if (!target) {
    showError('View not found', 'No view "' + viewId + '" available for your role.');
    return;
  }
  target.classList.remove('hidden');

  $$('.nav-item, .tab').forEach(function (n) {
    if (n.dataset.view === viewId) n.classList.add('active');
    else n.classList.remove('active');
  });

  // Per-view post-render hooks
  if (viewId === 'view-dashboard')    renderDashboard_();
  if (viewId === 'view-outreaches')   renderOutreachList_();
  if (viewId === 'view-registration') hookRegistrationForm_();
  if (viewId === 'view-queue')        hookQueueView_();
  if (viewId === 'view-personnel')    renderInvitesList_();
  if (viewId === 'view-referral')     hookReferralForm_();
  if (viewId === 'view-sites')        renderSitesList_();
  if (viewId === 'view-users')        renderUsersList_();
  if (viewId === 'view-audit')        renderAuditList_();
  if (viewId === 'view-report')       hookReportView_();

  window.scrollTo(0, 0);
}

function hideLoading() { $('#loadingView').classList.add('hidden'); }
function showError(title, msg) {
  $('#errTitle').textContent = title || 'Error';
  $('#errMsg').textContent = msg || '';
  $('#errorView').classList.remove('hidden');
}

/* =====================================================================
 *  5. COORDINATOR / SUPERADMIN — OUTREACHES + REGISTRATION + PERSONNEL
 * ===================================================================== */
function populateOutreachDropdowns_() {
  var html = '<option value="">— Select Outreach —</option>' +
    APP.outreaches.map(function (o) {
      return '<option value="' + o.OutreachID + '">' + esc(o.Name) + ' (' + fmtDate(o.Date) + ')</option>';
    }).join('');
  ['#pOutreach','#invOutreach','#repOutreach','#queueOutreach'].forEach(function (sel) {
    var n = $(sel); if (n) n.innerHTML = html;
  });
  // Auto-select the first Active outreach
  var active = APP.outreaches.filter(function (o) { return o.Status === 'Active'; });
  if (active.length) {
    APP.currentOutreachId = active[0].OutreachID;
    ['#pOutreach','#invOutreach','#repOutreach','#queueOutreach'].forEach(function (sel) {
      var n = $(sel); if (n) n.value = APP.currentOutreachId;
    });
    if ($('#dashOutreach')) $('#dashOutreach').textContent = active[0].Name;
  }
}

function populateSiteDropdowns_() {
  var html = '<option value="">— Select Site —</option>' +
    APP.sites.map(function (s) { return '<option value="' + s.SiteID + '">' + esc(s.Name) + '</option>'; }).join('');
  ['#oSite'].forEach(function (sel) {
    var n = $(sel); if (n) n.innerHTML = html;
  });
  if ($('#dashSite')) {
    var mySite = APP.sites.filter(function (s) { return s.SiteID === APP.user.siteId; })[0];
    $('#dashSite').textContent = mySite ? '• ' + mySite.Name : (APP.user.role === 'SuperAdmin' ? '• All sites' : '');
  }
}

/** Outreach form submit + list render */
function hookOutreachForm_() {
  var form = $('#outreachForm');
  if (!form || form.dataset.hooked) return;
  form.dataset.hooked = '1';
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var data = {
      Name: $('#oName').value.trim(),
      Date: $('#oDate').value,
      Venue: $('#oVenue').value.trim(),
      SiteID: $('#oSite').value || APP.user.siteId,
      Status: $('#oStatus').value,
      Personnel: ''
    };
    callAPI('createOutreach', data, { method: 'POST' }).then(function (res) {
      if (res.error) { toast(res.error, 'error'); return; }
      toast('Outreach created.', 'success');
      form.reset();
      // Refresh outreach list
      callAPI('getOutreaches', {}, { method: 'GET' }).then(function (r) {
        if (r && r.data) { APP.outreaches = r.data; populateOutreachDropdowns_(); renderOutreachList_(); }
      });
    });
  });
}

function renderOutreachList_() {
  var tbody = $('#outreachTable tbody');
  if (!tbody) return;
  tbody.innerHTML = APP.outreaches.map(function (o) {
    return '<tr>' +
      '<td>' + esc(o.Name) + '</td>' +
      '<td>' + fmtDate(o.Date) + '</td>' +
      '<td>' + esc(o.Venue || '—') + '</td>' +
      '<td><span class="status-pill ' + (o.Status === 'Active' ? 'done' : 'pending') + '">' + esc(o.Status) + '</span></td>' +
      '<td>' +
        '<button class="btn btn-sm btn-secondary" data-set-active="' + o.OutreachID + '">Set Active</button>' +
      '</td>' +
      '</tr>';
  }).join('');
  // Wire set-active buttons
  tbody.querySelectorAll('[data-set-active]').forEach(function (btn) {
    btn.addEventListener('click', function () { setActiveOutreach(btn.getAttribute('data-set-active')); });
  });
}

/** Set an outreach as Active; others in same site become Planned.
 *  (Simple toggle — server currently doesn't expose a status update
 *  endpoint in the split API; we could extend ROUTES_ to add one. For
 *  now we re-create as Active/Planned directly via the outreach list
 *  — but since there's no update endpoint, we just update the local
 *  list and notify. The full updateOutreachStatus endpoint can be
 *  added to api/Code.gs ROUTES_ if needed.) */
function setActiveOutreach(id) {
  // Optimistic local update + inform the user that backend update
  // requires an additional route. (The split API deliberately keeps
  // the route table minimal; extend it when needed.)
  APP.outreaches.forEach(function (o) {
    if (o.OutreachID === id) o.Status = 'Active';
    else if (o.Status === 'Active') o.Status = 'Planned';
  });
  APP.currentOutreachId = id;
  populateOutreachDropdowns_();
  renderOutreachList_();
  toast('Active outreach updated locally. (Backend status update route can be added to api/Code.gs.)', 'success');
}

/** Registration form: NDPA consent + duplicate name warning + submit */
function hookRegistrationForm_() {
  var form = $('#patientForm');
  if (!form || form.dataset.hooked) return;
  form.dataset.hooked = '1';

  // Duplicate prevention (live)
  $('#pName').addEventListener('blur', function () {
    var name = $('#pName').value.trim().toLowerCase();
    if (!name) { $('#dupWarn').textContent = ''; return; }
    var oid = $('#pOutreach').value;
    if (!oid) return;
    callAPI('getPatients', { outreachId: oid }, { method: 'GET' }).then(function (res) {
      if (res && res.data) {
        var dup = res.data.some(function (p) {
          return String(p.FullName).trim().toLowerCase() === name;
        });
        $('#dupWarn').textContent = dup ? '⚠️ A patient with this name is already registered for this outreach.' : '';
        $('#dupWarn').style.color = dup ? 'var(--twc-red)' : 'var(--twc-green)';
      }
    });
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var consent = $('#pConsent').checked;
    if (!consent) { $('#patientError').textContent = 'NDPA consent is required.'; return; }
    var data = {
      FullName: $('#pName').value.trim(),
      Sex: $('#pSex').value,
      Age: $('#pAge').value || null,
      DOB: $('#pDob').value || null,
      Phone: $('#pPhone').value.trim(),
      Email: $('#pEmail').value.trim(),
      OutreachID: $('#pOutreach').value,
      Consent: true
    };
    $('#patientError').textContent = '';
    $('#patientSubmit').disabled = true;

    // Offline buffering
    if (!navigator.onLine) {
      bufferCapture_({ kind: 'patient',
                      tempId: 'tmp_' + Date.now() + '_' + Math.random().toString(36).slice(2,7),
                      data: data });
      toast('Saved offline. Will sync when back online.', 'warning');
      form.reset();
      $('#patientSubmit').disabled = false;
      return;
    }

    callAPI('registerPatient', data, { method: 'POST' }).then(function (res) {
      $('#patientSubmit').disabled = false;
      if (res.error) { $('#patientError').textContent = res.error; return; }
      toast('Patient registered: ' + res.data.PatientCode, 'success');
      form.reset();
    });
  });
}

/** Personnel invite form */
function hookInviteForm_() {
  var form = $('#inviteForm');
  if (!form || form.dataset.hooked) return;
  form.dataset.hooked = '1';
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var data = {
      email: $('#invEmail').value.trim(),
      fullName: $('#invName').value.trim(),
      role: $('#invRole').value,
      outreachId: $('#invOutreach').value,
      siteId: APP.user.siteId
    };
    callAPI('invitePersonnel', data, { method: 'POST' }).then(function (res) {
      if (res.error) { toast(res.error, 'error'); return; }
      var pw = res.data ? res.data.TempPassword : '';
      toast('Invite sent. Temp password: ' + pw, 'success');
      form.reset();
      renderInvitesList_();
    });
  });
}

function renderInvitesList_() {
  callAPI('getInvites', {}, { method: 'GET' }).then(function (res) {
    if (res.error) { /* swallow — may be forbidden for non-admins */ return; }
    var tbody = $('#invitesTable tbody');
    if (!tbody) return;
    var list = res.data || [];
    tbody.innerHTML = list.map(function (u) {
      return '<tr>' +
        '<td>' + esc(u.Email) + '</td>' +
        '<td><span class="badge badge-' + String(u.Role).toLowerCase() + '">' + esc(u.Role) + '</span></td>' +
        '<td>' + esc(u.TempPassword || '—') + '</td>' +
        '<td>' + esc(u.Status || '—') + '</td>' +
        '<td>' + fmtDate(u.CreatedAt) + '</td>' +
      '</tr>';
    }).join('');
  });
}

/* =====================================================================
 *  6. PATIENT QUEUE — per role with capture forms
 * ===================================================================== */
function hookQueueView_() {
  var sel = $('#queueOutreach');
  if (!sel) return;
  var roleFormMap = {
    'Nurse':         'Vital Signs',
    'LabTechnician': 'Diagnostics',
    'Optometrist':   'Eye Check',
    'Dentist':       'Dental Check'
  };
  if ($('#queueRoleHint')) $('#queueRoleHint').textContent = roleFormMap[APP.user.role] || '';

  // Build capture form for role
  var host = $('#captureForms');
  host.innerHTML = '';
  if (APP.user.role === 'Nurse') host.appendChild(buildVitalsForm_());
  if (APP.user.role === 'LabTechnician') host.appendChild(buildDiagnosticForm_());
  if (APP.user.role === 'Optometrist') host.appendChild(buildEyeForm_());
  if (APP.user.role === 'Dentist') host.appendChild(buildDentalForm_());
  if (APP.user.role === 'SuperAdmin' || APP.user.role === 'Coordinator') {
    host.appendChild(buildVitalsForm_());
    host.appendChild(buildDiagnosticForm_());
    host.appendChild(buildEyeForm_());
    host.appendChild(buildDentalForm_());
  }

  // (Re)wire select + refresh (avoid stacking listeners)
  if (!sel.dataset.hooked) {
    sel.dataset.hooked = '1';
    sel.addEventListener('change', function () {
      APP.currentOutreachId = sel.value;
      refreshQueue_();
    });
    $('#queueRefresh').addEventListener('click', refreshQueue_);
  }

  // Auto refresh every 15 seconds
  if (APP.queueTimer) clearInterval(APP.queueTimer);
  APP.queueTimer = setInterval(refreshQueue_, 15000);

  refreshQueue_();
}

function refreshQueue_() {
  var oid = $('#queueOutreach').value || APP.currentOutreachId;
  if (!oid) {
    $('#queueList').innerHTML = '<div class="state"><div class="title">No outreach selected</div><div class="msg">Select an outreach above.</div></div>';
    return;
  }
  $('#queueList').innerHTML = '<div class="state"><div class="spinner"></div></div>';
  callAPI('getPatients', { outreachId: oid }, { method: 'GET' }).then(function (res) {
    if (res.error) { $('#queueList').innerHTML = '<div class="state"><div class="title">' + esc(res.error) + '</div></div>'; return; }
    var list = res.data || [];
    if (!list.length) {
      $('#queueList').innerHTML = '<div class="state"><div class="icon">📋</div><div class="title">No patients yet</div><div class="msg">Coordinator needs to register patients for this outreach.</div></div>';
      return;
    }
    $('#queueList').innerHTML = list.map(function (p) {
      return '<div class="queue-item" data-patient="' + p.PatientID + '">' +
        '<span class="pc">' + esc(p.PatientCode) + '</span>' +
        '<span class="pn">' + esc(p.FullName) + '</span>' +
        '<span class="pm">' + (p.Age || '—') + 'y • ' + esc(p.Sex) + '</span>' +
      '</div>';
    }).join('');
    // Wire patient clicks
    $('#queueList').querySelectorAll('[data-patient]').forEach(function (item) {
      item.addEventListener('click', function () { selectQueuePatient(item.getAttribute('data-patient')); });
    });
  });
}

function selectQueuePatient(pid) {
  APP.currentPatientId = pid;
  toast('Patient selected. Fill the form below.', 'success');
  $$('[data-patient-field]').forEach(function (f) { f.value = pid; });
  var first = $('#captureForms').querySelector('.card');
  if (first) first.scrollIntoView({ behavior: 'smooth' });
}

/* =====================================================================
 *  7. VITAL SIGNS FORM — live BMI auto-calc
 * ===================================================================== */
function buildVitalsForm_() {
  var card = el('div', 'card');
  card.innerHTML =
    '<div class="card-header"><div class="card-title">Vital Signs</div>' +
    '<small class="card-subtitle">Selected patient will be captured here.</small></div>' +
    '<form>' +
      '<div class="field-row">' +
        '<div class="field"><label>BP Systolic (mmHg)</label><input class="vs-sys" type="number" placeholder="120"></div>' +
        '<div class="field"><label>BP Diastolic (mmHg)</label><input class="vs-dia" type="number" placeholder="80"></div>' +
      '</div>' +
      '<div class="field-row">' +
        '<div class="field"><label>Weight (kg)</label><input class="vs-weight" type="number" step="0.1" placeholder="70"></div>' +
        '<div class="field"><label>Height (cm)</label><input class="vs-height" type="number" step="0.1" placeholder="170"></div>' +
        '<div class="field"><label>BMI (auto)</label><input class="vs-bmi" readonly placeholder="—"></div>' +
      '</div>' +
      '<div class="field-row">' +
        '<div class="field"><label>Temperature (°C)</label><input class="vs-temp" type="number" step="0.1" placeholder="36.8"></div>' +
        '<div class="field"><label>SpO₂ (%)</label><input class="vs-spo2" type="number" placeholder="98"></div>' +
        '<div class="field"><label>Pulse (bpm)</label><input class="vs-pulse" type="number" placeholder="72"></div>' +
      '</div>' +
      '<div class="field"><label>Notes</label><textarea class="vs-notes" rows="2"></textarea></div>' +
      '<button class="btn btn-primary vs-submit" type="submit">Save Vitals</button>' +
    '</form>';

  // Use class-based selectors (scoped to card) so multiple vitals cards
  // can coexist without ID collisions.
  var form = card.querySelector('form');
  var w = card.querySelector('.vs-weight');
  var h = card.querySelector('.vs-height');
  var bmi = card.querySelector('.vs-bmi');
  function calcBmi() {
    var weight = parseFloat(w.value);
    var height = parseFloat(h.value) / 100;
    if (weight > 0 && height > 0) {
      bmi.value = (weight / (height * height)).toFixed(1);
    } else { bmi.value = ''; }
  }
  w.addEventListener('input', calcBmi);
  h.addEventListener('input', calcBmi);
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!APP.currentPatientId) { toast('Select a patient from the queue first.', 'warning'); return; }
    var data = {
      PatientID: APP.currentPatientId,
      OutreachID: APP.currentOutreachId,
      BPSystolic: card.querySelector('.vs-sys').value,
      BPDiastolic: card.querySelector('.vs-dia').value,
      WeightKg: card.querySelector('.vs-weight').value,
      HeightCm: card.querySelector('.vs-height').value,
      TempC: card.querySelector('.vs-temp').value,
      SpO2: card.querySelector('.vs-spo2').value,
      Pulse: card.querySelector('.vs-pulse').value,
      BMI: card.querySelector('.vs-bmi').value,
      Notes: card.querySelector('.vs-notes').value
    };
    submitCapture_('saveVitals', 'vitals', data, 'Vital signs saved.', form);
  });
  return card;
}

/* =====================================================================
 *  8. DIAGNOSTIC FORM — unit toggle (mg/dL / mmol/L) + Fasting/Random
 * ===================================================================== */
function buildDiagnosticForm_() {
  var card = el('div', 'card');
  card.innerHTML =
    '<div class="card-header"><div class="card-title">Diagnostics — Blood Sugar</div></div>' +
    '<form>' +
      '<div class="field-row">' +
        '<div class="field"><label>Test Type</label>' +
          '<div class="row">' +
            '<label><input type="radio" name="dt" value="Fasting" checked> Fasting</label>' +
            '<label><input type="radio" name="dt" value="Random"> Random</label>' +
          '</div>' +
        '</div>' +
        '<div class="field"><label>Unit</label>' +
          '<select class="dg-unit"><option>mg/dL</option><option>mmol/L</option></select>' +
        '</div>' +
      '</div>' +
      '<div class="field"><label>Blood Sugar</label><input class="dg-bs" type="number" step="0.1" placeholder="e.g. 95"></div>' +
      '<div class="field"><label>Notes</label><textarea class="dg-notes" rows="2"></textarea></div>' +
      '<button class="btn btn-primary" type="submit">Save Diagnostic</button>' +
    '</form>';
  card.querySelector('form').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!APP.currentPatientId) { toast('Select a patient from the queue first.', 'warning'); return; }
    var tt = card.querySelector('input[name="dt"]:checked').value;
    var data = {
      PatientID: APP.currentPatientId,
      OutreachID: APP.currentOutreachId,
      TestType: tt,
      BloodSugar: card.querySelector('.dg-bs').value,
      Unit: card.querySelector('.dg-unit').value,
      Notes: card.querySelector('.dg-notes').value
    };
    submitCapture_('saveDiagnostic', 'diagnostic', data, 'Diagnostic saved.', e.target);
  });
  return card;
}

/* =====================================================================
 *  9. EYE CHECK FORM + VISUAL ACUITY TOOL
 * ===================================================================== */
function buildEyeForm_() {
  var card = el('div', 'card');
  card.innerHTML =
    '<div class="card-header">' +
      '<div class="card-title">Basic Eye Check</div>' +
      '<button type="button" class="btn btn-sm btn-secondary open-va-tool">👁️ Open Acuity Tool</button>' +
    '</div>' +
    '<form>' +
      '<div class="field-row">' +
        '<div class="field"><label>Right Eye Distance (m)</label><input class="ec-rd" type="number" step="0.01" placeholder="6.0"></div>' +
        '<div class="field"><label>Left Eye Distance (m)</label><input class="ec-ld" type="number" step="0.01" placeholder="6.0"></div>' +
      '</div>' +
      '<div class="field-row">' +
        '<div class="field"><label>Right Snellen Line</label><input class="ec-rl" placeholder="6/6"></div>' +
        '<div class="field"><label>Left Snellen Line</label><input class="ec-ll" placeholder="6/6"></div>' +
      '</div>' +
      '<div class="field-row">' +
        '<div class="field"><label>Right Decimal Acuity</label><input class="ec-rdc" step="0.01" placeholder="1.0"></div>' +
        '<div class="field"><label>Left Decimal Acuity</label><input class="ec-ldc" step="0.01" placeholder="1.0"></div>' +
      '</div>' +
      '<div class="field"><label>Observations</label><textarea class="ec-obs" rows="2"></textarea></div>' +
      '<div class="checkbox"><input class="ec-ref" type="checkbox"><label>Referral needed?</label></div>' +
      '<button class="btn btn-primary" type="submit">Save Eye Check</button>' +
    '</form>';
  card.querySelector('.open-va-tool').addEventListener('click', function () {
    APP.vaEyeForm = card; // remember which eye-form to write back to
    openVaTool();
  });
  card.querySelector('form').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!APP.currentPatientId) { toast('Select a patient from the queue first.', 'warning'); return; }
    var data = {
      PatientID: APP.currentPatientId,
      OutreachID: APP.currentOutreachId,
      VARightDistance: card.querySelector('.ec-rd').value,
      VALeftDistance: card.querySelector('.ec-ld').value,
      VARightLine: card.querySelector('.ec-rl').value,
      VALeftLine: card.querySelector('.ec-ll').value,
      VARightDecimal: card.querySelector('.ec-rdc').value,
      VALeftDecimal: card.querySelector('.ec-ldc').value,
      Observations: card.querySelector('.ec-obs').value,
      ReferralNeeded: card.querySelector('.ec-ref').checked
    };
    submitCapture_('saveEyeCheck', 'eye', data, 'Eye check saved.', e.target);
  });
  return card;
}

/* =====================================================================
 *  10. DENTAL CHECK FORM
 * ===================================================================== */
function buildDentalForm_() {
  var card = el('div', 'card');
  card.innerHTML =
    '<div class="card-header"><div class="card-title">Basic Dental Check</div></div>' +
    '<form>' +
      '<div class="field"><label>Oral Health</label>' +
        '<select class="dc-oral"><option>Good</option><option>Fair</option><option>Poor</option></select>' +
      '</div>' +
      '<div class="field-row">' +
        '<div class="checkbox"><input class="dc-caries" type="checkbox"><label>Caries present?</label></div>' +
        '<div class="checkbox"><input class="dc-ging" type="checkbox"><label>Gingivitis?</label></div>' +
      '</div>' +
      '<div class="field"><label>Missing Teeth (count)</label><input class="dc-missing" type="number" placeholder="0"></div>' +
      '<div class="field"><label>Observations</label><textarea class="dc-obs" rows="2"></textarea></div>' +
      '<div class="checkbox"><input class="dc-ref" type="checkbox"><label>Referral needed?</label></div>' +
      '<button class="btn btn-primary" type="submit">Save Dental Check</button>' +
    '</form>';
  card.querySelector('form').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!APP.currentPatientId) { toast('Select a patient from the queue first.', 'warning'); return; }
    var data = {
      PatientID: APP.currentPatientId,
      OutreachID: APP.currentOutreachId,
      OralHealth: card.querySelector('.dc-oral').value,
      CariesPresent: card.querySelector('.dc-caries').checked,
      Gingivitis: card.querySelector('.dc-ging').checked,
      MissingTeeth: card.querySelector('.dc-missing').value,
      Observations: card.querySelector('.dc-obs').value,
      ReferralNeeded: card.querySelector('.dc-ref').checked
    };
    submitCapture_('saveDentalCheck', 'dental', data, 'Dental check saved.', e.target);
  });
  return card;
}

/* Generic capture submit with offline buffering */
function submitCapture_(action, kind, data, successMsg, form) {
  if (!navigator.onLine) {
    bufferCapture_({
      kind: kind,
      tempId: 'tmp_' + Date.now() + '_' + Math.random().toString(36).slice(2,7),
      data: data
    });
    toast('Saved offline. Will sync when online.', 'warning');
    if (form) form.reset();
    return;
  }
  callAPI(action, data, { method: 'POST' }).then(function (res) {
    if (res.error) { toast(res.error, 'error'); return; }
    toast(successMsg, 'success');
    if (form) form.reset();
  });
}

/* =====================================================================
 *  9b. VISUAL ACUITY TOOL — fullscreen + front camera + IPD math
 *
 *  Math (documented):
 *    distance_mm = (realIPD_mm * focalLengthPx) / ipdPixels
 *
 *  Calibration: we use a manual calibration card (credit-card ~ 85.6mm
 *  wide). User holds the card to the camera at the testing distance; we
 *  measure its pixel width and compute focalLengthPx = cardPx / 85.6.
 *
 *  Auto face-width detection: a brightness heuristic finds the brightest
 *  region in the live video frame as a face proxy. Face width ≈ 2.6 × IPD
 *  on average, so ipdPixels ≈ faceWidthPx / 2.6. Population mean IPD =
 *  63mm (configurable below).
 *
 *  For higher accuracy, drop in face-api.js from CDN and replace
 *  vaDetectLoop_() with a landmark-based IPD extractor (left-eye outer
 *  corner → right-eye outer corner).
 *
 *  Snellen chart lines (6/x meters):
 *    Row 1: 6/60 (largest) … Row 9: 6/4 (very sharp)
 *
 *  Decimal acuity formula:
 *    decimalAcuity = distanceM / denom
 *    snellenAt6m_denom = round(6 * denom / distanceM)
 * ===================================================================== */

var SNELLEN_ROWS = [
  { denom: 60, size: 80, letters: 'E F P' },
  { denom: 36, size: 65, letters: 'T O Z' },
  { denom: 24, size: 52, letters: 'L P E D' },
  { denom: 18, size: 42, letters: 'P E C F D' },
  { denom: 12, size: 32, letters: 'E D F C Z P' },
  { denom: 9,  size: 26, letters: 'F E L O P Z D' },
  { denom: 6,  size: 20, letters: 'D E F P O T E C' },
  { denom: 5,  size: 17, letters: 'L E F D E D P O T' },
  { denom: 4,  size: 14, letters: 'P E D Z F E C L O' }
];

var REAL_IPD_MM = 63;     // population mean interpupillary distance
var CARD_WIDTH_MM = 85.6; // credit-card width (ISO/IEC 7810 ID-1)

function openVaTool() {
  $('#vaOverlay').classList.add('open');
  renderVaChart_();

  // Request fullscreen (best-effort; iOS Safari may block, but the
  // overlay still renders full-size via position:fixed;inset:0.)
  var stage = document.documentElement;
  if (stage.requestFullscreen) stage.requestFullscreen().catch(function () {});
  else if (stage.webkitRequestFullscreen) stage.webkitRequestFullscreen();

  APP.vaState = {
    selectedRow: null,
    focalLengthPx: null,
    distanceM: null,
    cameraOn: false,
    stream: null,
    eye: 'right' // currently testing right eye first
  };

  // Restore saved focal length from a previous calibration
  var saved = localStorage.getItem('twc_focal_px');
  if (saved) {
    APP.vaState.focalLengthPx = parseFloat(saved);
    updateVaDistance_();
  }
}

function renderVaChart_() {
  var host = $('#vaChart');
  host.innerHTML = '';
  SNELLEN_ROWS.forEach(function (row, i) {
    var div = el('div', 'va-chart-row');
    div.dataset.idx = i;
    row.letters.split(' ').forEach(function (L) {
      var span = el('span', 'va-chart-letter', L);
      span.style.fontSize = row.size + 'px';
      div.appendChild(span);
    });
    var label = el('span', 'va-chart-label', '6/' + row.denom);
    label.style.fontSize = '11px';
    label.style.marginLeft = '10px';
    label.style.color = '#888';
    div.appendChild(label);
    div.addEventListener('click', function () {
      $$('.va-chart-row').forEach(function (r) { r.classList.remove('selected'); });
      div.classList.add('selected');
      APP.vaState.selectedRow = i;
      computeVaResult_();
    });
    host.appendChild(div);
  });
}

function computeVaResult_() {
  var st = APP.vaState;
  if (st.selectedRow === null) return;
  var row = SNELLEN_ROWS[st.selectedRow];
  var distanceM = st.distanceM || 6.0; // assume 6m if not measured
  // Decimal acuity = distanceM / denom (Snellen 6/x measured at distance d).
  var decimalAcuity = distanceM / row.denom;
  // Equivalent Snellen denominator if normalized to 6m.
  var snellenAt6m = (6 * row.denom) / distanceM;
  var snellenStr = '6/' + Math.round(snellenAt6m);

  // Write into the eye form (right eye first, then left).
  var form = APP.vaEyeForm;
  if (!form) return;
  if (st.eye === 'right') {
    form.querySelector('.ec-rd').value  = distanceM.toFixed(2);
    form.querySelector('.ec-rl').value  = snellenStr;
    form.querySelector('.ec-rdc').value = decimalAcuity.toFixed(2);
    st.eye = 'left';
    if ($('#vaInfo')) $('#vaInfo').textContent = 'Now cover your RIGHT eye and tap the smallest line you can read.';
  } else {
    form.querySelector('.ec-ld').value  = distanceM.toFixed(2);
    form.querySelector('.ec-ll').value  = snellenStr;
    form.querySelector('.ec-ldc').value = decimalAcuity.toFixed(2);
    if ($('#vaInfo')) $('#vaInfo').textContent = 'Done. Close the tool. (Both eyes recorded.)';
    st.eye = 'right';
  }
  toast('Acuity: ' + snellenStr + ' (decimal ' + decimalAcuity.toFixed(2) + ')', 'success');
}

/* Front camera + IPD-based distance measurement */
function toggleVaCamera_() {
  var st = APP.vaState;
  if (!st) return;
  if (st.cameraOn) {
    if (st.stream) st.stream.getTracks().forEach(function (t) { t.stop(); });
    st.stream = null;
    st.cameraOn = false;
    $('#vaVideo').classList.add('hidden');
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('Camera not supported on this device.', 'warning');
    return;
  }
  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false })
    .then(function (stream) {
      st.stream = stream;
      st.cameraOn = true;
      var v = $('#vaVideo');
      v.srcObject = stream;
      v.classList.remove('hidden');
      vaDetectLoop_();
    })
    .catch(function (err) {
      toast('Camera error: ' + (err.message || err.name), 'error');
    });
}

/** Auto-detect loop: sample the video frame to a canvas, detect the
 *  brightest region (face proxy) and estimate face width in pixels.
 *  distance_mm = (realIPD_mm * focalLengthPx) / ipdPixels
 *  where ipdPixels ≈ faceWidthPx / 2.6 (population ratio). */
function vaDetectLoop_() {
  var st = APP.vaState;
  if (!st || !st.cameraOn) return;
  var v = $('#vaVideo');
  var c = $('#vaCanvas');
  var ctx = c.getContext('2d');
  ctx.drawImage(v, 0, 0, c.width, c.height);
  try {
    var img = ctx.getImageData(0, 0, c.width, c.height);
    var d = img.data;
    var minX = c.width, minY = c.height, maxX = 0, maxY = 0, found = false;
    for (var y = 0; y < c.height; y += 2) {
      for (var x = 0; x < c.width; x += 2) {
        var i = (y * c.width + x) * 4;
        var lum = d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114;
        if (lum > 110) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          found = true;
        }
      }
    }
    if (found && st.focalLengthPx) {
      var faceWidthPx = (maxX - minX);
      var ipdPx = faceWidthPx / 2.6;
      var distMm = (REAL_IPD_MM * st.focalLengthPx) / ipdPx;
      var distM = distMm / 1000;
      if (distM > 0.2 && distM < 5) {
        st.distanceM = +distM.toFixed(2);
        updateVaDistance_();
      }
    }
  } catch (e) {
    // SecurityError on tainted canvas — ignore and keep looping.
  }
  if (st.cameraOn) requestAnimationFrame(vaDetectLoop_);
}

function updateVaDistance_() {
  if (APP.vaState && APP.vaState.distanceM) {
    $('#vaDistance').textContent = 'Distance: ' + APP.vaState.distanceM.toFixed(2) + ' m';
  } else {
    $('#vaDistance').textContent = 'Distance: — m (calibrate or use camera)';
  }
}

/** Manual calibration: user holds a standard card (credit-card ~85.6mm
 *  wide) flat to the camera at the testing distance. We sample the
 *  canvas and find the maximum bright horizontal span — that's the card.
 *  focalLengthPx = cardPx / cardRealWidthMm
 */
function calibrateVa_() {
  if (!navigator.mediaDevices) { toast('No camera for calibration.', 'warning'); return; }
  toast('Hold a credit-card (~85.6mm wide) flat to the camera.', 'warning');
  if (!APP.vaState.cameraOn) toggleVaCamera_();
  setTimeout(function () {
    var v = $('#vaVideo');
    var c = $('#vaCanvas');
    var ctx = c.getContext('2d');
    ctx.drawImage(v, 0, 0, c.width, c.height);
    var img;
    try { img = ctx.getImageData(0, 0, c.width, c.height); }
    catch (e) { toast('Calibration error: ' + e.message, 'error'); return; }
    var d = img.data;
    var maxSpan = 0;
    for (var y = 0; y < c.height; y++) {
      var startX = -1, endX = -1;
      for (var x = 0; x < c.width; x++) {
        var i = (y * c.width + x) * 4;
        var lum = d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114;
        if (lum > 130) { if (startX < 0) startX = x; endX = x; }
      }
      if (endX - startX > maxSpan) maxSpan = endX - startX;
    }
    if (maxSpan < 20) { toast('Calibration failed — card not detected.', 'error'); return; }
    var focal = maxSpan / CARD_WIDTH_MM;
    APP.vaState.focalLengthPx = focal;
    localStorage.setItem('twc_focal_px', String(focal));
    toast('Calibrated: focal = ' + focal.toFixed(2) + ' px/mm. Distance detection active.', 'success');
    updateVaDistance_();
  }, 2500);
}

function closeVaTool_() {
  var st = APP.vaState;
  if (st && st.stream) { st.stream.getTracks().forEach(function (t) { t.stop(); }); }
  $('#vaOverlay').classList.remove('open');
  if (document.exitFullscreen) document.exitFullscreen().catch(function(){});
  else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
}

/* =====================================================================
 *  11. REFERRAL SLIP + PRINT
 * ===================================================================== */
function hookReferralForm_() {
  var form = $('#referralForm');
  if (!form || form.dataset.hooked) return;
  form.dataset.hooked = '1';

  // Populate patient dropdown when outreach changes
  var refreshPatients = function () {
    var oid = APP.currentOutreachId;
    if (!oid) return;
    callAPI('getPatients', { outreachId: oid }, { method: 'GET' }).then(function (res) {
      if (res && res.data) {
        $('#refPatient').innerHTML = '<option value="">— Select Patient —</option>' +
          res.data.map(function (p) {
            return '<option value="' + p.PatientID + '">' + esc(p.PatientCode) + ' — ' + esc(p.FullName) + '</option>';
          }).join('');
      }
    });
  };
  refreshPatients();

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var data = {
      PatientID: $('#refPatient').value,
      OutreachID: APP.currentOutreachId,
      Reason: $('#refReason').value,
      Destination: $('#refDestination').value,
      Priority: $('#refPriority').value
    };
    if (!data.PatientID) { toast('Select a patient.', 'warning'); return; }
    callAPI('createReferral', data, { method: 'POST' }).then(function (res) {
      if (res.error) { toast(res.error, 'error'); return; }
      toast('Referral created: ' + res.data.ReferralCode, 'success');
      // The server returns joined patient+issuer so we can render
      // the printable slip immediately (no second round-trip).
      renderReferralSlip_(res.data);
    });
  });
}

function renderReferralSlip_(data) {
  var ref = data;
  var pat = data.patient || {};
  var host = $('#referralSlipHost');
  host.innerHTML =
    '<div class="referral-slip" id="slipCard">' +
      '<div class="slip-header"><span>TWC LABS</span><span>&#10010;</span></div>' +
      '<h2 style="color:var(--twc-teal);margin:0 0 12px;">Patient Referral Slip</h2>' +
      '<div class="slip-row"><span class="k">Referral Code</span><span class="v">' + esc(ref.ReferralCode) + '</span></div>' +
      '<div class="slip-row"><span class="k">Patient Code</span><span class="v">' + esc(pat.PatientCode) + '</span></div>' +
      '<div class="slip-row"><span class="k">Patient Name</span><span class="v">' + esc(pat.FullName) + '</span></div>' +
      '<div class="slip-row"><span class="k">Age / Sex</span><span class="v">' + (pat.Age || '—') + ' / ' + esc(pat.Sex) + '</span></div>' +
      '<div class="slip-row"><span class="k">Reason</span><span class="v">' + esc(ref.Reason) + '</span></div>' +
      '<div class="slip-row"><span class="k">Destination</span><span class="v">' + esc(ref.Destination) + '</span></div>' +
      '<div class="slip-row"><span class="k">Priority</span><span class="v"><span class="pri ' + ref.Priority + '">' + ref.Priority + '</span></span></div>' +
      '<div class="slip-row"><span class="k">Issuing Officer</span><span class="v">' + esc(data.issuedBy) + '</span></div>' +
      '<div class="slip-row"><span class="k">Date</span><span class="v">' + fmtDateTime(ref.CreatedAt) + '</span></div>' +
      '<div class="noprint" style="margin-top:18px;text-align:center;">' +
        '<button class="btn btn-primary" id="slipPrintBtn">🖨️ Print / Save PDF</button>' +
      '</div>' +
    '</div>';
  var printBtn = $('#slipPrintBtn');
  if (printBtn) printBtn.addEventListener('click', function () { window.print(); });
  host.scrollIntoView({ behavior: 'smooth' });
}

/* =====================================================================
 *  12. SUPERADMIN — SITES, USERS, AUDIT, EXEC REPORT
 * ===================================================================== */
function hookSiteForm_() {
  var form = $('#siteForm');
  if (!form || form.dataset.hooked) return;
  form.dataset.hooked = '1';
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var data = {
      Name: $('#sName').value.trim(),
      Location: $('#sLocation').value.trim(),
      Region: $('#sRegion').value.trim()
    };
    callAPI('createSite', data, { method: 'POST' }).then(function (res) {
      if (res.error) { toast(res.error, 'error'); return; }
      toast('Site added.', 'success');
      form.reset();
      callAPI('getSites', {}, { method: 'GET' }).then(function (r) {
        if (r && r.data) { APP.sites = r.data; renderSitesList_(); populateSiteDropdowns_(); }
      });
    });
  });
}

function renderSitesList_() {
  var tbody = $('#sitesTable tbody');
  if (!tbody) return;
  tbody.innerHTML = APP.sites.map(function (s) {
    return '<tr>' +
      '<td>' + esc(s.Name) + '</td>' +
      '<td>' + esc(s.Location || '—') + '</td>' +
      '<td>' + esc(s.Region || '—') + '</td>' +
      '<td>' + (s.Active ? '✅' : '⛔') + '</td>' +
    '</tr>';
  }).join('');
}

function renderUsersList_() {
  callAPI('getUsers', {}, { method: 'GET' }).then(function (res) {
    if (res.error) { toast(res.error, 'error'); return; }
    var tbody = $('#usersTable tbody');
    if (!tbody) return;
    tbody.innerHTML = (res.data || []).map(function (u) {
      var siteName = (APP.sites.filter(function (s) { return s.SiteID === u.SiteID; })[0] || {}).Name || '—';
      return '<tr>' +
        '<td>' + esc(u.FullName || '—') + '</td>' +
        '<td>' + esc(u.Email) + '</td>' +
        '<td><span class="badge badge-' + String(u.Role).toLowerCase() + '">' + esc(u.Role) + '</span></td>' +
        '<td>' + esc(siteName) + '</td>' +
        '<td>' + (u.MustChangePassword ? '⚠️ Yes' : 'No') + '</td>' +
        '<td>' + (u.Active ? '✅' : '⛔') + '</td>' +
      '</tr>';
    }).join('');
  });
}

function renderAuditList_() {
  callAPI('getAuditLog', { limit: 200 }, { method: 'GET' }).then(function (res) {
    if (res.error) { toast(res.error, 'error'); return; }
    var tbody = $('#auditTable tbody');
    if (!tbody) return;
    tbody.innerHTML = (res.data || []).map(function (a) {
      return '<tr>' +
        '<td>' + fmtDateTime(a.Timestamp) + '</td>' +
        '<td>' + esc(a.UserEmail) + '</td>' +
        '<td>' + esc(a.Action) + '</td>' +
        '<td>' + esc(a.Resource) + '</td>' +
        '<td><small>' + esc(a.Details).substring(0, 120) + '</small></td>' +
      '</tr>';
    }).join('');
  });
}

function hookReportView_() {
  var btn = $('#genReportBtn');
  if (!btn || btn.dataset.hooked) return;
  btn.dataset.hooked = '1';
  btn.addEventListener('click', function () {
    var oid = $('#repOutreach').value;
    if (!oid) { toast('Select an outreach.', 'warning'); return; }
    btn.disabled = true; btn.textContent = 'Generating…';
    $('#reportHost').innerHTML = '<div class="state"><div class="spinner"></div><div class="title">Calling Gemini…</div></div>';
    callAPI('generateExecutiveReport', { outreachId: oid }, { method: 'POST' }).then(function (res) {
      btn.disabled = false; btn.textContent = 'Generate (Gemini)';
      if (res.error) {
        $('#reportHost').innerHTML = '<div class="state"><div class="title">' + esc(res.error) + '</div></div>';
        return;
      }
      var m = res.metrics || {};
      var metricsHtml = '<div class="exec-report">' +
        '<h1>' + esc(m.outreach) + '</h1>' +
        '<p><strong>Date:</strong> ' + fmtDate(m.date) + ' &nbsp; <strong>Venue:</strong> ' + esc(m.venue) + '</p>' +
        '<div class="metric-grid">' +
          '<div class="metric-tile"><div class="num">' + m.totalPatients + '</div><div class="lbl">Patients</div></div>' +
          '<div class="metric-tile"><div class="num">' + m.vitalsCaptured + '</div><div class="lbl">Vitals</div></div>' +
          '<div class="metric-tile"><div class="num">' + m.diagnosticsCaptured + '</div><div class="lbl">Diagnostics</div></div>' +
          '<div class="metric-tile"><div class="num">' + m.eyeChecks + '</div><div class="lbl">Eye Checks</div></div>' +
          '<div class="metric-tile"><div class="num">' + m.dentalChecks + '</div><div class="lbl">Dental</div></div>' +
          '<div class="metric-tile"><div class="num">' + m.referrals + '</div><div class="lbl">Referrals</div></div>' +
          '<div class="metric-tile"><div class="num">' + (m.hypertensiveCount || 0) + '</div><div class="lbl">Hypertensive</div></div>' +
          '<div class="metric-tile"><div class="num">' + (m.hyperglycemicCount || 0) + '</div><div class="lbl">Hyperglycemic</div></div>' +
        '</div>';
      // The AI-generated body is full HTML; we extract just the <body> contents.
      var aiHtml = res.html ? res.html.replace(/^[\s\S]*?<body>/, '').replace(/<\/body>[\s\S]*$/, '') : '<pre>' + esc(res.markdown) + '</pre>';
      $('#reportHost').innerHTML = metricsHtml + aiHtml +
        '<div class="noprint" style="text-align:center;margin-top:18px;">' +
          '<button class="btn btn-primary" id="reportPrintBtn">🖨️ Print / Save PDF</button>' +
        '</div>';
      var printBtn = $('#reportPrintBtn');
      if (printBtn) printBtn.addEventListener('click', function () { window.print(); });
    });
  });
}

/* Dashboard metric tiles */
function renderDashboard_() {
  var oid = APP.currentOutreachId;
  if (!oid) return;
  callAPI('getPatients', { outreachId: oid }, { method: 'GET' }).then(function (res) {
    if (res && res.data) {
      var tiles = $('#dashMetrics').children;
      tiles[0].querySelector('.num').textContent = res.data.length;
    }
  });
}

/* =====================================================================
 *  13. PWA — install prompt + service worker registration
 * ===================================================================== */
function initPwa() {
  // Capture install prompt
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    APP.deferredInstall = e;
    $('#pwaInstall').classList.add('show');
  });
  $('#pwaInstallBtn').addEventListener('click', function () {
    if (!APP.deferredInstall) {
      toast('Use your browser menu → Add to Home Screen.', 'warning');
      return;
    }
    APP.deferredInstall.prompt();
    APP.deferredInstall.userChoice.then(function (choice) {
      if (choice.outcome === 'accepted') toast('Installed! Find it on your home screen.', 'success');
      APP.deferredInstall = null;
      $('#pwaInstall').classList.remove('show');
    });
  });
  $('#pwaDismiss').addEventListener('click', function () {
    $('#pwaInstall').classList.remove('show');
  });

  // Register the local service worker (./sw.js). Scope is "./" which
  // covers the entire GitHub Pages repo.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js', { scope: './' })
      .then(function (reg) { console.log('[PWA] SW registered', reg); })
      .catch(function (err) { console.warn('[PWA] SW registration failed', err); });
  } else {
    console.info('[PWA] Service Worker not supported in this browser.');
  }
}

/* =====================================================================
 *  14. OFFLINE BUFFERING + SYNC
 * ===================================================================== */
function bufferCapture_(item) {
  var queue = JSON.parse(localStorage.getItem('twc_buffer') || '[]');
  queue.push(item);
  localStorage.setItem('twc_buffer', JSON.stringify(queue));
}
function getBuffer_() {
  return JSON.parse(localStorage.getItem('twc_buffer') || '[]');
}
function clearBuffer_() {
  localStorage.removeItem('twc_buffer');
}

function syncBuffer_() {
  var buf = getBuffer_();
  if (!buf.length) return;
  toast('Syncing ' + buf.length + ' offline captures…', 'warning');
  callAPI('syncBuffer', { batch: buf }, { method: 'POST' }).then(function (res) {
    if (res.error) { toast('Sync error: ' + res.error, 'error'); return; }
    toast('Synced: ' + res.written + ' written, ' + res.skipped + ' skipped.', 'success');
    if (res.errors && res.errors.length) {
      var failedIds = res.errors.map(function (e) { return e.tempId; });
      var keep = buf.filter(function (b) { return failedIds.indexOf(b.tempId) !== -1; });
      localStorage.setItem('twc_buffer', JSON.stringify(keep));
    } else {
      clearBuffer_();
    }
  });
}

function initOffline_() {
  window.addEventListener('online', function () {
    toast('Back online. Syncing captures…', 'warning');
    syncBuffer_();
  });
  window.addEventListener('offline', function () {
    toast('You are offline. Captures will be buffered.', 'warning');
  });
  // On boot, if we're online and there's a buffer, sync immediately.
  if (navigator.onLine && getBuffer_().length) {
    setTimeout(syncBuffer_, 1500);
  }
}

/* =====================================================================
 *  15. TOASTS, VALIDATION, INIT
 * ===================================================================== */
function toast(msg, type) {
  var wrap = $('#toastWrap');
  var t = el('div', 'toast' + (type ? ' ' + type : ''), msg);
  wrap.appendChild(t);
  setTimeout(function () {
    t.style.opacity = '0';
    t.style.transition = 'opacity 0.3s';
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300);
  }, 3500);
}

/** Wire up buttons that live outside the per-view hook functions. */
function wireButtons_() {
  // VA tool buttons
  $('#vaClose').addEventListener('click', closeVaTool_);
  $('#vaCameraBtn').addEventListener('click', toggleVaCamera_);
  $('#vaCalibrateBtn').addEventListener('click', calibrateVa_);
  $('#vaConfirmBtn').addEventListener('click', function () {
    if (APP.vaState && APP.vaState.selectedRow === null) {
      toast('Select the smallest line you can read first.', 'warning');
      return;
    }
    computeVaResult_();
  });

  // Outreach + site forms
  if ($('#outreachForm')) hookOutreachForm_();
  if ($('#siteForm')) hookSiteForm_();
  if ($('#inviteForm')) hookInviteForm_();
}

/* ====== INIT ====== */
document.addEventListener('DOMContentLoaded', function () {
  initPwa();
  initOffline_();
  initAuth();
  wireButtons_();
});
