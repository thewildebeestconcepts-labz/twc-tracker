/* ===================================================================
 * TWC Outreach Tracker — GitHub Pages split-architecture client
 * -------------------------------------------------------------------
 * Vanilla JS, no frameworks. Talks to the GAS JSON API via fetch()
 * with Content-Type: text/plain (to stay in the "simple request" CORS
 * bucket — see api/Code.gs header comment).
 *
 * The API uses PascalCase field names (e.g. PatientID, BPSystolic).
 * The Next.js demo app uses camelCase; the GitHub Pages frontend
 * translates between the two as needed.
 * =================================================================== */

/* ===================================================================
 * CONSTANTS & ROLE/RBAC (mirrors src/lib/auth-shared.ts + src/lib/store.ts)
 * =================================================================== */

/* -------------------------------------------------------------------
 * Lucide icon helper
 *   Renders an <i data-lucide="NAME"> placeholder that lucide.createIcons()
 *   swaps for an inline <svg>. Always call lucide.createIcons() AFTER
 *   inserting the returned HTML string into the DOM (every render
 *   function below does this at the end).
 * ------------------------------------------------------------------- */
function ico(name, cls) {
  return '<i data-lucide="' + name + '"' + (cls ? ' class="' + cls + '"' : '') + '></i>';
}

/* Refresh lucide icons across the whole document. Safe to call after
 * any innerHTML / appendChild that contains <i data-lucide> elements.
 * No-ops if the lucide library hasn't loaded yet (e.g. offline first paint). */
function refreshIcons() {
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    try { window.lucide.createIcons(); } catch (e) { /* ignore */ }
  }
}

var ROLE_LABELS = {
  SUPER_ADMIN:  'Super Admin',
  COORDINATOR:  'Outreach Coordinator',
  NURSE:        'Nurse',
  LAB_TECH:     'Lab Technician',
  OPTOMETRIST:  'Optometrist',
  DENTIST:      'Dentist'
};

// Maps Next.js role keys -> GAS API role strings
var ROLE_API = {
  SUPER_ADMIN:  'SuperAdmin',
  COORDINATOR:  'Coordinator',
  NURSE:        'Nurse',
  LAB_TECH:     'LabTechnician',
  OPTOMETRIST:  'Optometrist',
  DENTIST:      'Dentist'
};
var ROLE_FROM_API = {};
Object.keys(ROLE_API).forEach(function (k) { ROLE_FROM_API[ROLE_API[k]] = k; });

// Role -> allowed views. GAS Source is SUPER_ADMIN ONLY.
var ROLE_MODULES = {
  SUPER_ADMIN:  ['dashboard', 'outreaches', 'register-patient', 'personnel', 'sites', 'users', 'audit', 'reports', 'referrals', 'gas-source'],
  COORDINATOR:  ['dashboard', 'outreaches', 'register-patient', 'personnel', 'referrals'],
  NURSE:        ['dashboard', 'queue', 'vitals'],
  LAB_TECH:     ['dashboard', 'queue', 'diagnostics'],
  OPTOMETRIST:  ['dashboard', 'queue', 'eye'],
  DENTIST:      ['dashboard', 'queue', 'dental']
};

var ROLE_ACCENT_CLASS = {
  SUPER_ADMIN:  'role-purple',
  COORDINATOR:  'role-teal',
  NURSE:        'role-emerald',
  LAB_TECH:     'role-amber',
  OPTOMETRIST:  'role-sky',
  DENTIST:      'role-rose'
};

var VIEW_META = {
  'dashboard':       { label: 'Dashboard',        icon: 'layout-dashboard' },
  'outreaches':      { label: 'Outreaches',       icon: 'clipboard-list' },
  'register-patient':{ label: 'Register Patient', icon: 'user-plus' },
  'personnel':       { label: 'Personnel',        icon: 'users' },
  'queue':           { label: 'Patient Queue',    icon: 'clipboard-list' },
  'vitals':          { label: 'Vital Signs',      icon: 'stethoscope' },
  'diagnostics':     { label: 'Diagnostics',      icon: 'flask-conical' },
  'eye':             { label: 'Eye Check',        icon: 'eye' },
  'dental':          { label: 'Dental Check',     icon: 'smile' },
  'referrals':       { label: 'Referrals',        icon: 'file-text' },
  'sites':           { label: 'Sites',            icon: 'building-2' },
  'users':           { label: 'Users',            icon: 'users' },
  'reports':         { label: 'Exec Reports',     icon: 'bar-chart-3' },
  'audit':           { label: 'Audit Log',        icon: 'scroll-text' },
  'gas-source':      { label: 'GAS Source',       icon: 'code-2' }
};

var ROLE_CAPTURE = {
  NURSE:        { key: 'hasVitals',     target: 'vitals',      label: 'Vitals',      color: 'emerald' },
  LAB_TECH:     { key: 'hasDiagnostic', target: 'diagnostics', label: 'Blood Sugar', color: 'amber' },
  OPTOMETRIST:  { key: 'hasEye',        target: 'eye',         label: 'Eye Check',   color: 'sky' },
  DENTIST:      { key: 'hasDental',     target: 'dental',      label: 'Dental',      color: 'rose' }
};

var SNELLEN_LINES = [
  { frac: '20/200', decimal: 0.10, label: 'E F P' },
  { frac: '20/100', decimal: 0.20, label: 'T O Z' },
  { frac: '20/70',  decimal: 0.29, label: 'L P E D' },
  { frac: '20/50',  decimal: 0.40, label: 'P E C F D' },
  { frac: '20/40',  decimal: 0.50, label: 'E D F C Z P' },
  { frac: '20/30',  decimal: 0.67, label: 'F E L O P Z D' },
  { frac: '20/25',  decimal: 0.80, label: 'D E F P O T E C' },
  { frac: '20/20',  decimal: 1.00, label: 'L E F O D P E C T' },
  { frac: '20/15',  decimal: 1.33, label: 'D F C Z P E T O L E' }
];

var CAPTURE_SECONDS = 15;
var TARGET_FS = 30;
var AVG_FACE_WIDTH_MM = 140;
var FRONT_CAM_FOV_DEG = 65;

var GAS_API_URL = (function () {
  var m = document.querySelector('meta[name="gas-api-url"]');
  var url = m ? m.getAttribute('content') : '';
  if (!url || url.indexOf('REPLACE_WITH') === 0) {
    // GAS API URL not configured — flag it so the UI can warn the deployer.
    window.TWC_API_NOT_CONFIGURED = true;
    return '';
  }
  return url;
})();

/* ===================================================================
 * STATE
 * =================================================================== */
var STATE = {
  user: null,
  token: localStorage.getItem('twc_token') || '',
  view: 'dashboard',
  activeOutreachId: null,
  activeOutreach: null,
  selectedPatientId: null,
  cachedPatients: [],
  cachedOutreaches: [],
  cachedSites: [],
  cameraFacing: 'user',
  online: navigator.onLine
};

/* ===================================================================
 * DOM SHORTCUTS
 * =================================================================== */
function $(id)  { return document.getElementById(id); }
function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
function el(tag, cls, html) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}
function show(id)   { var e = $(id); if (e) e.classList.remove('hidden'); }
function hide(id)   { var e = $(id); if (e) e.classList.add('hidden'); }
function clearChildren(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function initials(name) {
  if (!name) return '?';
  var parts = String(name).trim().split(/\s+/);
  return ((parts[0] || '?')[0] + (parts[1] || '')[0]).toUpperCase();
}
function fmtDate(d) {
  if (!d) return '—';
  var date = new Date(d);
  if (isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-NG', { day: 'numeric', month: 'long', year: 'numeric' });
}
function fmtDateShort(d) {
  if (!d) return '';
  var date = new Date(d);
  if (isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtDateTime(d) {
  if (!d) return '';
  var date = new Date(d);
  if (isNaN(date.getTime())) return '';
  return date.toLocaleString('en-NG', { dateStyle: 'short', timeStyle: 'short' });
}

/* ===================================================================
 * TOAST NOTIFICATIONS
 * =================================================================== */
function toast(msg, type) {
  var host = $('toastWrap');
  if (!host) return;
  var t = el('div', 'toast toast-' + (type || 'default'));
  var iconMap = {
    success: ico('check'),
    error:   ico('x'),
    warning: ico('alert-triangle'),
    info:    ico('info')
  };
  t.innerHTML = '<span class="toast-ico">' + (iconMap[type] || ico('info')) + '</span><span class="toast-msg"></span>';
  t.querySelector('.toast-msg').textContent = msg;
  host.appendChild(t);
  refreshIcons();
  // Animate in
  setTimeout(function () { t.classList.add('toast-in'); }, 10);
  setTimeout(function () {
    t.classList.remove('toast-in');
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300);
  }, 3500);
}
function toastSuccess(m) { toast(m, 'success'); }
function toastError(m)   { toast(m, 'error'); }
function toastWarn(m)    { toast(m, 'warning'); }

/* ===================================================================
 * API CLIENT — POSTs JSON body as text/plain (CORS-safe)
 * =================================================================== */
function callAPI(action, params, opts) {
  opts = opts || {};
  var method = (opts.method || 'GET').toUpperCase();
  var url = GAS_API_URL + '?action=' + encodeURIComponent(action);
  var fetchOpts = { method: method };
  if (method === 'POST') {
    var body = Object.assign({}, params || {});
    if (STATE.token) body.token = STATE.token;
    // CRITICAL: Content-Type MUST be text/plain (no CORS preflight on GAS).
    fetchOpts.headers = { 'Content-Type': 'text/plain;charset=utf-8' };
    fetchOpts.body = JSON.stringify(body);
  } else {
    if (STATE.token) url += '&token=' + encodeURIComponent(STATE.token);
    // Optional query params
    if (params) {
      Object.keys(params).forEach(function (k) {
        if (params[k] != null && params[k] !== '') {
          url += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
        }
      });
    }
  }
  return fetch(url, fetchOpts).then(function (res) {
    return res.text().then(function (text) {
      // Detect non-JSON responses (e.g. GitHub Pages HTML 404, or a GAS
      // error page) — these happen when the GAS API URL is not set, wrong,
      // or the script isn't deployed as a web app.
      if (!text || text.trim().charAt(0) !== '{') {
        if (!GAS_API_URL) {
          throw new Error('GAS API URL not configured. Open index.html and set <meta name="gas-api-url" content="YOUR_GAS_EXEC_URL"> to your deployed Apps Script /exec URL.');
        }
        if (res.ok && text && text.indexOf('<!DOCTYPE') === 0) {
          throw new Error('The GAS API URL points to an HTML page, not the API. Ensure you deployed the Apps Script as a Web App (Execute as: Me, Access: Anyone) and used the /exec URL, not /dev.');
        }
        throw new Error('Server returned a non-JSON response. Check the GAS API URL and that the web app is deployed correctly.');
      }
      try {
        return JSON.parse(text);
      } catch (parseErr) {
        throw new Error('Server returned invalid JSON. Check the GAS API URL.');
      }
    });
  }).then(function (data) {
    if (!data || data.error) {
      var msg = (data && (data.message || data.error)) || 'Request failed with no response.';
      var err = new Error(msg);
      err.code = data ? data.error : 'EMPTY_RESPONSE';
      throw err;
    }
    return data;
  });
}

/* Wrappers mirroring src/lib/api.ts */
var api = {
  me: function () { return callAPI('me', null, { method: 'GET' }); },
  login: function (email, password) {
    return callAPI('login', { email: email, password: password }, { method: 'POST' });
  },
  logout: function () { return callAPI('logout', null, { method: 'POST' }); },
  changePassword: function (currentPassword, newPassword) {
    return callAPI('changePassword', { currentPassword: currentPassword, newPassword: newPassword }, { method: 'POST' });
  },
  sites: function () { return callAPI('getSites', null, { method: 'GET' }); },
  createSite: function (data) { return callAPI('createSite', data, { method: 'POST' }); },
  outreaches: function () { return callAPI('getOutreaches', null, { method: 'GET' }); },
  activeOutreach: function () { return callAPI('getActiveOutreach', null, { method: 'GET' }); },
  createOutreach: function (data) { return callAPI('createOutreach', data, { method: 'POST' }); },
  patients: function (outreachId) {
    return callAPI('getPatients', { outreachId: outreachId }, { method: 'GET' });
  },
  patient: function (id) { return callAPI('getPatient', { patientId: id }, { method: 'GET' }); },
  registerPatient: function (data) { return callAPI('registerPatient', data, { method: 'POST' }); },
  saveVitals: function (data) { return callAPI('saveVitals', data, { method: 'POST' }); },
  saveDiagnostic: function (data) { return callAPI('saveDiagnostic', data, { method: 'POST' }); },
  saveEyeCheck: function (data) { return callAPI('saveEyeCheck', data, { method: 'POST' }); },
  saveDentalCheck: function (data) { return callAPI('saveDentalCheck', data, { method: 'POST' }); },
  referrals: function () { return callAPI('getReferrals', null, { method: 'GET' }); },
  createReferral: function (data) { return callAPI('createReferral', data, { method: 'POST' }); },
  invites: function (outreachId) {
    return callAPI('getInvites', outreachId ? { outreachId: outreachId } : null, { method: 'GET' });
  },
  invitePersonnel: function (data) { return callAPI('invitePersonnel', data, { method: 'POST' }); },
  users: function () { return callAPI('getUsers', null, { method: 'GET' }); },
  audit: function () { return callAPI('getAuditLog', null, { method: 'GET' }); },
  executiveReport: function (outreachId) {
    return callAPI('generateExecutiveReport', { outreachId: outreachId }, { method: 'POST' });
  },
  gasSource: function () { return callAPI('getGasSource', null, { method: 'GET' }).catch(function () { return { files: [], totalLines: 0 }; }); },
  clearCaptures: function () { return callAPI('clearCaptures', null, { method: 'POST' }); },
  resetDemo: function () { return callAPI('resetDemo', null, { method: 'POST' }); },
  syncBuffer: function (batch) { return callAPI('syncBuffer', { batch: batch }, { method: 'POST' }); }
};

/* ===================================================================
 * CV / SIGNAL PROCESSING — ported from src/lib/cv-utils.ts
 * =================================================================== */
function isSkin(r, g, b) {
  var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return (
    r > 50 && g > 30 && b > 15 &&
    (mx - mn) > 12 &&
    Math.abs(r - g) > 12 &&
    r > g && r > b &&
    !(r > 235 && g > 235 && b > 235)
  );
}

function detectSkinROI(ctx, w, h) {
  var img = ctx.getImageData(0, 0, w, h).data;
  var step = 2;
  var cols = Math.ceil(w / step), rows = Math.ceil(h / step);
  var mask = new Uint8Array(cols * rows);
  for (var y = 0; y < rows; y++) {
    for (var x = 0; x < cols; x++) {
      var sx = x * step, sy = y * step;
      var i = (sy * w + sx) * 4;
      if (isSkin(img[i], img[i+1], img[i+2])) mask[y * cols + x] = 1;
    }
  }
  var yStart = Math.floor(rows * 0.2), yEnd = Math.floor(rows * 0.8);
  var bestY = 0, bestCount = 0;
  for (var yy = yStart; yy < yEnd; yy++) {
    var c = 0;
    for (var xx = 0; xx < cols; xx++) if (mask[yy * cols + xx]) c++;
    if (c > bestCount) { bestCount = c; bestY = yy; }
  }
  if (bestCount < cols * 0.15) return null;
  var top = bestY, bottom = bestY, minDensity = 0.1;
  for (var yd = bestY - 1; yd >= 0; yd--) {
    var cd = 0;
    for (var xd = 0; xd < cols; xd++) if (mask[yd * cols + xd]) cd++;
    if (cd / cols < minDensity) break;
    top = yd;
  }
  for (var yu = bestY + 1; yu < rows; yu++) {
    var cu = 0;
    for (var xu = 0; xu < cols; xu++) if (mask[yu * cols + xu]) cu++;
    if (cu / cols < minDensity) break;
    bottom = yu;
  }
  var left = cols, right = 0;
  for (var xr = 0; xr < cols; xr++) {
    if (mask[bestY * cols + xr]) {
      if (xr < left) left = xr;
      if (xr > right) right = xr;
    }
  }
  var roiTop = top + Math.floor((bottom - top) * 0.25);
  var roiHeight = Math.floor((bottom - top) * 0.4);
  return {
    x: left * step,
    y: roiTop * step,
    width: (right - left) * step,
    height: roiHeight * step,
    cx: ((left + right) / 2) * step,
    cy: (roiTop + roiHeight / 2) * step
  };
}

function roiChannelMeans(ctx, w, h, roi) {
  var x0 = Math.max(0, Math.floor(roi.x));
  var y0 = Math.max(0, Math.floor(roi.y));
  var x1 = Math.min(w, Math.floor(roi.x + roi.width));
  var y1 = Math.min(h, Math.floor(roi.y + roi.height));
  if (x1 <= x0 || y1 <= y0) return { r: 0, g: 0, b: 0 };
  var img = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
  var rs = 0, gs = 0, bs = 0, n = (x1 - x0) * (y1 - y0);
  for (var i = 0; i < img.length; i += 4) { rs += img[i]; gs += img[i+1]; bs += img[i+2]; }
  return { r: rs / n, g: gs / n, b: bs / n };
}

function detrend(signal, window) {
  var out = new Array(signal.length);
  var half = Math.floor(window / 2);
  for (var i = 0; i < signal.length; i++) {
    var sum = 0, cnt = 0;
    for (var j = Math.max(0, i - half); j <= Math.min(signal.length - 1, i + half); j++) { sum += signal[j]; cnt++; }
    out[i] = signal[i] - sum / cnt;
  }
  return out;
}

function normalize(signal) {
  if (!signal.length) return signal;
  var mean = 0;
  for (var i = 0; i < signal.length; i++) mean += signal[i];
  mean /= signal.length;
  var variance = 0;
  for (var j = 0; j < signal.length; j++) variance += (signal[j] - mean) * (signal[j] - mean);
  var std = Math.sqrt(variance / signal.length) || 1;
  return signal.map(function (v) { return (v - mean) / std; });
}

function iirFilter(signal, b, a) {
  var out = new Array(signal.length);
  var x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (var n = 0; n < signal.length; n++) {
    var x0 = signal[n];
    var y0 = b[0] * x0 + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
    out[n] = y0;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  return out;
}

function butterworthHP(signal, fs, fc) {
  var w0 = (2 * Math.PI * fc) / fs;
  var cos = Math.cos(w0), sin = Math.sin(w0), Q = 0.707;
  var alpha = sin / (2 * Q);
  var b0 = (1 + cos) / 2, b1 = -(1 + cos), b2 = (1 + cos) / 2;
  var a0 = 1 + alpha, a1 = -2 * cos, a2 = 1 - alpha;
  return iirFilter(signal, [b0/a0, b1/a0, b2/a0], [1, a1/a0, a2/a0]);
}

function butterworthLP(signal, fs, fc) {
  var w0 = (2 * Math.PI * fc) / fs;
  var cos = Math.cos(w0), sin = Math.sin(w0), Q = 0.707;
  var alpha = sin / (2 * Q);
  var b0 = (1 - cos) / 2, b1 = 1 - cos, b2 = (1 - cos) / 2;
  var a0 = 1 + alpha, a1 = -2 * cos, a2 = 1 - alpha;
  return iirFilter(signal, [b0/a0, b1/a0, b2/a0], [1, a1/a0, a2/a0]);
}

function bandpassFilter(signal, fs, low, high) {
  return butterworthLP(butterworthHP(signal, fs, low), fs, high);
}

function autocorrelationHR(signal, fs) {
  var n = signal.length;
  if (n < fs * 3) return null;
  var minLag = Math.floor((60 / 180) * fs);
  var maxLag = Math.floor((60 / 45) * fs);
  var bestLag = 0, bestCorr = -Infinity;
  var normSq = 0;
  for (var k = 0; k < n; k++) normSq += signal[k] * signal[k];
  var norm = Math.sqrt(normSq) || 1;
  for (var lag = minLag; lag <= maxLag && lag < n / 2; lag++) {
    var corr = 0;
    for (var i = 0; i < n - lag; i++) corr += signal[i] * signal[i + lag];
    corr /= norm * norm * (n - lag);
    if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
  }
  if (bestLag === 0) return null;
  var bpm = Math.round((60 * fs) / bestLag);
  var confidence = Math.max(0, Math.min(1, bestCorr * 3));
  return { bpm: bpm, confidence: confidence };
}

function acdc(signal) {
  if (!signal.length) return { ac: 0, dc: 1 };
  var dc = 0;
  for (var i = 0; i < signal.length; i++) dc += signal[i];
  dc /= signal.length;
  var mx = -Infinity, mn = Infinity;
  for (var j = 0; j < signal.length; j++) {
    if (signal[j] > mx) mx = signal[j];
    if (signal[j] < mn) mn = signal[j];
  }
  return { ac: (mx - mn) / 2, dc: dc || 1 };
}

function estimateSpO2(red, green) {
  var r = acdc(red), g = acdc(green);
  if (r.dc === 0 || g.dc === 0) return 0;
  var R = (r.ac / r.dc) / (g.ac / g.dc);
  var spo2 = 110 - 25 * R;
  spo2 = Math.max(90, Math.min(100, Math.round(spo2)));
  return spo2;
}

function estimateBP(hr, spo2, pulseAmplitude, pulseWidthSamples, fs) {
  var pwSec = pulseWidthSamples / fs;
  var amp = Math.max(0, Math.min(1, pulseAmplitude * 50));
  var baseSys = 110 + (hr - 72) * 0.35;
  var widthContrib = (0.28 - pwSec) * 60;
  var ampContrib = amp * 12;
  var systolic = Math.round(Math.max(95, Math.min(170, baseSys + widthContrib + ampContrib)));
  var pulsePressure = Math.round(38 + amp * 12 + (hr - 72) * 0.2);
  var diastolic = Math.max(60, systolic - pulsePressure);
  var map = Math.round(diastolic + (systolic - diastolic) / 3);
  var confidence = Math.max(0.3, Math.min(0.7, 0.55 - Math.abs(hr - 72) * 0.003));
  return { systolic: systolic, diastolic: diastolic, map: map, confidence: confidence };
}

function detectPeaks(signal, fs) {
  var peaks = [];
  var threshold = 0;
  for (var i = 0; i < signal.length; i++) threshold += Math.abs(signal[i]);
  threshold = (threshold / signal.length) * 1.2;
  var minDist = Math.floor(fs * 0.4);
  var lastPeak = -minDist;
  for (var p = 2; p < signal.length - 2; p++) {
    if (
      signal[p] > threshold &&
      signal[p] > signal[p - 1] && signal[p] > signal[p + 1] &&
      signal[p] > signal[p - 2] && signal[p] > signal[p + 2] &&
      p - lastPeak >= minDist
    ) {
      var left = p;
      while (left > 0 && signal[left] > signal[p] / 2) left--;
      var right = p;
      while (right < signal.length - 1 && signal[right] > signal[p] / 2) right++;
      peaks.push({ index: p, value: signal[p], width: right - left });
      lastPeak = p;
    }
  }
  return peaks;
}

function detectFaceWidth(ctx, w, h) {
  var img = ctx.getImageData(0, 0, w, h).data;
  var midRow = Math.floor(h * 0.45);
  var bestRun = 0, run = 0, runStart = 0, bestStart = 0;
  for (var x = 0; x < w; x++) {
    var i = (midRow * w + x) * 4;
    if (isSkin(img[i], img[i+1], img[i+2])) {
      if (run === 0) runStart = x;
      run++;
    } else {
      if (run > bestRun) { bestRun = run; bestStart = runStart; }
      run = 0;
    }
  }
  if (run > bestRun) bestRun = run;
  return bestRun > w * 0.12 ? bestRun : 0;
}

function rgb2hsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  var h = 0;
  if (d !== 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  var s = mx === 0 ? 0 : d / mx;
  return { h: h, s: s, v: mx };
}

function collectBlobs(grid, gw, gh, cellW, cellH) {
  var visited = new Uint8Array(gw * gh);
  var blobs = [];
  for (var i = 0; i < gw * gh; i++) {
    if (!grid[i] || visited[i]) continue;
    var queue = [i];
    visited[i] = 1;
    var count = 0, sx = 0, sy = 0;
    while (queue.length) {
      var idx = queue.shift();
      var gx = idx % gw, gy = Math.floor(idx / gw);
      count++; sx += gx; sy += gy;
      var neigh = [gx > 0 ? idx - 1 : -1, gx < gw - 1 ? idx + 1 : -1, gy > 0 ? idx - gw : -1, gy < gh - 1 ? idx + gw : -1];
      for (var k = 0; k < neigh.length; k++) {
        if (neigh[k] >= 0 && grid[neigh[k]] && !visited[neigh[k]]) { visited[neigh[k]] = 1; queue.push(neigh[k]); }
      }
    }
    if (count >= 2) blobs.push({ x: (sx / count) * cellW, y: (sy / count) * cellH, size: count });
  }
  return blobs.sort(function (a, b) { return b.size - a.size; }).slice(0, 8);
}

function analyseDentalImage(ctx, w, h) {
  var img = ctx.getImageData(0, 0, w, h).data;
  var toothPixels = 0, cariesPixels = 0, plaquePixels = 0, gumPixels = 0, inflamedGumPixels = 0, totalPixels = 0;
  var gridN = 16, cellW = w / gridN, cellH = h / gridN;
  var toothGrid = new Uint8Array(gridN * gridN);
  var cariesGrid = new Uint8Array(gridN * gridN);
  var plaqueGrid = new Uint8Array(gridN * gridN);

  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var i = (y * w + x) * 4;
      var r = img[i], g = img[i+1], b = img[i+2];
      var hsv = rgb2hsv(r, g, b);
      totalPixels++;
      var isTooth = hsv.v > 0.55 && hsv.s < 0.25;
      var isCaries = hsv.v > 0.55 && hsv.s < 0.25 && hsv.v < 0.7 && r < 150;
      var isPlaque = hsv.h > 35 && hsv.h < 75 && hsv.s > 0.18 && hsv.s < 0.6 && hsv.v > 0.4 && hsv.v < 0.85;
      var isGum = (hsv.h > 320 || hsv.h < 25) && hsv.s > 0.2 && hsv.v > 0.25 && hsv.v < 0.8;
      var isInflamed = isGum && hsv.s > 0.4 && hsv.v > 0.4;
      if (isTooth) toothPixels++;
      if (isCaries) {
        cariesPixels++;
        toothGrid[Math.floor(y / cellH) * gridN + Math.floor(x / cellW)] = 1;
        cariesGrid[Math.floor(y / cellH) * gridN + Math.floor(x / cellW)] = 1;
      }
      if (isPlaque) {
        plaquePixels++;
        plaqueGrid[Math.floor(y / cellH) * gridN + Math.floor(x / cellW)] = 1;
      }
      if (isGum) gumPixels++;
      if (isInflamed) inflamedGumPixels++;
    }
  }
  var toothCols = new Array(gridN).fill(0);
  for (var gx = 0; gx < gridN; gx++) {
    for (var gy = 0; gy < gridN; gy++) {
      if (toothGrid[gy * gridN + gx]) toothCols[gx]++;
    }
  }
  var toothCountEstimate = 0, inGroup = false, colThresh = gridN * 0.15;
  for (var gxc = 0; gxc < gridN; gxc++) {
    if (toothCols[gxc] > colThresh) {
      if (!inGroup) { inGroup = true; toothCountEstimate++; }
    } else inGroup = false;
  }
  toothCountEstimate = Math.min(32, Math.max(0, Math.round(toothCountEstimate * 2.2)));
  var cariesSpots = collectBlobs(cariesGrid, gridN, gridN, cellW, cellH);
  var plaqueZones = collectBlobs(plaqueGrid, gridN, gridN, cellW, cellH);
  var cariesRatio = toothPixels ? cariesPixels / toothPixels : 0;
  var plaqueRatio = toothPixels ? plaquePixels / toothPixels : 0;
  var inflammationRatio = gumPixels ? inflamedGumPixels / gumPixels : 0;
  var cariesLikely = cariesRatio > 0.04 || cariesSpots.length >= 2;
  var plaqueLikely = plaqueRatio > 0.08;
  var gingivitisLikely = inflammationRatio > 0.25 && gumPixels > totalPixels * 0.03;
  var score = 100;
  score -= cariesLikely ? 25 + cariesSpots.length * 5 : cariesRatio * 200;
  score -= plaqueLikely ? 18 : plaqueRatio * 80;
  score -= gingivitisLikely ? 20 : inflammationRatio * 40;
  score -= toothCountEstimate < 8 ? 10 : 0;
  score = Math.max(0, Math.min(100, Math.round(score)));
  return {
    toothPixels: toothPixels, totalPixels: totalPixels, cariesPixels: cariesPixels,
    plaquePixels: plaquePixels, gumPixels: gumPixels, inflamedGumPixels: inflamedGumPixels,
    toothCountEstimate: toothCountEstimate,
    cariesSpots: cariesSpots, plaqueZones: plaqueZones,
    oralHealthScore: score,
    cariesLikely: cariesLikely, plaqueLikely: plaqueLikely, gingivitisLikely: gingivitisLikely
  };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function buildDentalObservations(f) {
  var parts = [];
  parts.push('AI scan: ' + f.toothCountEstimate + ' teeth detected, oral health score ' + f.oralHealthScore + '/100.');
  if (f.cariesLikely) parts.push(f.cariesSpots.length + ' caries-like lesion(s) detected.');
  if (f.plaqueLikely) parts.push('Plaque deposits detected near gumline.');
  if (f.gingivitisLikely) parts.push('Gum inflammation consistent with gingivitis.');
  if (!f.cariesLikely && !f.plaqueLikely && !f.gingivitisLikely) parts.push('No significant pathology detected by CV screening.');
  return parts.join(' ');
}

/* ===================================================================
 * AUTH / BOOT
 * =================================================================== */
function boot() {
  // Wire up auth handlers
  $('loginForm').addEventListener('submit', onLoginSubmit);
  $('changePwForm').addEventListener('submit', onChangePwSubmit);
  $('pwToggleBtn').addEventListener('click', toggleLoginPw);
  $('ddSignOutBtn').addEventListener('click', doLogout);
  $('ddGasSourceBtn').addEventListener('click', function () { navigate('gas-source'); closeDropdown(); });
  $('userTrigger').addEventListener('click', toggleDropdown);
  document.addEventListener('click', onDocClickCloseDropdown);
  $('mobileMenuBtn').addEventListener('click', openDrawer);
  $('drawerCloseBtn').addEventListener('click', closeDrawer);
  $('drawerBackdrop').addEventListener('click', closeDrawer);

  // Demo data buttons
  $('clearCapturesBtn').addEventListener('click', onClearCapturesClick);
  $('resetDemoBtn').addEventListener('click', onResetDemoClick);

  // PWA install + service worker
  setupPWA();

  // Online/offline
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);

  // Try to resume session
  if (STATE.token) {
    api.me().then(function (data) {
      var u = normalizeUser(data.user);
      setUser(u);
      showApp();
    }).catch(function () {
      // token invalid/expired
      localStorage.removeItem('twc_token');
      STATE.token = '';
      showLogin();
    });
  } else {
    showLogin();
  }
}

function normalizeUser(raw) {
  if (!raw) return null;
  // Convert GAS API PascalCase fields to the camelCase the client uses
  var roleKey = ROLE_FROM_API[raw.role] || raw.role;
  var siteName = raw.siteName || null;
  // If siteName not provided, we'll fill it in lazily from sites cache
  if (!siteName && raw.siteId) siteName = lookupSiteName(raw.siteId);
  return {
    id: raw.userId || raw.id,
    email: raw.email,
    fullName: raw.fullName,
    role: roleKey,
    siteId: raw.siteId || null,
    siteName: siteName,
    mustChangePassword: !!raw.mustChangePassword
  };
}

function lookupSiteName(siteId) {
  if (!siteId) return null;
  for (var i = 0; i < STATE.cachedSites.length; i++) {
    if (STATE.cachedSites[i].SiteID === siteId) return STATE.cachedSites[i].Name;
  }
  return null;
}

function setUser(u) { STATE.user = u; }
function showLogin() {
  hide('appView');
  show('authView');
  show('loginCard');
  hide('changePwCard');
  // Warn the deployer if the GAS API URL hasn't been configured
  var warn = $('apiConfigWarn');
  if (warn) {
    warn.style.display = (window.TWC_API_NOT_CONFIGURED || !GAS_API_URL) ? 'block' : 'none';
  }
}
function showChangePw() {
  hide('appView');
  show('authView');
  hide('loginCard');
  show('changePwCard');
  if (STATE.user && STATE.user.email) $('changePwEmail').textContent = STATE.user.email;
}
function showApp() {
  if (!STATE.user) { showLogin(); return; }
  if (STATE.user.mustChangePassword) { showChangePw(); return; }
  hide('authView');
  show('appView');
  renderHeader();
  renderSidebar();
  renderTabbar();
  // Preload sites + outreaches + active outreach, then navigate to default view
  Promise.all([
    api.sites().then(function (r) { STATE.cachedSites = r.data || []; }).catch(function () { STATE.cachedSites = []; }),
    api.outreaches().then(function (r) { STATE.cachedOutreaches = r.data || []; }).catch(function () { STATE.cachedOutreaches = []; }),
    api.activeOutreach().then(function (r) {
      var arr = r.data || [];
      STATE.activeOutreach = arr.length ? arr[0] : null;
      STATE.activeOutreachId = STATE.activeOutreach ? STATE.activeOutreach.OutreachID : null;
    }).catch(function () { STATE.activeOutreach = null; STATE.activeOutreachId = null; })
  ]).then(function () {
    // Refresh siteName if we couldn't resolve earlier
    if (STATE.user.siteId && !STATE.user.siteName) {
      STATE.user.siteName = lookupSiteName(STATE.user.siteId);
    }
    renderHeader();
    navigate(STATE.view || 'dashboard');
  });
}

function onLoginSubmit(e) {
  e.preventDefault();
  hide('loginError');
  var email = $('loginEmail').value.trim();
  var password = $('loginPassword').value;
  if (!email || !password) { showInlineError('loginError', 'Enter email and password'); return; }
  var btn = $('loginBtn');
  btn.disabled = true; btn.textContent = 'Signing in…';
  api.login(email, password).then(function (data) {
    if (!data || !data.token || !data.user) {
      throw new Error('Login failed — the server did not return user data. Ensure initializeSheets_() and seedSuperAdmin_() have been run in the GAS project.');
    }
    STATE.token = data.token;
    localStorage.setItem('twc_token', STATE.token);
    var u = normalizeUser(data.user);
    if (!u) {
      throw new Error('Login failed — could not parse user data from server response.');
    }
    setUser(u);
    toastSuccess('Welcome, ' + (u.fullName ? u.fullName.split(' ')[0] : ''));
    showApp();
  }).catch(function (err) {
    showInlineError('loginError', err.message || 'Login failed');
    btn.disabled = false; btn.textContent = 'Sign in securely';
  });
}

function onChangePwSubmit(e) {
  e.preventDefault();
  hide('changePwError');
  var cur = $('curPw').value;
  var next = $('newPw').value;
  var conf = $('newPw2').value;
  if (next.length < 8) { showInlineError('changePwError', 'New password must be at least 8 characters'); return; }
  if (next !== conf) { showInlineError('changePwError', 'Passwords do not match'); return; }
  api.changePassword(cur, next).then(function () {
    toastSuccess('Password updated — please sign in again');
    return api.logout();
  }).then(function () {
    localStorage.removeItem('twc_token');
    STATE.token = ''; STATE.user = null;
    $('loginEmail').value = '';
    $('loginPassword').value = '';
    $('curPw').value = ''; $('newPw').value = ''; $('newPw2').value = '';
    showLogin();
  }).catch(function (err) {
    showInlineError('changePwError', err.message || 'Could not change password');
  });
}

function toggleLoginPw() {
  var inp = $('loginPassword');
  inp.type = inp.type === 'password' ? 'text' : 'password';
}

function showInlineError(id, msg) {
  var e = $(id);
  e.textContent = msg;
  e.classList.remove('hidden');
}
function clearInlineError(id) {
  var e = $(id);
  e.textContent = '';
  e.classList.add('hidden');
}

function doLogout() {
  api.logout().catch(function () {}).then(function () {
    localStorage.removeItem('twc_token');
    STATE.token = '';
    STATE.user = null;
    STATE.view = 'dashboard';
    STATE.activeOutreach = null;
    STATE.activeOutreachId = null;
    STATE.selectedPatientId = null;
    closeDropdown();
    showLogin();
    toastSuccess('Signed out');
  });
}

/* ===================================================================
 * HEADER + NAV
 * =================================================================== */
function renderHeader() {
  var u = STATE.user;
  if (!u) return;
  $('headerAvatar').textContent = initials(u.fullName);
  $('headerUserName').textContent = u.fullName ? u.fullName.split(' ')[0] : 'User';
  var rb = $('headerRoleBadge');
  rb.textContent = ROLE_LABELS[u.role];
  rb.className = 'role-badge ' + (ROLE_ACCENT_CLASS[u.role] || '');
  var site = $('headerSite');
  site.textContent = u.siteName || 'All sites';
  site.classList.remove('hidden');
  // Show "View GAS source" only for SuperAdmin
  var gas = $('ddGasSourceBtn');
  if (u.role === 'SUPER_ADMIN') gas.classList.remove('hidden');
  else gas.classList.add('hidden');
  // Dropdown
  $('ddFullName').textContent = u.fullName;
  $('ddEmail').textContent = u.email;
  $('ddRole').textContent = 'Role: ' + ROLE_LABELS[u.role];
  $('ddSite').textContent = 'Site: ' + (u.siteName || 'All sites');
}

function allowedViews() {
  if (!STATE.user) return [];
  return ROLE_MODULES[STATE.user.role] || [];
}

function renderSidebar() {
  var nav = $('sidebarNav');
  clearChildren(nav);
  allowedViews().forEach(function (v) {
    var m = VIEW_META[v];
    var btn = el('button', 'nav-item' + (STATE.view === v ? ' active' : ''));
    btn.innerHTML = '<span class="nav-ico">' + ico(m.icon) + '</span><span class="nav-lbl">' + escapeHtml(m.label) + '</span>';
    btn.addEventListener('click', function () { navigate(v); });
    nav.appendChild(btn);
  });
  // Re-render drawer nav too
  var drawer = $('drawerNav');
  if (drawer) {
    clearChildren(drawer);
    allowedViews().forEach(function (v) {
      var m = VIEW_META[v];
      var btn = el('button', 'nav-item' + (STATE.view === v ? ' active' : ''));
      btn.innerHTML = '<span class="nav-ico">' + ico(m.icon) + '</span><span class="nav-lbl">' + escapeHtml(m.label) + '</span>';
      btn.addEventListener('click', function () { navigate(v); closeDrawer(); });
      drawer.appendChild(btn);
    });
  }
  refreshIcons();
}

function renderTabbar() {
  var bar = $('tabbar');
  clearChildren(bar);
  var views = allowedViews().slice(0, 5);
  views.forEach(function (v) {
    var m = VIEW_META[v];
    var btn = el('button', 'tabbar-item' + (STATE.view === v ? ' active' : ''));
    btn.innerHTML = '<span class="tab-ico">' + ico(m.icon) + '</span><span class="tab-lbl">' + escapeHtml(m.label.split(' ')[0]) + '</span>';
    btn.addEventListener('click', function () { navigate(v); });
    bar.appendChild(btn);
  });
  refreshIcons();
}

function navigate(view) {
  if (!STATE.user) return;
  var allowed = allowedViews();
  if (allowed.indexOf(view) === -1) view = 'dashboard';
  STATE.view = view;
  // Hide all views
  $$('.view').forEach(function (s) { s.classList.add('hidden'); });
  var section = $('view-' + view);
  if (section) section.classList.remove('hidden');
  renderSidebar();
  renderTabbar();
  closeDrawer();
  // Render the view's content
  switch (view) {
    case 'dashboard':       renderDashboard(); break;
    case 'outreaches':      renderOutreaches(); break;
    case 'register-patient':renderRegisterPatient(); break;
    case 'personnel':       renderPersonnel(); break;
    case 'queue':           renderPatientQueue(); break;
    case 'vitals':          renderVitalsForm(); break;
    case 'diagnostics':     renderDiagnosticsForm(); break;
    case 'eye':             renderEyeForm(); break;
    case 'dental':          renderDentalForm(); break;
    case 'referrals':       renderReferrals(); break;
    case 'sites':           renderSites(); break;
    case 'users':           renderUsers(); break;
    case 'audit':           renderAudit(); break;
    case 'reports':         renderReports(); break;
    case 'gas-source':      renderGasSource(); break;
  }
  window.scrollTo(0, 0);
}

function toggleDropdown() {
  var dd = $('userDropdown');
  var trigger = $('userTrigger');
  var open = dd.classList.toggle('open');
  trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
}
function closeDropdown() {
  var dd = $('userDropdown');
  dd.classList.remove('open');
  $('userTrigger').setAttribute('aria-expanded', 'false');
}
function onDocClickCloseDropdown(e) {
  var dd = $('userDropdown');
  if (!dd.classList.contains('open')) return;
  // If clicked outside the user menu, close it
  var wrap = e.target.closest('.user-menu-wrap');
  if (!wrap) closeDropdown();
}

function openDrawer() {
  show('drawerBackdrop');
  var d = $('mobileDrawer');
  d.classList.add('open');
}
function closeDrawer() {
  hide('drawerBackdrop');
  var d = $('mobileDrawer');
  d.classList.remove('open');
}

/* ===================================================================
 * DASHBOARD
 * =================================================================== */
function renderDashboard() {
  var u = STATE.user;
  $('heroName').textContent = u.fullName;
  $('heroRole').textContent = ROLE_LABELS[u.role];
  $('heroSite').textContent = u.siteName || 'All sites';
  var roleIconMap = {
    SUPER_ADMIN: 'building-2', COORDINATOR: 'stethoscope', NURSE: 'heart',
    LAB_TECH: 'flask-conical', OPTOMETRIST: 'eye', DENTIST: 'smile'
  };
  $('heroRoleIcon').innerHTML = ico(roleIconMap[u.role] || 'building-2');

  // SuperAdmin demo data card
  var demoCard = $('demoDataCard');
  if (u.role === 'SUPER_ADMIN') demoCard.classList.remove('hidden');
  else demoCard.classList.add('hidden');

  // Active outreach card + stats
  var host = $('dashOutreachHost');
  clearChildren(host);

  api.activeOutreach().then(function (r) {
    var arr = r.data || [];
    STATE.activeOutreach = arr.length ? arr[0] : null;
    STATE.activeOutreachId = STATE.activeOutreach ? STATE.activeOutreach.OutreachID : null;

    if (STATE.activeOutreach) {
      var o = STATE.activeOutreach;
      var card = el('div', 'card outreach-card');
      card.innerHTML =
        '<div class="outreach-head">' +
          '<div><div class="card-eyebrow">Active Outreach</div>' +
          '<div class="card-title">' + escapeHtml(o.Name) + '</div></div>' +
          '<span class="badge badge-emerald">Active</span>' +
        '</div>' +
        '<div class="outreach-meta">' +
          '<div class="meta-row"><span class="meta-ico">' + ico('calendar-days') + '</span> ' + fmtDate(o.Date) + '</div>' +
          '<div class="meta-row"><span class="meta-ico">' + ico('map-pin') + '</span> ' + escapeHtml(o.Venue || '') + (o.SiteID ? ' · ' + escapeHtml(lookupSiteName(o.SiteID) || '') : '') + '</div>' +
          '<div class="meta-row"><span class="meta-ico">' + ico('users') + '</span> <span id="dashPatientCount">—</span> patients registered</div>' +
        '</div>';
      host.appendChild(card);
      refreshIcons();

      // Load patients for stats
      api.patients(o.OutreachID).then(function (pr) {
        var patients = pr.data || [];
        STATE.cachedPatients = patients;
        renderDashboardStats(patients);
        var cnt = $('dashPatientCount');
        if (cnt) cnt.textContent = patients.length;
      }).catch(function () { renderDashboardStats([]); });
    } else {
      var empty = el('div', 'card empty-card');
      empty.innerHTML = '<div class="empty-ico">' + ico('calendar-days') + '</div><div class="empty-title">No active outreach</div><div class="empty-sub">' +
        ((u.role === 'COORDINATOR' || u.role === 'SUPER_ADMIN') ? 'Create an outreach to begin capturing data.' : 'Your coordinator will assign an outreach.') +
        '</div>';
      host.appendChild(empty);
      hide('dashStats');
      refreshIcons();
    }
  }).catch(function () {
    var empty = el('div', 'card empty-card');
    empty.innerHTML = '<div class="empty-ico">' + ico('alert-triangle') + '</div><div class="empty-title">Could not load outreach</div>';
    host.appendChild(empty);
    hide('dashStats');
    refreshIcons();
  });
}

function renderDashboardStats(patients) {
  var u = STATE.user;
  var captured = {
    vitals: patients.filter(function (p) { return p.HasVitals; }).length,
    diagnostics: patients.filter(function (p) { return p.HasDiagnostic; }).length,
    eye: patients.filter(function (p) { return p.HasEye; }).length,
    dental: patients.filter(function (p) { return p.HasDental; }).length
  };
  var remaining = {
    vitals: patients.length - captured.vitals,
    diagnostics: patients.length - captured.diagnostics,
    eye: patients.length - captured.eye,
    dental: patients.length - captured.dental
  };
  $('statVitalsNum').textContent = captured.vitals;
  $('statDiagNum').textContent = captured.diagnostics;
  $('statEyeNum').textContent = captured.eye;
  $('statDentalNum').textContent = captured.dental;
  setPending('statVitalsPending', remaining.vitals);
  setPending('statDiagPending', remaining.diagnostics);
  setPending('statEyePending', remaining.eye);
  setPending('statDentalPending', remaining.dental);
  show('dashStats');
  // Make stat cards clickable only for the matching capture role
  setupStatClick('statVitals', u.role === 'NURSE', 'vitals');
  setupStatClick('statDiagnostics', u.role === 'LAB_TECH', 'diagnostics');
  setupStatClick('statEye', u.role === 'OPTOMETRIST', 'eye');
  setupStatClick('statDental', u.role === 'DENTIST', 'dental');
}

function setPending(id, n) {
  var e = $(id);
  if (n > 0) {
    e.textContent = n + ' pending';
    e.classList.remove('hidden');
  } else {
    e.classList.add('hidden');
  }
}
function setupStatClick(id, clickable, view) {
  var btn = $(id);
  if (clickable) {
    btn.disabled = false;
    btn.classList.remove('disabled');
    btn.onclick = function () { navigate(view); };
  } else {
    btn.disabled = true;
    btn.classList.add('disabled');
    btn.onclick = null;
  }
}

/* ===================================================================
 * DEMO DATA MANAGEMENT
 * =================================================================== */
function onClearCapturesClick() {
  showConfirmDialog({
    title: 'Clear all clinical captures?',
    body: 'This permanently deletes every vital sign, blood sugar reading, eye check, dental check and referral in the database. Patients are kept — they will all show as "pending" for re-testing. This cannot be undone.',
    confirmText: 'Yes, clear captures',
    confirmClass: 'btn-primary',
    onConfirm: function () {
      api.clearCaptures().then(function (r) {
        toastSuccess('Captures cleared — ' + (r.patientsNowPending || 0) + ' patients now pending for re-testing');
        // Refresh dashboard
        navigate('dashboard');
      }).catch(function (e) { toastError(e.message || 'Could not clear captures'); });
    }
  });
}

function onResetDemoClick() {
  showConfirmDialog({
    title: 'Reset ALL demo data?',
    body: 'This permanently deletes ALL patients, vitals, diagnostics, eye checks, dental checks, referrals, personnel invites and audit logs, then re-creates fresh demo patients. Users, sites and outreaches are preserved. This cannot be undone.',
    confirmText: 'Yes, reset everything',
    confirmClass: 'btn-danger',
    onConfirm: function () {
      api.resetDemo().then(function (r) {
        toastSuccess('Demo data reset — ' + (r.created || 0) + ' fresh patients created in "' + (r.outreach || 'Demo Outreach') + '"');
        // Refresh everything
        Promise.all([api.outreaches(), api.activeOutreach()]).then(function (results) {
          STATE.cachedOutreaches = results[0].data || [];
          var arr = results[1].data || [];
          STATE.activeOutreach = arr.length ? arr[0] : null;
          STATE.activeOutreachId = STATE.activeOutreach ? STATE.activeOutreach.OutreachID : null;
          navigate('dashboard');
        });
      }).catch(function (e) { toastError(e.message || 'Could not reset demo data'); });
    }
  });
}

function showConfirmDialog(opts) {
  var host = $('confirmHost');
  clearChildren(host);
  var overlay = el('div', 'confirm-overlay');
  var card = el('div', 'confirm-card');
  card.innerHTML =
    '<div class="confirm-title"></div>' +
    '<div class="confirm-body"></div>' +
    '<div class="confirm-actions">' +
      '<button class="btn btn-ghost cancel-btn">Cancel</button>' +
      '<button class="btn ' + (opts.confirmClass || 'btn-primary') + ' ok-btn"></button>' +
    '</div>';
  card.querySelector('.confirm-title').textContent = opts.title;
  card.querySelector('.confirm-body').textContent = opts.body;
  card.querySelector('.ok-btn').textContent = opts.confirmText || 'Confirm';
  overlay.appendChild(card);
  host.appendChild(overlay);
  setTimeout(function () { overlay.classList.add('open'); }, 10);
  function close() {
    overlay.classList.remove('open');
    setTimeout(function () { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 200);
  }
  card.querySelector('.cancel-btn').addEventListener('click', close);
  card.querySelector('.ok-btn').addEventListener('click', function () {
    close();
    if (opts.onConfirm) opts.onConfirm();
  });
  overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
}

/* ===================================================================
 * OUTREACHES (Coordinator / SuperAdmin)
 * =================================================================== */
function renderOutreaches() {
  var host = $('outreachList');
  clearChildren(host);
  api.outreaches().then(function (r) {
    STATE.cachedOutreaches = r.data || [];
    if (!STATE.cachedOutreaches.length) {
      host.appendChild(emptyState('clipboard-list', 'No outreaches yet'));
      refreshIcons();
      return;
    }
    STATE.cachedOutreaches.forEach(function (o) {
      var card = el('div', 'card outreach-row');
      card.innerHTML =
        '<div class="outreach-row-ico"><span>' + ico('calendar-days') + '</span></div>' +
        '<div class="outreach-row-body">' +
          '<div class="outreach-row-title"><span class="outreach-name"></span><span class="badge ' + (o.Status === 'Active' ? 'badge-emerald' : 'badge-secondary') + '">' + escapeHtml(o.Status) + '</span></div>' +
          '<div class="outreach-row-sub"><span class="meta-ico-inline">' + ico('map-pin') + '</span> <span class="venue"></span> · <span class="site"></span></div>' +
          '<div class="outreach-row-meta"><span class="date"></span> · <span class="count">0</span> patients</div>' +
        '</div>' +
        '<button class="btn ' + (o.Status === 'Active' ? 'btn-primary' : 'btn-outline') + ' btn-sm activate-btn">' + (o.Status === 'Active' ? 'Active' : 'Activate') + '</button>';
      card.querySelector('.outreach-name').textContent = o.Name;
      card.querySelector('.venue').textContent = o.Venue || '—';
      card.querySelector('.site').textContent = lookupSiteName(o.SiteID) || 'All sites';
      card.querySelector('.date').textContent = fmtDateShort(o.Date);
      card.querySelector('.count').textContent = o.PatientCount || 0;
      card.querySelector('.activate-btn').addEventListener('click', function () {
        STATE.activeOutreach = o;
        STATE.activeOutreachId = o.OutreachID;
        toastSuccess('"' + o.Name + '" is now the active outreach');
      });
      host.appendChild(card);
    });
    refreshIcons();
  }).catch(function (e) {
    host.appendChild(emptyState('alert-triangle', e.message || 'Could not load outreaches'));
    refreshIcons();
  });

  // Wire up new outreach button
  var btn = $('newOutreachBtn');
  btn.onclick = showCreateOutreachDialog;
}

function showCreateOutreachDialog() {
  var host = $('confirmHost');
  clearChildren(host);
  var overlay = el('div', 'confirm-overlay');
  var card = el('div', 'confirm-card confirm-card-wide');
  var siteOptions = STATE.cachedSites.map(function (s) {
    return '<option value="' + escapeHtml(s.SiteID) + '">' + escapeHtml(s.Name) + '</option>';
  }).join('');
  var canPickSite = STATE.user.role === 'SUPER_ADMIN' || !STATE.user.siteId;
  card.innerHTML =
    '<div class="confirm-title">Create outreach event</div>' +
    '<form class="confirm-form">' +
      '<div class="field"><label>Outreach name</label><input id="oName" placeholder="Surulere Community Outreach" required></div>' +
      '<div class="field"><label>Date</label><input id="oDate" type="date" required></div>' +
      '<div class="field"><label>Venue</label><input id="oVenue" placeholder="Town Hall, Lagos" required></div>' +
      (canPickSite ? '<div class="field"><label>Site</label><select id="oSite"><option value="">Select site</option>' + siteOptions + '</select></div>' : '') +
      '<div class="confirm-actions">' +
        '<button type="button" class="btn btn-ghost cancel-btn">Cancel</button>' +
        '<button type="submit" class="btn btn-primary ok-btn">Create &amp; set active</button>' +
      '</div>' +
    '</form>';
  overlay.appendChild(card);
  host.appendChild(overlay);
  setTimeout(function () { overlay.classList.add('open'); }, 10);
  function close() {
    overlay.classList.remove('open');
    setTimeout(function () { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 200);
  }
  card.querySelector('.cancel-btn').addEventListener('click', close);
  overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
  card.querySelector('form').addEventListener('submit', function (e) {
    e.preventDefault();
    var data = {
      Name: $('oName').value,
      Date: $('oDate').value,
      Venue: $('oVenue').value,
      SiteID: canPickSite ? ($('oSite') && $('oSite').value) || STATE.user.siteId : STATE.user.siteId,
      Status: 'Active'
    };
    if (!data.Name || !data.Date) { toastError('Name and date required'); return; }
    api.createOutreach(data).then(function (r) {
      toastSuccess('Outreach created & set active');
      close();
      renderOutreaches();
    }).catch(function (err) { toastError(err.message); });
  });
}

/* ===================================================================
 * REGISTER PATIENT (Coordinator)
 * =================================================================== */
var pConsent = false;
function renderRegisterPatient() {
  // Reset form
  $('patientForm').reset();
  pConsent = false;
  updateConsentBtn();
  hide('dupWarn');
  clearInlineError('patientError');

  var outreachName = STATE.activeOutreach ? STATE.activeOutreach.Name : '—';
  var siteName = STATE.activeOutreach ? (lookupSiteName(STATE.activeOutreach.SiteID) || 'All sites') : '—';
  $('regOutreach').textContent = outreachName + ' · ' + siteName;

  // Wire up consent toggle and form submit (only once — use a flag)
  $('pConsentBtn').onclick = function () { pConsent = !pConsent; updateConsentBtn(); };
  $('patientForm').onsubmit = onPatientSubmit;
  $('pName').oninput = function () { checkPatientDup(this.value); };

  // Recent registrations
  loadRecentPatients();
}

function updateConsentBtn() {
  var btn = $('pConsentBtn');
  if (pConsent) {
    btn.classList.add('checked');
    btn.setAttribute('aria-pressed', 'true');
  } else {
    btn.classList.remove('checked');
    btn.setAttribute('aria-pressed', 'false');
  }
}

function checkPatientDup(name) {
  if (!name || !name.trim()) { hide('dupWarn'); return; }
  var key = name.trim().toLowerCase();
  var exists = STATE.cachedPatients.some(function (p) {
    return String(p.FullName || '').trim().toLowerCase() === key;
  });
  if (exists) show('dupWarn'); else hide('dupWarn');
}

function onPatientSubmit(e) {
  e.preventDefault();
  clearInlineError('patientError');
  if (!pConsent) { showInlineError('patientError', 'NDPA consent is required'); return; }
  if (!STATE.activeOutreachId) { showInlineError('patientError', 'No active outreach'); return; }
  var data = {
    FullName: $('pName').value,
    Age: $('pAge').value || null,
    DOB: $('pDob').value || null,
    Sex: $('pSex').value || 'Unknown',
    Phone: $('pPhone').value || '',
    Email: $('pEmail').value || '',
    OutreachID: STATE.activeOutreachId,
    SiteID: STATE.activeOutreach ? STATE.activeOutreach.SiteID : (STATE.user.siteId || ''),
    Consent: true
  };
  api.registerPatient(data).then(function (r) {
    toastSuccess('Registered ' + r.data.PatientCode + ' — ' + r.data.FullName);
    $('patientForm').reset();
    pConsent = false; updateConsentBtn();
    loadRecentPatients();
  }).catch(function (err) {
    showInlineError('patientError', err.message || 'Could not register patient');
  });
}

function loadRecentPatients() {
  var host = $('recentPatients');
  clearChildren(host);
  if (!STATE.activeOutreachId) {
    host.appendChild(emptyState('calendar-days', 'No active outreach', 'Activate an outreach first.'));
    refreshIcons();
    return;
  }
  api.patients(STATE.activeOutreachId).then(function (r) {
    var patients = r.data || [];
    STATE.cachedPatients = patients;
    if (!patients.length) {
      host.appendChild(emptyState('circle', 'No patients registered yet'));
      refreshIcons();
      return;
    }
    patients.slice(-6).reverse().forEach(function (p) {
      var row = el('div', 'list-row');
      row.innerHTML = '<span class="badge-outline mono">' + escapeHtml(p.PatientCode) + '</span>' +
        '<span class="list-row-name"></span>' +
        '<span class="list-row-meta">' + (p.Age ? p.Age + 'y' : '') + '</span>';
      row.querySelector('.list-row-name').textContent = p.FullName;
      host.appendChild(row);
    });
    refreshIcons();
  }).catch(function () {
    host.appendChild(emptyState('alert-triangle', 'Could not load patients'));
    refreshIcons();
  });
}

/* ===================================================================
 * PERSONNEL (Coordinator)
 * =================================================================== */
function renderPersonnel() {
  $('inviteForm').reset();
  clearInlineError('inviteError');
  clearChildren($('inviteConfirmHost'));
  clearChildren($('inviteHistory'));

  var invSiteWrap = $('invSiteWrap');
  if (STATE.user.role === 'SUPER_ADMIN') {
    show('invSiteWrap');
    var sel = $('invSite');
    clearChildren(sel);
    sel.appendChild(new Option('Select site', ''));
    STATE.cachedSites.forEach(function (s) {
      sel.appendChild(new Option(s.Name, s.SiteID));
    });
  } else {
    hide('invSiteWrap');
  }

  $('inviteForm').onsubmit = onInviteSubmit;
  loadInviteHistory();
}

function onInviteSubmit(e) {
  e.preventDefault();
  clearInlineError('inviteError');
  var role = $('invRole').value;
  if (!role) { showInlineError('inviteError', 'Select a role'); return; }
  var data = {
    fullName: $('invName').value,
    email: $('invEmail').value,
    role: role,
    outreachId: STATE.activeOutreachId || '',
    siteId: STATE.user.role === 'SUPER_ADMIN' ? ($('invSite').value || STATE.user.siteId) : STATE.user.siteId
  };
  api.invitePersonnel(data).then(function (r) {
    toastSuccess('Invite emailed to ' + data.email);
    showInviteConfirmation(data.email, r.data && r.data.TempPassword, role);
    $('inviteForm').reset();
    loadInviteHistory();
  }).catch(function (err) {
    showInlineError('inviteError', err.message || 'Could not send invite');
  });
}

function showInviteConfirmation(email, temp, role) {
  var host = $('inviteConfirmHost');
  clearChildren(host);
  var card = el('div', 'card invite-confirm-card');
  card.innerHTML =
    '<div class="invite-confirm-title"><span class="ico-green">' + ico('mail') + '</span> Invite sent to <span class="email"></span></div>' +
    '<div class="invite-confirm-sub">The email contains the PWA link &amp; this temporary password (expires on first login):</div>' +
    '<div class="temp-pw-row"><code class="temp-pw"></code><button class="btn btn-ghost btn-sm copy-btn">' + ico('copy') + ' Copy</button></div>' +
    '<div class="invite-confirm-role"></div>';
  card.querySelector('.email').textContent = email;
  card.querySelector('.temp-pw').textContent = temp || '—';
  card.querySelector('.invite-confirm-role').textContent = 'Role: ' + (ROLE_LABELS[ROLE_FROM_API[role]] || role);
  card.querySelector('.copy-btn').addEventListener('click', function () {
    if (temp) {
      navigator.clipboard.writeText(temp).then(function () {
        toastSuccess('Copied');
      }).catch(function () { toastError('Could not copy'); });
    }
  });
  host.appendChild(card);
  refreshIcons();
}

function loadInviteHistory() {
  var host = $('inviteHistory');
  clearChildren(host);
  api.invites(STATE.activeOutreachId).then(function (r) {
    var invites = r.data || [];
    if (!invites.length) {
      host.appendChild(emptyState('mail', 'No invites sent yet.'));
      refreshIcons();
      return;
    }
    invites.forEach(function (i) {
      var row = el('div', 'list-row');
      row.innerHTML =
        '<div class="list-row-icon">' + ico('users') + '</div>' +
        '<div class="list-row-body">' +
          '<div class="list-row-title"><span class="name"></span> <span class="muted">· <span class="role"></span></span></div>' +
          '<div class="list-row-sub email"></div>' +
        '</div>' +
        '<span class="badge ' + (i.Status === 'Sent' ? 'badge-secondary' : 'badge-emerald') + '">' + escapeHtml(i.Status) + '</span>';
      row.querySelector('.name').textContent = i.FullName;
      row.querySelector('.role').textContent = ROLE_LABELS[ROLE_FROM_API[i.Role]] || i.Role;
      row.querySelector('.email').textContent = i.Email;
      host.appendChild(row);
    });
    refreshIcons();
  }).catch(function () {
    host.appendChild(emptyState('alert-triangle', 'Could not load invites'));
    refreshIcons();
  });
}

/* ===================================================================
 * PATIENT QUEUE
 * =================================================================== */
function renderPatientQueue() {
  var u = STATE.user;
  var cap = ROLE_CAPTURE[u.role];
  var hint = $('queueHint');
  if (cap) hint.textContent = 'Tap a patient to capture ' + cap.label + '. Green = done.';
  else hint.textContent = '';

  $('queueSearch').value = '';
  $('queueSearch').oninput = function () { renderQueueList(); };

  $('queueOutreachName').textContent = STATE.activeOutreach ? STATE.activeOutreach.Name : 'No active outreach';

  if (!STATE.activeOutreachId) {
    clearChildren($('queueList'));
    $('queueList').appendChild(emptyState('circle', 'No patients in queue', 'Patients appear here as soon as the coordinator registers them.'));
    $('queueCount').textContent = 0;
    refreshIcons();
    return;
  }
  api.patients(STATE.activeOutreachId).then(function (r) {
    STATE.cachedPatients = r.data || [];
    $('queueCount').textContent = STATE.cachedPatients.length;
    renderQueueList();
  }).catch(function () {
    clearChildren($('queueList'));
    $('queueList').appendChild(emptyState('alert-triangle', 'Could not load queue'));
    refreshIcons();
  });
}

function renderQueueList() {
  var host = $('queueList');
  clearChildren(host);
  var u = STATE.user;
  var cap = u.role !== 'SUPER_ADMIN' ? ROLE_CAPTURE[u.role] : null;
  var q = ($('queueSearch').value || '').trim().toLowerCase();
  var patients = STATE.cachedPatients.filter(function (p) {
    if (!q) return true;
    return (p.FullName || '').toLowerCase().indexOf(q) !== -1 ||
           (p.PatientCode || '').toLowerCase().indexOf(q) !== -1;
  });
  if (!patients.length) {
    host.appendChild(emptyState('circle', 'No patients in queue', 'Patients appear here as soon as the coordinator registers them.'));
    refreshIcons();
    return;
  }
  patients.forEach(function (p) {
    var done = cap ? !!(p[cap.key] || p[cap.key.charAt(0).toLowerCase() + cap.key.slice(1)] || p[cap.key.toLowerCase()]) : false;
    // The GAS API returns PascalCase fields. Map "hasVitals"→"HasVitals" etc.
    var pascaled = cap ? ('Has' + cap.key.charAt(3).toUpperCase() + cap.key.slice(4)) : null;
    done = cap ? !!p[pascaled] : false;
    var selected = STATE.selectedPatientId === p.PatientID;
    var row = el('button', 'queue-row' + (selected ? ' selected' : ''));
    var avatarCls = done ? 'avatar done' : 'avatar';
    var avatarBg = done ? '' : ' muted';
    var statusIndicator;
    if (cap) {
      statusIndicator = done
        ? '<span class="status-dot done">' + ico('check-circle-2') + '</span>'
        : '<span class="status-dot pending">' + ico('circle') + '</span>';
    } else {
      // SuperAdmin: show all capture dots
      statusIndicator = '<span class="status-dots">' +
        (p.HasVitals ? '<span class="mini-dot emerald"></span>' : '') +
        (p.HasDiagnostic ? '<span class="mini-dot amber"></span>' : '') +
        (p.HasEye ? '<span class="mini-dot sky"></span>' : '') +
        (p.HasDental ? '<span class="mini-dot rose"></span>' : '') +
      '</span>';
    }
    row.innerHTML =
      '<div class="' + avatarCls + avatarBg + '">' + escapeHtml(initials(p.FullName)) + '</div>' +
      '<div class="queue-row-body">' +
        '<div class="queue-row-title"><span class="name"></span><span class="badge-outline mono">' + escapeHtml(p.PatientCode) + '</span></div>' +
        '<div class="queue-row-sub"></div>' +
      '</div>' +
      statusIndicator;
    row.querySelector('.name').textContent = p.FullName;
    var subParts = [];
    if (p.Age) subParts.push(p.Age + 'y');
    if (p.Sex && p.Sex !== 'Unknown') subParts.push(p.Sex);
    if (p.Phone) subParts.push(p.Phone);
    row.querySelector('.queue-row-sub').textContent = subParts.join(' · ');
    row.addEventListener('click', function () { pickPatient(p.PatientID); });
    host.appendChild(row);
  });
  refreshIcons();
}

function pickPatient(id) {
  STATE.selectedPatientId = id;
  var u = STATE.user;
  if (u.role === 'NURSE') navigate('vitals');
  else if (u.role === 'LAB_TECH') navigate('diagnostics');
  else if (u.role === 'OPTOMETRIST') navigate('eye');
  else if (u.role === 'DENTIST') navigate('dental');
}

/* ===================================================================
 * CAPTURE FORMS — VITALS / DIAGNOSTICS / EYE / DENTAL
 * =================================================================== */
function renderPatientHeader(targetView, onBack) {
  // Loads the selected patient + back button into the section element
  var section = $('view-' + targetView);
  clearChildren(section);
  if (!STATE.selectedPatientId) {
    // Render the queue inline instead
    section.appendChild(el('div', '', '<div class="page-head"><h1>Patient Queue</h1><p>Select a patient to capture data.</p></div>'));
    var listHost = el('div'); listHost.id = 'inlineQueue';
    section.appendChild(listHost);
    // Reuse renderPatientQueue into this host by temporarily re-pointing
    renderPatientQueueInto(listHost);
    return null;
  }
  // Patient header
  api.patient(STATE.selectedPatientId).then(function (r) {
    var p = r.data;
    if (!p) { section.appendChild(emptyState('alert-triangle', 'Patient not found')); refreshIcons(); return; }
    var head = el('div', 'card patient-header-card');
    head.innerHTML =
      '<button class="icon-btn back-btn">' + ico('arrow-left') + '</button>' +
      '<div class="avatar avatar-primary">' + escapeHtml(initials(p.FullName)) + '</div>' +
      '<div class="patient-header-body">' +
        '<div class="patient-header-title"><span class="name"></span><span class="badge-outline mono">' + escapeHtml(p.PatientCode) + '</span></div>' +
        '<div class="patient-header-sub"></div>' +
      '</div>';
    head.querySelector('.name').textContent = p.FullName;
    var subParts = [];
    if (p.Age) subParts.push(p.Age + 'y');
    if (p.Sex && p.Sex !== 'Unknown') subParts.push(p.Sex);
    if (STATE.activeOutreach) subParts.push(STATE.activeOutreach.Name);
    head.querySelector('.patient-header-sub').textContent = subParts.join(' · ');
    head.querySelector('.back-btn').addEventListener('click', onBack);
    section.insertBefore(head, section.firstChild);
    refreshIcons();
  }).catch(function () {
    section.appendChild(emptyState('alert-triangle', 'Could not load patient'));
    refreshIcons();
  });
  return section;
}

function renderPatientQueueInto(host) {
  // Loads patients and renders a clickable queue inside `host`
  if (!STATE.activeOutreachId) {
    host.appendChild(emptyState('circle', 'No active outreach'));
    refreshIcons();
    return;
  }
  host.appendChild(el('div', 'search-wrap', '<span class="search-ico">' + ico('search') + '</span>'));
  var input = el('input');
  input.type = 'search'; input.placeholder = 'Search by name or patient code…';
  host.querySelector('.search-wrap').appendChild(input);
  var list = el('div', 'queue-list');
  host.appendChild(list);
  function drawList() {
    clearChildren(list);
    var q = (input.value || '').toLowerCase();
    api.patients(STATE.activeOutreachId).then(function (r) {
      var patients = (r.data || []).filter(function (p) {
        return !q || (p.FullName || '').toLowerCase().indexOf(q) !== -1 || (p.PatientCode || '').toLowerCase().indexOf(q) !== -1;
      });
      STATE.cachedPatients = r.data || [];
      if (!patients.length) { list.appendChild(emptyState('circle', 'No patients')); refreshIcons(); return; }
      var u = STATE.user;
      patients.forEach(function (p) {
        var row = el('button', 'queue-row');
        row.innerHTML =
          '<div class="avatar muted">' + escapeHtml(initials(p.FullName)) + '</div>' +
          '<div class="queue-row-body"><div class="queue-row-title"><span class="name"></span><span class="badge-outline mono">' + escapeHtml(p.PatientCode) + '</span></div><div class="queue-row-sub"></div></div>';
        row.querySelector('.name').textContent = p.FullName;
        var sub = [];
        if (p.Age) sub.push(p.Age + 'y');
        if (p.Sex && p.Sex !== 'Unknown') sub.push(p.Sex);
        row.querySelector('.queue-row-sub').textContent = sub.join(' · ');
        row.addEventListener('click', function () {
          STATE.selectedPatientId = p.PatientID;
          navigate(u.role === 'NURSE' ? 'vitals' : u.role === 'LAB_TECH' ? 'diagnostics' : u.role === 'OPTOMETRIST' ? 'eye' : 'dental');
        });
        list.appendChild(row);
      });
      refreshIcons();
    });
  }
  input.addEventListener('input', drawList);
  drawList();
}

function backToQueue() {
  STATE.selectedPatientId = null;
  navigate('queue');
}

/* ---- VITALS FORM (Nurse) ---- */
var vitalsForm = { bpSystolic: '', bpDiastolic: '', weightKg: '', heightCm: '', tempC: '', spo2: '', pulse: '', notes: '' };
function renderVitalsForm() {
  var section = renderPatientHeader('vitals', backToQueue);
  if (!STATE.selectedPatientId) return;

  var card = el('div', 'card form-card');
  card.innerHTML =
    '<div class="card-title-lg"><span class="ico-primary">' + ico('stethoscope') + '</span> Vital Signs</div>' +
    '<div class="contactless-launcher">' +
      '<div class="launcher-row">' +
        '<div class="launcher-ico emerald">' + ico('heart') + '</div>' +
        '<div class="launcher-body"><div class="launcher-title">Contactless Vitals</div>' +
        '<div class="launcher-sub">Uses the device camera (front or back) to extract BP, pulse &amp; SpO₂ without contact. 15-second capture. Screening grade.</div></div>' +
      '</div>' +
      '<button type="button" class="btn btn-outline btn-block contactless-launch-btn">' + ico('camera') + ' Launch contactless capture</button>' +
    '</div>' +
    '<div class="field-row">' +
      '<div class="field"><label>BP Systolic (mmHg)</label><input id="vSys" type="number" inputmode="numeric" placeholder="120"></div>' +
      '<div class="field"><label>BP Diastolic (mmHg)</label><input id="vDia" type="number" inputmode="numeric" placeholder="80"></div>' +
    '</div>' +
    '<div class="field-row">' +
      '<div class="field"><label>Weight (kg)</label><input id="vWeight" type="number" step="0.1" inputmode="decimal" placeholder="70"></div>' +
      '<div class="field"><label>Height (cm)</label><input id="vHeight" type="number" step="0.1" inputmode="decimal" placeholder="170"></div>' +
    '</div>' +
    '<div class="bmi-readout"><div><div class="bmi-label">BMI (auto)</div><div class="bmi-value" id="bmiValue">—</div></div><span class="badge bmi-cat hidden" id="bmiCat"></span></div>' +
    '<div class="field-row-3">' +
      '<div class="field"><label>Temp (°C)</label><input id="vTemp" type="number" step="0.1" inputmode="decimal" placeholder="36.7"></div>' +
      '<div class="field"><label>SpO₂ (%)</label><input id="vSpo2" type="number" inputmode="numeric" placeholder="98"></div>' +
      '<div class="field"><label>Pulse (bpm)</label><input id="vPulse" type="number" inputmode="numeric" placeholder="76"></div>' +
    '</div>' +
    '<div class="field"><label>Notes</label><textarea id="vNotes" rows="3" placeholder="Optional observations…"></textarea></div>' +
    '<button type="button" class="btn btn-primary btn-block btn-lg save-vitals-btn">' + ico('save') + ' Save vital signs</button>';
  section.appendChild(card);
  refreshIcons();

  // Restore values
  $('vSys').value = vitalsForm.bpSystolic;
  $('vDia').value = vitalsForm.bpDiastolic;
  $('vWeight').value = vitalsForm.weightKg;
  $('vHeight').value = vitalsForm.heightCm;
  $('vTemp').value = vitalsForm.tempC;
  $('vSpo2').value = vitalsForm.spo2;
  $('vPulse').value = vitalsForm.pulse;
  $('vNotes').value = vitalsForm.notes;
  updateBMI();

  ['vSys','vDia','vWeight','vHeight','vTemp','vSpo2','vPulse','vNotes'].forEach(function (id) {
    $(id).addEventListener('input', function () {
      var map = { vSys:'bpSystolic', vDia:'bpDiastolic', vWeight:'weightKg', vHeight:'heightCm', vTemp:'tempC', vSpo2:'spo2', vPulse:'pulse', vNotes:'notes' };
      vitalsForm[map[id]] = this.value;
      if (id === 'vWeight' || id === 'vHeight') updateBMI();
    });
  });

  card.querySelector('.contactless-launch-btn').addEventListener('click', openRppgTool);
  card.querySelector('.save-vitals-btn').addEventListener('click', saveVitals);
}

function calcBMI(w, h) {
  if (!w || !h || h <= 0) return null;
  var hm = h / 100;
  return Math.round((w / (hm * hm)) * 10) / 10;
}

function updateBMI() {
  var w = parseFloat(vitalsForm.weightKg) || 0;
  var h = parseFloat(vitalsForm.heightCm) || 0;
  var bmi = calcBMI(w, h);
  var valEl = $('bmiValue');
  var catEl = $('bmiCat');
  if (valEl) valEl.textContent = bmi != null ? bmi : '—';
  if (catEl) {
    if (bmi == null) { catEl.classList.add('hidden'); }
    else {
      catEl.classList.remove('hidden');
      var cat, cls;
      if (bmi < 18.5) { cat = 'Underweight'; cls = 'badge-amber'; }
      else if (bmi < 25) { cat = 'Normal'; cls = 'badge-emerald'; }
      else if (bmi < 30) { cat = 'Overweight'; cls = 'badge-amber'; }
      else { cat = 'Obese'; cls = 'badge-amber'; }
      catEl.textContent = cat;
      catEl.className = 'badge bmi-cat ' + cls;
    }
  }
}

function saveVitals() {
  var data = {
    PatientID: STATE.selectedPatientId,
    OutreachID: STATE.activeOutreachId,
    BPSystolic: vitalsForm.bpSystolic || null,
    BPDiastolic: vitalsForm.bpDiastolic || null,
    WeightKg: vitalsForm.weightKg || null,
    HeightCm: vitalsForm.heightCm || null,
    TempC: vitalsForm.tempC || null,
    SpO2: vitalsForm.spo2 || null,
    Pulse: vitalsForm.pulse || null,
    Notes: vitalsForm.notes || null
  };
  api.saveVitals(data).then(function () {
    toastSuccess('Vital signs saved');
    // Reset form
    vitalsForm = { bpSystolic: '', bpDiastolic: '', weightKg: '', heightCm: '', tempC: '', spo2: '', pulse: '', notes: '' };
    backToQueue();
  }).catch(function (e) { toastError(e.message); });
}

/* ---- DIAGNOSTICS FORM (Lab Tech) ---- */
var diagForm = { testType: 'Fasting', unit: 'mg/dL', value: '', notes: '' };
function renderDiagnosticsForm() {
  var section = renderPatientHeader('diagnostics', backToQueue);
  if (!STATE.selectedPatientId) return;
  var card = el('div', 'card form-card');
  card.innerHTML =
    '<div class="card-title-lg"><span class="ico-primary">' + ico('activity') + '</span> Blood Sugar Test</div>' +
    '<div class="field"><label>Test type</label><div class="radio-grid-2">' +
      '<button type="button" class="radio-btn test-fast">Fasting</button>' +
      '<button type="button" class="radio-btn test-rand">Random</button>' +
    '</div></div>' +
    '<div class="field"><label>Unit</label><div class="radio-grid-2">' +
      '<button type="button" class="radio-btn unit-mgdl">mg/dL</button>' +
      '<button type="button" class="radio-btn unit-mmol">mmol/L</button>' +
    '</div></div>' +
    '<div class="field"><label>Blood sugar value (<span id="diagUnitLbl">mg/dL</span>)</label><input id="diagVal" type="number" step="0.1" inputmode="decimal"></div>' +
    '<div class="interpretation hidden" id="diagInterp"><span class="interp-lbl">Interpretation</span><span class="badge" id="diagInterpBadge"></span></div>' +
    '<div class="field"><label>Notes</label><textarea id="diagNotes" rows="3" placeholder="Optional…"></textarea></div>' +
    '<button type="button" class="btn btn-primary btn-block btn-lg save-diag-btn">' + ico('save') + ' Save reading</button>';
  section.appendChild(card);
  refreshIcons();

  function refresh() {
    card.querySelector('.test-fast').classList.toggle('active', diagForm.testType === 'Fasting');
    card.querySelector('.test-rand').classList.toggle('active', diagForm.testType === 'Random');
    card.querySelector('.unit-mgdl').classList.toggle('active', diagForm.unit === 'mg/dL');
    card.querySelector('.unit-mmol').classList.toggle('active', diagForm.unit === 'mmol/L');
    $('diagUnitLbl').textContent = diagForm.unit;
    $('diagVal').value = diagForm.value;
    $('diagNotes').value = diagForm.notes;
    updateInterp();
  }
  function updateInterp() {
    var num = parseFloat(diagForm.value);
    if (!num || num <= 0) { hide('diagInterp'); return; }
    var flag;
    if (diagForm.unit === 'mg/dL') {
      if (diagForm.testType === 'Fasting') flag = num >= 126 ? 'Diabetic range' : num >= 100 ? 'Pre-diabetic' : 'Normal';
      else flag = num >= 200 ? 'Diabetic range' : num >= 140 ? 'Pre-diabetic' : 'Normal';
    } else {
      if (diagForm.testType === 'Fasting') flag = num >= 7 ? 'Diabetic range' : num >= 6.1 ? 'Pre-diabetic' : 'Normal';
      else flag = num >= 11.1 ? 'Diabetic range' : num >= 7.8 ? 'Pre-diabetic' : 'Normal';
    }
    var badge = $('diagInterpBadge');
    badge.textContent = flag;
    badge.className = 'badge ' + (flag === 'Normal' ? 'badge-emerald' : 'badge-amber');
    show('diagInterp');
  }
  card.querySelector('.test-fast').onclick = function () { diagForm.testType = 'Fasting'; refresh(); };
  card.querySelector('.test-rand').onclick = function () { diagForm.testType = 'Random'; refresh(); };
  card.querySelector('.unit-mgdl').onclick = function () { diagForm.unit = 'mg/dL'; refresh(); };
  card.querySelector('.unit-mmol').onclick = function () { diagForm.unit = 'mmol/L'; refresh(); };
  $('diagVal').oninput = function () { diagForm.value = this.value; updateInterp(); };
  $('diagNotes').oninput = function () { diagForm.notes = this.value; };
  card.querySelector('.save-diag-btn').onclick = function () {
    if (!diagForm.value) { toastError('Enter a reading'); return; }
    api.saveDiagnostic({
      PatientID: STATE.selectedPatientId,
      OutreachID: STATE.activeOutreachId,
      TestType: diagForm.testType,
      BloodSugar: Number(diagForm.value),
      Unit: diagForm.unit,
      Notes: diagForm.notes
    }).then(function () {
      toastSuccess('Blood sugar reading saved');
      diagForm = { testType: 'Fasting', unit: 'mg/dL', value: '', notes: '' };
      backToQueue();
    }).catch(function (e) { toastError(e.message); });
  };
  refresh();
}

/* ---- EYE CHECK FORM (Optometrist) ---- */
var eyeForm = { vaResult: null, observations: '', referralNeeded: false };
function renderEyeForm() {
  var section = renderPatientHeader('eye', backToQueue);
  if (!STATE.selectedPatientId) return;
  var card = el('div', 'card form-card');
  card.innerHTML =
    '<div class="card-title-lg"><span class="ico-primary">' + ico('eye') + '</span> Eye Check</div>' +
    '<div class="va-launcher">' +
      '<div class="launcher-row"><div class="launcher-ico teal">' + ico('maximize-2') + '</div>' +
      '<div class="launcher-body"><div class="launcher-title">Digital Visual Acuity Tool</div>' +
      '<div class="launcher-sub">Fullscreen · front camera · auto distance via face-width &amp; pinhole model · tumbling-E Snellen chart.</div></div></div>' +
      '<button type="button" class="btn btn-primary btn-block va-launch-btn">' + ico('camera') + ' Launch acuity test</button>' +
    '</div>' +
    '<div class="va-results-grid hidden" id="vaResultsGrid">' +
      '<div class="va-result-card"><div class="va-result-lbl">Right Eye (OD)</div><div class="va-result-frac" id="vaRightFrac">—</div><div class="va-result-meta" id="vaRightMeta"></div></div>' +
      '<div class="va-result-card"><div class="va-result-lbl">Left Eye (OS)</div><div class="va-result-frac" id="vaLeftFrac">—</div><div class="va-result-meta" id="vaLeftMeta"></div></div>' +
    '</div>' +
    '<div class="field"><label>Observations</label><textarea id="eyeObs" rows="3" placeholder="Optional findings (e.g. redness, foreign body)…"></textarea></div>' +
    '<button type="button" class="toggle-btn eye-referral-btn"><span>Referral needed</span><span class="toggle-box">' + ico('check') + '</span></button>' +
    '<button type="button" class="btn btn-primary btn-block btn-lg save-eye-btn">' + ico('save') + ' Save eye check</button>';
  section.appendChild(card);
  refreshIcons();

  $('eyeObs').value = eyeForm.observations;
  var refBtn = card.querySelector('.eye-referral-btn');
  refBtn.classList.toggle('checked', eyeForm.referralNeeded);
  refBtn.onclick = function () { eyeForm.referralNeeded = !eyeForm.referralNeeded; refBtn.classList.toggle('checked', eyeForm.referralNeeded); };
  $('eyeObs').oninput = function () { eyeForm.observations = this.value; };
  card.querySelector('.va-launch-btn').onclick = openVisualAcuityTool;
  card.querySelector('.save-eye-btn').onclick = function () {
    api.saveEyeCheck({
      PatientID: STATE.selectedPatientId,
      OutreachID: STATE.activeOutreachId,
      VARightDistance: eyeForm.vaResult && eyeForm.vaResult.right ? eyeForm.vaResult.right.distance : null,
      VALeftDistance: eyeForm.vaResult && eyeForm.vaResult.left ? eyeForm.vaResult.left.distance : null,
      VARightLine: eyeForm.vaResult && eyeForm.vaResult.right ? eyeForm.vaResult.right.line.frac : null,
      VALeftLine: eyeForm.vaResult && eyeForm.vaResult.left ? eyeForm.vaResult.left.line.frac : null,
      VARightDecimal: eyeForm.vaResult && eyeForm.vaResult.right ? eyeForm.vaResult.right.line.decimal : null,
      VALeftDecimal: eyeForm.vaResult && eyeForm.vaResult.left ? eyeForm.vaResult.left.line.decimal : null,
      Observations: eyeForm.observations,
      ReferralNeeded: eyeForm.referralNeeded
    }).then(function () {
      toastSuccess('Eye check saved');
      eyeForm = { vaResult: null, observations: '', referralNeeded: false };
      backToQueue();
    }).catch(function (e) { toastError(e.message); });
  };
  // Render existing VA results if any
  if (eyeForm.vaResult) renderVaResults(eyeForm.vaResult);
}

function renderVaResults(r) {
  var grid = $('vaResultsGrid');
  if (!grid) return;
  grid.classList.remove('hidden');
  $('vaRightFrac').textContent = r.right ? r.right.line.frac : '—';
  $('vaRightMeta').textContent = (r.right ? r.right.distance + 'm · decimal ' + r.right.line.decimal : '');
  $('vaLeftFrac').textContent = r.left ? r.left.line.frac : '—';
  $('vaLeftMeta').textContent = (r.left ? r.left.distance + 'm · decimal ' + r.left.line.decimal : '');
}

/* ---- DENTAL CHECK FORM (Dentist) ---- */
var dentalForm = { oralHealth: 'Good', cariesPresent: false, gingivitis: false, missingTeeth: '0', observations: '', referralNeeded: false };
function renderDentalForm() {
  var section = renderPatientHeader('dental', backToQueue);
  if (!STATE.selectedPatientId) return;
  var card = el('div', 'card form-card');
  card.innerHTML =
    '<div class="card-title-lg"><span class="ico-primary">' + ico('stethoscope') + '</span> Dental Check</div>' +
    '<div class="dental-launcher">' +
      '<div class="launcher-row"><div class="launcher-ico rose">' + ico('camera') + '</div>' +
      '<div class="launcher-body"><div class="launcher-title">AI Dental Scan <span class="badge-outline tiny">Computer vision</span></div>' +
      '<div class="launcher-sub">Back camera + flash examines teeth for caries, plaque &amp; gingivitis. Auto-fills the form below. Screening grade.</div></div></div>' +
      '<button type="button" class="btn btn-outline btn-block dental-launch-btn" style="border-color:#f43f5e;color:#be123c;">' + ico('camera') + ' Launch dental scan</button>' +
    '</div>' +
    '<div class="field"><label>Overall oral health</label><div class="radio-grid-3">' +
      ['Good','Fair','Poor'].map(function (o) {
        return '<button type="button" class="radio-btn oral-btn" data-val="' + o + '">' + o.charAt(0).toUpperCase() + o.slice(1) + '</button>';
      }).join('') +
    '</div></div>' +
    '<div class="field-row">' +
      '<button type="button" class="toggle-btn dental-caries-btn"><span>Caries present</span><span class="toggle-box">' + ico('check') + '</span></button>' +
      '<button type="button" class="toggle-btn dental-ging-btn"><span>Gingivitis</span><span class="toggle-box">' + ico('check') + '</span></button>' +
    '</div>' +
    '<div class="field"><label>Missing teeth (count)</label><input id="dMissing" type="number" inputmode="numeric" value="0"></div>' +
    '<div class="field"><label>Observations</label><textarea id="dObs" rows="3" placeholder="Optional…"></textarea></div>' +
    '<button type="button" class="toggle-btn dental-ref-btn"><span>Referral needed</span><span class="toggle-box">' + ico('check') + '</span></button>' +
    '<button type="button" class="btn btn-primary btn-block btn-lg save-dental-btn">' + ico('save') + ' Save dental check</button>';
  section.appendChild(card);
  refreshIcons();

  function refresh() {
    $$('.oral-btn', card).forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-val') === dentalForm.oralHealth);
    });
    card.querySelector('.dental-caries-btn').classList.toggle('checked', dentalForm.cariesPresent);
    card.querySelector('.dental-ging-btn').classList.toggle('checked', dentalForm.gingivitis);
    card.querySelector('.dental-ref-btn').classList.toggle('checked', dentalForm.referralNeeded);
    $('dMissing').value = dentalForm.missingTeeth;
    $('dObs').value = dentalForm.observations;
  }
  $$('.oral-btn', card).forEach(function (b) {
    b.onclick = function () { dentalForm.oralHealth = b.getAttribute('data-val'); refresh(); };
  });
  card.querySelector('.dental-caries-btn').onclick = function () { dentalForm.cariesPresent = !dentalForm.cariesPresent; refresh(); };
  card.querySelector('.dental-ging-btn').onclick = function () { dentalForm.gingivitis = !dentalForm.gingivitis; refresh(); };
  card.querySelector('.dental-ref-btn').onclick = function () { dentalForm.referralNeeded = !dentalForm.referralNeeded; refresh(); };
  $('dMissing').oninput = function () { dentalForm.missingTeeth = this.value; };
  $('dObs').oninput = function () { dentalForm.observations = this.value; };
  card.querySelector('.dental-launch-btn').onclick = openDentalScanTool;
  card.querySelector('.save-dental-btn').onclick = function () {
    api.saveDentalCheck({
      PatientID: STATE.selectedPatientId,
      OutreachID: STATE.activeOutreachId,
      OralHealth: dentalForm.oralHealth,
      CariesPresent: dentalForm.cariesPresent,
      Gingivitis: dentalForm.gingivitis,
      MissingTeeth: Number(dentalForm.missingTeeth) || 0,
      Observations: dentalForm.observations,
      ReferralNeeded: dentalForm.referralNeeded
    }).then(function () {
      toastSuccess('Dental check saved');
      dentalForm = { oralHealth: 'Good', cariesPresent: false, gingivitis: false, missingTeeth: '0', observations: '', referralNeeded: false };
      backToQueue();
    }).catch(function (e) { toastError(e.message); });
  };
  refresh();
}

/* ===================================================================
 * CONTACTLESS VITALS TOOL (fullscreen overlay)
 * =================================================================== */
var rppgState = {
  mode: 'live',
  status: 'idle',
  progress: 0,
  hr: null,
  spo2: null,
  bp: null,
  roiBox: null,
  faceDetected: false,
  frameDims: { w: 120, h: 90 },
  cameraFacing: 'user',
  greenBuf: [], redBuf: [], blueBuf: [], timeBuf: [], liveWave: [],
  stream: null, raf: null, progTimer: null
};

function openRppgTool() {
  show('rppgOverlay');
  resetRppgState();
  renderRppgIdle();
  requestOverlayFullscreen($('rppgOverlay'));
}
function closeRppgTool(useResults) {
  stopRppgAll();
  hide('rppgOverlay');
  if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
  if (useResults && rppgState.hr != null) {
    vitalsForm.bpSystolic = rppgState.bp && rppgState.bp.s ? String(rppgState.bp.s) : '';
    vitalsForm.bpDiastolic = rppgState.bp && rppgState.bp.d ? String(rppgState.bp.d) : '';
    vitalsForm.spo2 = rppgState.spo2 != null ? String(rppgState.spo2) : '';
    vitalsForm.pulse = rppgState.hr != null ? String(rppgState.hr) : '';
    var method = 'Contactless camera measurement — screening grade';
    var note = '[Contactless] MAP ' + (rppgState.bp && rppgState.bp.m ? rppgState.bp.m : '—') + ' mmHg, confidence ' + Math.round((rppgState.bp && rppgState.bp.conf || 0) * 100) + '%. ' + method + '.';
    vitalsForm.notes = (vitalsForm.notes ? vitalsForm.notes + ' ' : '') + note;
    // Re-render the form to reflect populated values
    renderVitalsForm();
    toastSuccess('Contactless vitals populated — review & save');
  }
}

function resetRppgState() {
  rppgState.greenBuf = []; rppgState.redBuf = []; rppgState.blueBuf = [];
  rppgState.timeBuf = []; rppgState.liveWave = [];
  rppgState.hr = null; rppgState.spo2 = null; rppgState.bp = null;
  rppgState.roiBox = null; rppgState.faceDetected = false;
  rppgState.progress = 0; rppgState.status = 'idle';
}

function stopRppgAll() {
  if (rppgState.raf) cancelAnimationFrame(rppgState.raf);
  rppgState.raf = null;
  if (rppgState.progTimer) clearInterval(rppgState.progTimer);
  rppgState.progTimer = null;
  if (rppgState.stream) {
    rppgState.stream.getTracks().forEach(function (t) { t.stop(); });
    rppgState.stream = null;
  }
}

function renderRppgIdle() {
  var body = $('rppgBody');
  clearChildren(body);
  var wrap = el('div', 'overlay-center');
  wrap.innerHTML =
    '<div class="rppg-idle">' +
      '<div class="big-ico emerald">' + ico('heart') + '</div>' +
      '<div class="idle-title">Contactless Vital Signs</div>' +
      '<div class="idle-desc">The camera measures light reflected off exposed skin to extract pulse, SpO₂ and a blood-pressure screening estimate. No contact. 15-second capture.</div>' +
      '<button class="btn btn-success btn-block btn-lg start-live-btn">' + ico('camera') + ' Start live capture</button>' +
      '<button class="btn btn-outline btn-block btn-lg demo-btn">' + ico('waves') + ' Demo mode (no camera)</button>' +
      '<div class="cam-switch-row"><span>' + ico('camera') + ' Active camera: <span id="rppgCamLbl">Front</span></span> <button class="cam-switch-link switch-btn">' + ico('switch-camera') + ' Switch</button></div>' +
      '<div class="screening-disclaimer"><strong>Screening grade.</strong> For triage only. Blood pressure requires validation against a calibrated cuff. Not a medical device.</div>' +
    '</div>';
  body.appendChild(wrap);
  wrap.querySelector('.start-live-btn').onclick = function () { startRppgLive(); };
  wrap.querySelector('.demo-btn').onclick = startRppgDemo;
  wrap.querySelector('.switch-btn').onclick = switchRppgCamera;
  refreshIcons();
}

function rppgLoop() {
  var video = $('rppgVideo');
  var canvas = $('rppgCanvas');
  if (!video || !canvas || !video.videoWidth || rppgState.status !== 'capturing') {
    rppgState.raf = requestAnimationFrame(rppgLoop);
    return;
  }
  var w = 120;
  var h = Math.round((video.videoHeight / video.videoWidth) * w);
  canvas.width = w; canvas.height = h;
  rppgState.frameDims = { w: w, h: h };
  var ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx) {
    ctx.drawImage(video, 0, 0, w, h);
    var roi = detectSkinROI(ctx, w, h);
    if (roi) {
      rppgState.faceDetected = true;
      rppgState.roiBox = { x: roi.x, y: roi.y, w: roi.width, h: roi.height };
      var means = roiChannelMeans(ctx, w, h, roi);
      var now = performance.now();
      rppgState.greenBuf.push(means.g);
      rppgState.redBuf.push(means.r);
      rppgState.blueBuf.push(means.b);
      rppgState.timeBuf.push(now);
      rppgState.liveWave.push(means.g);
      if (rppgState.liveWave.length > 200) rppgState.liveWave.shift();
    } else {
      rppgState.faceDetected = false;
      rppgState.roiBox = null;
    }
  }
  rppgState.raf = requestAnimationFrame(rppgLoop);
}

function startRppgLive(facingOverride) {
  var facing = facingOverride || rppgState.cameraFacing;
  rppgState.mode = 'live';
  rppgState.status = 'requesting';
  resetRppgState();
  rppgState.status = 'requesting';
  renderRppgCapturing();
  navigator.mediaDevices.getUserMedia({
    video: { facingMode: facing, width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false
  }).then(function (stream) {
    if (rppgState.stream) rppgState.stream.getTracks().forEach(function (t) { t.stop(); });
    rppgState.stream = stream;
    var video = $('rppgVideo');
    if (video) {
      video.srcObject = stream;
      return video.play();
    }
  }).then(function () {
    rppgState.status = 'capturing';
    toastSuccess('Camera active (' + (facing === 'user' ? 'front' : 'back') + ') — keep the face in frame, stay still');
    rppgLoop();
    // Auto-stop after CAPTURE_SECONDS
    setTimeout(function () { finishRppgCapture(); }, CAPTURE_SECONDS * 1000);
    // Progress
    var startT = performance.now();
    rppgState.progTimer = setInterval(function () {
      var elapsed = (performance.now() - startT) / 1000;
      rppgState.progress = Math.min(100, (elapsed / CAPTURE_SECONDS) * 100);
      updateRppgProgress();
      if (elapsed >= CAPTURE_SECONDS) { clearInterval(rppgState.progTimer); rppgState.progTimer = null; }
    }, 100);
  }).catch(function () {
    rppgState.status = 'denied';
    renderRppgDenied();
    toastError('Camera access denied — try the other camera or use Demo Mode');
  });
}

function startRppgDemo() {
  rppgState.mode = 'demo';
  rppgState.status = 'capturing';
  resetRppgState();
  rppgState.status = 'capturing';
  renderRppgCapturing();
  toastSuccess('Demo mode: simulating a 74 bpm pulse (no camera)');
  var targetHR = 74;
  var fs = TARGET_FS;
  var total = CAPTURE_SECONDS * fs;
  var omega = (2 * Math.PI * targetHR) / 60;
  for (var i = 0; i < total; i++) {
    var t = i / fs;
    var bvp = Math.sin(omega * t) + 0.35 * Math.sin(2 * omega * t + 0.5) + 0.1 * Math.sin(3 * omega * t);
    var noise = (Math.random() - 0.5) * 0.6;
    rppgState.greenBuf.push(120 + bvp * 4 + noise);
    rppgState.redBuf.push(150 + bvp * 2.2 + noise * 0.7);
    rppgState.blueBuf.push(110 + bvp * 1.2 + noise * 0.5);
    rppgState.timeBuf.push(performance.now() + i * (1000 / fs));
    rppgState.liveWave.push(120 + bvp * 4 + noise);
    if (rppgState.liveWave.length > 200) rppgState.liveWave.shift();
  }
  var startT = performance.now();
  rppgState.progTimer = setInterval(function () {
    var elapsed = (performance.now() - startT) / 1000;
    rppgState.progress = Math.min(100, (elapsed / 2) * 100);
    updateRppgProgress();
    if (elapsed >= 2) {
      clearInterval(rppgState.progTimer); rppgState.progTimer = null;
      finishRppgCapture();
    }
  }, 50);
}

function switchRppgCamera() {
  rppgState.cameraFacing = rppgState.cameraFacing === 'user' ? 'environment' : 'user';
  var lbl = $('rppgCamLbl');
  if (lbl) lbl.textContent = rppgState.cameraFacing === 'user' ? 'Front' : 'Back';
  if (rppgState.status === 'capturing' || rppgState.status === 'requesting') {
    startRppgLive(rppgState.cameraFacing);
  }
}

function renderRppgCapturing() {
  var body = $('rppgBody');
  clearChildren(body);
  var wrap = el('div', 'overlay-center');
  var mirror = rppgState.cameraFacing === 'user' ? ' mirrored' : '';
  var demoHide = rppgState.mode === 'live' ? '' : ' hidden';
  wrap.innerHTML =
    '<div class="rppg-capture">' +
      '<div class="video-preview' + mirror + '">' +
        '<video id="rppgVideo" autoplay muted playsinline' + (rppgState.mode === 'live' ? '' : ' class="hidden"') + '></video>' +
        '<canvas id="rppgCanvas" class="hidden"></canvas>' +
        (rppgState.mode === 'demo' ? '<div class="demo-heart">' + ico('heart') + '</div>' : '') +
        (rppgState.status === 'requesting' ? '<div class="spinner-overlay">' + ico('loader-circle', 'animate-spin') + '</div>' : '') +
        (rppgState.mode === 'live' ? '<div class="roi-box" id="rppgRoiBox"></div>' : '') +
      '</div>' +
      '<div class="face-hint' + demoHide + '" id="rppgFaceHint">Position your face in the frame</div>' +
      '<div class="waveform-wrap"><div class="waveform-lbl">' + ico('waves') + ' BVP signal (green channel)</div><canvas id="rppgWave" width="340" height="80"></canvas></div>' +
      '<div class="progress-wrap"><div class="progress-row"><span class="progress-lbl" id="rppgProgressLbl">Capturing</span><span class="progress-num" id="rppgProgressNum">0%</span></div><div class="progress-bar"><div class="progress-fill" id="rppgProgressFill"></div></div></div>' +
      (rppgState.mode === 'live' ? '<div class="capture-btn-row"><button class="btn btn-outline btn-block switch-cam-btn">' + ico('switch-camera') + ' Switch camera</button><button class="btn btn-outline btn-block stop-btn">Stop &amp; analyse</button></div>' : '') +
    '</div>';
  body.appendChild(wrap);
  if (rppgState.mode === 'live') {
    wrap.querySelector('.switch-cam-btn').onclick = switchRppgCamera;
    wrap.querySelector('.stop-btn').onclick = finishRppgCapture;
  }
  refreshIcons();
  // Start waveform animation
  startRppgWaveAnim();
  // Update face hint periodically
  setInterval(updateRppgFaceHint, 200);
}

function updateRppgFaceHint() {
  var hint = $('rppgFaceHint');
  if (!hint) return;
  if (rppgState.mode !== 'live') return;
  if (rppgState.faceDetected) {
    hint.innerHTML = ico('check') + ' Face detected — measuring';
    hint.classList.add('ok');
    refreshIcons();
  } else {
    hint.textContent = 'Position your face in the frame';
    hint.classList.remove('ok');
  }
  // Update ROI box
  var roi = rppgState.roiBox;
  var box = $('rppgRoiBox');
  if (box) {
    if (roi) {
      var dims = rppgState.frameDims;
      // Front camera is mirrored, so flip horizontally
      var leftPct;
      if (rppgState.cameraFacing === 'user') {
        leftPct = 100 - (roi.x / dims.w) * 100 - (roi.w / dims.w) * 100;
      } else {
        leftPct = (roi.x / dims.w) * 100;
      }
      box.style.display = 'block';
      box.style.left = leftPct + '%';
      box.style.top = (roi.y / dims.h) * 100 + '%';
      box.style.width = (roi.w / dims.w) * 100 + '%';
      box.style.height = (roi.h / dims.h) * 100 + '%';
    } else {
      box.style.display = 'none';
    }
  }
}

function updateRppgProgress() {
  var fill = $('rppgProgressFill');
  var num = $('rppgProgressNum');
  var lbl = $('rppgProgressLbl');
  if (fill) fill.style.width = rppgState.progress + '%';
  if (num) num.textContent = Math.round(rppgState.progress) + '%';
  if (lbl) lbl.textContent = rppgState.status === 'processing' ? 'Analysing signal…' : (rppgState.status === 'requesting' ? 'Starting camera…' : 'Capturing');
}

var rppgWaveRaf = null;
function startRppgWaveAnim() {
  if (rppgWaveRaf) cancelAnimationFrame(rppgWaveRaf);
  function draw() {
    var c = $('rppgWave');
    if (!c) { rppgWaveRaf = null; return; }
    var ctx = c.getContext('2d');
    var w = c.width, h = c.height;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(43,174,102,0.12)';
    ctx.lineWidth = 1;
    for (var i = 0; i < 5; i++) {
      var y = (h / 4) * i;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    var data = rppgState.liveWave;
    if (data.length < 2) { rppgWaveRaf = requestAnimationFrame(draw); return; }
    var win = 40;
    var detrended = data.map(function (v, i) {
      var s = Math.max(0, i - win), e = Math.min(data.length, i + win);
      var slice = data.slice(s, e);
      var mean = 0;
      for (var k = 0; k < slice.length; k++) mean += slice[k];
      mean /= slice.length;
      return v - mean;
    });
    var mx = 0;
    for (var d = 0; d < detrended.length; d++) { if (Math.abs(detrended[d]) > mx) mx = Math.abs(detrended[d]); }
    mx = mx || 1;
    ctx.strokeStyle = '#2bae66';
    ctx.lineWidth = 2;
    ctx.beginPath();
    detrended.forEach(function (v, i) {
      var x = (i / (detrended.length - 1)) * w;
      var y = h / 2 - (v / mx) * (h * 0.4);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    rppgWaveRaf = requestAnimationFrame(draw);
  }
  rppgWaveRaf = requestAnimationFrame(draw);
}

function finishRppgCapture() {
  rppgState.status = 'processing';
  updateRppgProgress();
  stopRppgAll();
  if (rppgWaveRaf) { cancelAnimationFrame(rppgWaveRaf); rppgWaveRaf = null; }
  var g = rppgState.greenBuf, r = rppgState.redBuf;
  if (g.length < TARGET_FS * 3) {
    toastError('Not enough signal captured — try again');
    rppgState.status = 'idle';
    renderRppgIdle();
    return;
  }
  var dt = (rppgState.timeBuf[rppgState.timeBuf.length - 1] - rppgState.timeBuf[0]) / (rppgState.timeBuf.length - 1);
  var fs = 1000 / dt;
  var detrended = detrend(g, Math.round(fs * 2));
  var normed = normalize(detrended);
  var filtered = bandpassFilter(normed, fs, 0.75, 3.0);
  var hrResult = autocorrelationHR(filtered, fs);
  var spo2Val = estimateSpO2(r, g);
  var bpResult = { systolic: 0, diastolic: 0, map: 0, confidence: 0 };
  if (hrResult) {
    var peaks = detectPeaks(filtered, fs);
    var amp = 0;
    for (var i = 0; i < filtered.length; i++) { if (Math.abs(filtered[i]) > amp) amp = Math.abs(filtered[i]); }
    var totalW = 0;
    for (var p = 0; p < peaks.length; p++) totalW += peaks[p].width;
    var avgWidth = peaks.length ? totalW / peaks.length : fs * 0.3;
    bpResult = estimateBP(hrResult.bpm, spo2Val, amp, avgWidth, fs);
  }
  if (hrResult) rppgState.hr = hrResult.bpm;
  rppgState.spo2 = spo2Val;
  if (bpResult.systolic) rppgState.bp = { s: bpResult.systolic, d: bpResult.diastolic, m: bpResult.map, conf: bpResult.confidence };
  rppgState.status = 'done';
  renderRppgDone();
  toastSuccess('Contactless vitals captured');
}

function renderRppgDone() {
  var body = $('rppgBody');
  clearChildren(body);
  var wrap = el('div', 'overlay-center');
  var bp = rppgState.bp;
  wrap.innerHTML =
    '<div class="rppg-done">' +
      '<div class="done-check emerald">' + ico('check') + '</div>' +
      '<div class="done-title">Vitals captured</div>' +
      '<div class="done-sub">' + (rppgState.mode === 'demo' ? 'Demo mode (synthetic 74 bpm signal)' : 'Contactless camera measurement') + '</div>' +
      '<div class="result-grid">' +
        '<div class="result-card"><div class="result-card-lbl"><span style="color:#ef4444">' + ico('heart') + '</span> Heart Rate</div><div class="result-card-val">' + (rppgState.hr != null ? rppgState.hr : '—') + '</div><div class="result-card-unit">bpm</div></div>' +
        '<div class="result-card"><div class="result-card-lbl"><span style="color:#3b82f6">' + ico('droplet') + '</span> SpO₂</div><div class="result-card-val">' + (rppgState.spo2 != null ? rppgState.spo2 : '—') + '</div><div class="result-card-unit">%</div></div>' +
        '<div class="result-card"><div class="result-card-lbl"><span style="color:#2bae66">' + ico('gauge') + '</span> Systolic</div><div class="result-card-val">' + (bp ? bp.s : '—') + '</div><div class="result-card-unit">mmHg</div></div>' +
        '<div class="result-card"><div class="result-card-lbl"><span style="color:#2bae66">' + ico('gauge') + '</span> Diastolic</div><div class="result-card-val">' + (bp ? bp.d : '—') + '</div><div class="result-card-unit">mmHg</div></div>' +
      '</div>' +
      (bp ? '<div class="map-row">MAP ' + bp.m + ' mmHg · confidence ' + Math.round(bp.conf * 100) + '% (screening grade — validate BP with a cuff)</div>' : '') +
      '<div class="done-btn-row"><button class="btn btn-outline btn-block retake-btn">' + ico('rotate-cw') + ' Retake</button><button class="btn btn-success btn-block use-btn">' + ico('check') + ' Use results</button></div>' +
    '</div>';
  body.appendChild(wrap);
  wrap.querySelector('.retake-btn').onclick = function () { resetRppgState(); renderRppgIdle(); };
  wrap.querySelector('.use-btn').onclick = function () { closeRppgTool(true); };
  refreshIcons();
}

function renderRppgDenied() {
  var body = $('rppgBody');
  clearChildren(body);
  var wrap = el('div', 'overlay-center');
  wrap.innerHTML =
    '<div class="rppg-denied">' +
      '<div class="big-ico muted">' + ico('camera') + '</div>' +
      '<div class="done-title">Camera unavailable</div>' +
      '<div class="done-sub">Try switching cameras, or use Demo Mode to test the measurement pipeline with a synthetic signal.</div>' +
      '<button class="btn btn-outline btn-block btn-lg demo-btn">' + ico('waves') + ' Run demo mode</button>' +
    '</div>';
  body.appendChild(wrap);
  wrap.querySelector('.demo-btn').onclick = startRppgDemo;
  refreshIcons();
}

/* ===================================================================
 * VISUAL ACUITY TOOL (fullscreen overlay)
 * =================================================================== */
var vaState = {
  eye: 'right',
  distance: null,
  camStatus: 'idle',
  manualDistance: '',
  rightLine: null,
  leftLine: null,
  stream: null,
  raf: null
};

function openVisualAcuityTool() {
  show('vaOverlay');
  vaState = { eye: 'right', distance: null, camStatus: 'idle', manualDistance: '', rightLine: null, leftLine: null, stream: null, raf: null };
  renderVaHeadTitle();
  renderVaBody();
  requestOverlayFullscreen($('vaOverlay'));
  startVaCamera();
  $('vaEyeRight').onclick = function () { vaState.eye = 'right'; renderVaHeadTitle(); updateVaEyeSwitch(); renderVaChart(); };
  $('vaEyeLeft').onclick = function () { vaState.eye = 'left'; renderVaHeadTitle(); updateVaEyeSwitch(); renderVaChart(); };
  $('vaRestartBtn').onclick = startVaCamera;
  $('vaDoneBtn').onclick = finishVa;
}

function renderVaHeadTitle() {
  $('vaHeadTitle').textContent = 'Visual Acuity — ' + (vaState.eye === 'right' ? 'Right Eye (OD)' : 'Left Eye (OS)');
}
function updateVaEyeSwitch() {
  $('vaEyeRight').classList.toggle('active', vaState.eye === 'right');
  $('vaEyeLeft').classList.toggle('active', vaState.eye === 'left');
}

function renderVaBody() {
  var body = $('vaBody');
  clearChildren(body);
  var wrap = el('div', 'va-stage');
  wrap.innerHTML =
    '<div class="va-cam-preview" id="vaCamPreview">' +
      '<video id="vaVideo" autoplay muted playsinline></video>' +
      '<canvas id="vaCanvas" class="hidden"></canvas>' +
    '</div>' +
    '<div class="va-distance-hud"><div class="va-distance-lbl">' + ico('ruler') + ' Distance</div><div class="va-distance-val" id="vaDistanceVal">—</div><div class="va-distance-sub" id="vaDistanceSub"></div></div>' +
    '<div class="va-manual-row"><input id="vaManual" type="number" step="0.1" placeholder="manual m"><span>m</span></div>' +
    '<div class="va-chart-wrap" id="vaChartWrap"></div>';
  body.appendChild(wrap);
  $('vaManual').value = vaState.manualDistance;
  $('vaManual').oninput = function () { vaState.manualDistance = this.value; renderVaChart(); updateVaDistanceHud(); };
  updateVaEyeSwitch();
  renderVaChart();
}

function startVaCamera() {
  vaState.camStatus = 'requesting';
  updateVaDistanceHud();
  if (vaState.stream) { vaState.stream.getTracks().forEach(function (t) { t.stop(); }); vaState.stream = null; }
  navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false
  }).then(function (stream) {
    vaState.stream = stream;
    var v = $('vaVideo');
    if (v) { v.srcObject = stream; return v.play(); }
  }).then(function () {
    vaState.camStatus = 'active';
    updateVaDistanceHud();
    if (!vaState.raf) vaLoop();
  }).catch(function () {
    vaState.camStatus = 'denied';
    updateVaDistanceHud();
    renderVaChart();
    toastError('Camera access denied — use manual distance entry');
  });
}

function vaLoop() {
  var video = $('vaVideo');
  var canvas = $('vaCanvas');
  if (video && canvas && video.videoWidth > 0) {
    var w = 160;
    var h = Math.round((video.videoHeight / video.videoWidth) * w);
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx) {
      ctx.drawImage(video, 0, 0, w, h);
      var faceWidthPx = detectFaceWidth(ctx, w, h);
      if (faceWidthPx && faceWidthPx > 8) {
        var captureW = video.videoWidth;
        var focalPx = captureW / 2 / Math.tan((FRONT_CAM_FOV_DEG * Math.PI) / 180 / 2);
        var faceWidthCapturePx = faceWidthPx * (captureW / w);
        var distMm = (AVG_FACE_WIDTH_MM * focalPx) / faceWidthCapturePx;
        var distM = Math.round((distMm / 1000) * 10) / 10;
        vaState.distance = distM;
        updateVaDistanceHud();
      }
    }
  }
  vaState.raf = requestAnimationFrame(vaLoop);
}

function updateVaDistanceHud() {
  var eff = vaState.manualDistance ? Number(vaState.manualDistance) : vaState.distance;
  var valEl = $('vaDistanceVal');
  if (valEl) valEl.textContent = eff ? eff + 'm' : '—';
  var subEl = $('vaDistanceSub');
  if (subEl) {
    if (vaState.camStatus === 'active' && vaState.distance) subEl.textContent = 'auto-detected';
    else if (vaState.camStatus === 'denied') subEl.textContent = 'camera off';
    else if (vaState.camStatus === 'requesting') subEl.textContent = 'starting…';
    else subEl.textContent = '';
  }
}

function renderVaChart() {
  var wrap = $('vaChartWrap');
  if (!wrap) return;
  clearChildren(wrap);
  var eff = vaState.manualDistance ? Number(vaState.manualDistance) : vaState.distance;
  if (!eff) {
    wrap.innerHTML = '<div class="va-empty">' +
      (vaState.camStatus === 'denied'
        ? '<div class="big-ico muted">' + ico('camera') + '</div><div class="done-title">Camera unavailable</div><div class="done-sub">Enter the test distance manually above to size the chart.</div>'
        : '<div class="big-ico pulsing">' + ico('heart') + '</div><div class="done-title">Position the patient</div><div class="done-sub">Hold the phone so the patient\'s face fills the camera. Distance is auto-measured, or enter it manually.</div>') +
    '</div>';
    refreshIcons();
    return;
  }
  wrap.innerHTML = '<div class="va-chart-hint">Which is the smallest line the patient reads correctly?</div>';
  SNELLEN_LINES.forEach(function (line, idx) {
    var selected = vaState.eye === 'right' ? vaState.rightLine === idx : vaState.leftLine === idx;
    // Practical font sizes calibrated for phone screens at 6m reference distance.
    // Scaled proportionally with the actual test distance.
    var BASE_FONT_PX = [52, 40, 32, 27, 23, 19, 17, 15, 13];
    var scale = eff / 6; // 6m = reference distance
    var fontPx = Math.max(11, Math.round(BASE_FONT_PX[idx] * scale));
    var btn = el('button', 'va-line' + (selected ? ' selected' : ''));
    btn.style.fontSize = fontPx + 'px';
    btn.innerHTML = '<span class="va-line-label" style="font-family:monospace;font-weight:bold;letter-spacing:0.15em">' + escapeHtml(line.label) + '</span><span class="va-line-frac" style="font-family:sans-serif">' + line.frac + '</span>';
    btn.addEventListener('click', function () {
      if (vaState.eye === 'right') vaState.rightLine = idx; else vaState.leftLine = idx;
      toastSuccess((vaState.eye === 'right' ? 'Right' : 'Left') + ' eye: ' + line.frac + ' recorded');
      renderVaChart();
    });
    wrap.appendChild(btn);
  });
}

function finishVa() {
  var eff = vaState.manualDistance ? Number(vaState.manualDistance) : vaState.distance;
  var result = {
    right: vaState.rightLine != null ? { line: SNELLEN_LINES[vaState.rightLine], distance: eff || 0 } : null,
    left: vaState.leftLine != null ? { line: SNELLEN_LINES[vaState.leftLine], distance: eff || 0 } : null
  };
  stopVaAll();
  hide('vaOverlay');
  if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
  eyeForm.vaResult = result;
  renderVaResults(result);
  if ($('view-eye').contains(document.activeElement) === false) {
    // ensure form is visible
  }
  // Re-render eye form to populate results preview
  renderEyeForm();
  toastSuccess('Visual acuity recorded');
}

function stopVaAll() {
  if (vaState.raf) cancelAnimationFrame(vaState.raf);
  vaState.raf = null;
  if (vaState.stream) { vaState.stream.getTracks().forEach(function (t) { t.stop(); }); vaState.stream = null; }
}

/* ===================================================================
 * AI DENTAL SCAN TOOL (fullscreen overlay)
 * =================================================================== */
var dentalScanState = {
  status: 'idle',
  hasTorch: false,
  torchState: false,
  findings: null,
  capturedUrl: null,
  cameraFacing: 'environment',
  stream: null
};

function openDentalScanTool() {
  show('dentalOverlay');
  dentalScanState = {
    status: 'idle', hasTorch: false, torchState: false,
    findings: null, capturedUrl: null,
    cameraFacing: 'environment', stream: null
  };
  renderDentalScanIdle();
  requestOverlayFullscreen($('dentalOverlay'));
}

function renderDentalScanIdle() {
  var body = $('dentalBody');
  clearChildren(body);
  var wrap = el('div', 'overlay-center');
  wrap.innerHTML =
    '<div class="dental-idle">' +
      '<div class="big-ico rose">' + ico('smile') + '</div>' +
      '<div class="done-title">AI Dental Examination</div>' +
      '<div class="done-sub">Uses the back camera + flash to capture the teeth, then computer vision detects caries, plaque, gum inflammation and estimates tooth count. Results feed the dental check form.</div>' +
      '<button class="btn btn-rose btn-block btn-lg start-cam-btn">' + ico('camera') + ' Start back-camera scan</button>' +
      '<button class="btn btn-outline btn-block btn-lg sample-btn">' + ico('image') + ' Use sample dental image</button>' +
      '<div class="screening-disclaimer"><strong>Screening grade.</strong> For triage only. Does not replace a clinical dental exam. Ask the patient to open wide &amp; hold still under good light.</div>' +
    '</div>';
  body.appendChild(wrap);
  wrap.querySelector('.start-cam-btn').onclick = startDentalCamera;
  wrap.querySelector('.sample-btn').onclick = useDentalSampleImage;
  refreshIcons();
}

function startDentalCamera(facingOverride) {
  var facing = facingOverride || dentalScanState.cameraFacing;
  dentalScanState.status = 'requesting';
  if (dentalScanState.stream) { dentalScanState.stream.getTracks().forEach(function (t) { t.stop(); }); dentalScanState.stream = null; }

  function tryGet(constraints) {
    return navigator.mediaDevices.getUserMedia(constraints).catch(function () { return null; });
  }

  var stream;
  tryGet({ video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
    .then(function (s) {
      stream = s;
      if (!stream) {
        var other = facing === 'environment' ? 'user' : 'environment';
        return tryGet({ video: { facingMode: other, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
          .then(function (s2) { if (s2) { dentalScanState.cameraFacing = other; stream = s2; } return s2; });
      }
      return stream;
    })
    .then(function (s) {
      if (!stream) {
        return tryGet({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
          .then(function (s3) { stream = s3; return s3; });
      }
      return stream;
    })
    .then(function (finalStream) {
      if (!finalStream) {
        dentalScanState.status = 'denied';
        renderDentalScanDenied();
        toastError('No camera available — use Sample Image to test the analysis');
        return;
      }
      dentalScanState.stream = finalStream;
      dentalScanState.status = 'ready';
      renderDentalScanReady();
      var video = $('dentalVideo');
      if (video) {
        video.srcObject = finalStream;
        video.play();
      }
      // Try torch
      var track = finalStream.getVideoTracks()[0];
      var caps = (track && track.getCapabilities) ? track.getCapabilities() : null;
      if (caps && caps.torch) {
        dentalScanState.hasTorch = true;
        try {
          track.applyConstraints({ advanced: [{ torch: true }] }).then(function () {
            dentalScanState.torchState = true;
            renderDentalScanReady();
          }).catch(function () {});
        } catch (e) {}
      } else {
        dentalScanState.hasTorch = false;
      }
    });
}

function switchDentalCamera() {
  dentalScanState.cameraFacing = dentalScanState.cameraFacing === 'environment' ? 'user' : 'environment';
  if (dentalScanState.status === 'ready' || dentalScanState.status === 'requesting') {
    startDentalCamera(dentalScanState.cameraFacing);
  }
}

function toggleDentalTorch() {
  if (!dentalScanState.stream) return;
  var track = dentalScanState.stream.getVideoTracks()[0];
  if (!track) return;
  var next = !dentalScanState.torchState;
  track.applyConstraints({ advanced: [{ torch: next }] }).then(function () {
    dentalScanState.torchState = next;
    var btn = $('dentalTorchBtn');
    if (btn) btn.innerHTML = ico('flashlight') + ' Flash ' + (next ? 'on' : 'off');
    refreshIcons();
  }).catch(function () { toastError('Torch toggle failed on this device'); });
}

function renderDentalScanReady() {
  var body = $('dentalBody');
  clearChildren(body);
  var mirror = dentalScanState.cameraFacing === 'user' ? ' mirrored' : '';
  var wrap = el('div', 'overlay-center');
  wrap.innerHTML =
    '<div class="dental-ready">' +
      '<div class="video-preview' + mirror + '">' +
        '<video id="dentalVideo" autoplay muted playsinline></video>' +
        (dentalScanState.status === 'requesting' ? '<div class="spinner-overlay">' + ico('loader-circle', 'animate-spin') + '</div>' : '') +
        '<div class="capture-guide"><div class="capture-guide-border"></div><div class="capture-guide-text">Align teeth within the frame</div></div>' +
      '</div>' +
      '<div class="dental-ready-btns">' +
        (dentalScanState.hasTorch ? '<button class="btn btn-outline btn-sm" id="dentalTorchBtn">' + ico('flashlight') + ' Flash ' + (dentalScanState.torchState ? 'on' : 'off') + '</button>' : '') +
        '<button class="btn btn-outline btn-sm switch-btn">' + ico('switch-camera') + ' ' + (dentalScanState.cameraFacing === 'environment' ? 'Front' : 'Back') + '</button>' +
        '<button class="btn btn-rose btn-block capture-btn">' + ico('camera') + ' Capture &amp; analyse</button>' +
      '</div>' +
    '</div>';
  body.appendChild(wrap);
  wrap.querySelector('.switch-btn').onclick = switchDentalCamera;
  wrap.querySelector('.capture-btn').onclick = captureDentalAndAnalyse;
  if (dentalScanState.hasTorch) {
    wrap.querySelector('#dentalTorchBtn').onclick = toggleDentalTorch;
  }
  refreshIcons();
}

function captureDentalAndAnalyse() {
  var video = $('dentalVideo');
  var canvas = $('dentalCanvas');
  if (!video || !canvas || !video.videoWidth) return;
  dentalScanState.status = 'processing';
  var aw = 360;
  var ah = Math.round((video.videoHeight / video.videoWidth) * aw);
  canvas.width = aw; canvas.height = ah;
  var ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  ctx.drawImage(video, 0, 0, aw, ah);
  dentalScanState.capturedUrl = canvas.toDataURL('image/jpeg', 0.6);
  renderDentalScanProcessing();
  setTimeout(function () {
    var f = analyseDentalImage(ctx, aw, ah);
    dentalScanState.findings = f;
    dentalScanState.status = 'done';
    renderDentalScanDone();
    toastSuccess('Dental scan analysed');
  }, 400);
}

function useDentalSampleImage() {
  dentalScanState.status = 'processing';
  renderDentalScanProcessing();
  var canvas = $('dentalCanvas');
  if (!canvas) {
    // Create canvas if not present
    canvas = document.createElement('canvas');
    canvas.id = 'dentalCanvas';
    canvas.className = 'hidden';
    document.body.appendChild(canvas);
  }
  canvas.width = 360; canvas.height = 270;
  var ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  // Background = gum (pink)
  ctx.fillStyle = '#d98a8a'; ctx.fillRect(0, 0, 360, 270);
  // Upper gum band
  ctx.fillStyle = '#c9737a'; ctx.fillRect(0, 0, 360, 70);
  // Teeth row
  var teeth = 11, tw = 360 / teeth;
  for (var i = 0; i < teeth; i++) {
    var x = i * tw + 4, w = tw - 8;
    ctx.fillStyle = '#f5f5f0'; roundRect(ctx, x, 75, w, 90, 8); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.06)'; roundRect(ctx, x, 75, w, 20, 8); ctx.fill();
  }
  // Lower gum
  ctx.fillStyle = '#c9737a'; ctx.fillRect(0, 200, 360, 70);
  // Lower teeth
  for (var li = 0; li < teeth; li++) {
    var lx = li * tw + 4, lw = tw - 8;
    ctx.fillStyle = '#f0f0e8'; roundRect(ctx, lx, 175, lw, 70, 8); ctx.fill();
  }
  // Caries
  ctx.fillStyle = '#6b4423'; ctx.beginPath(); ctx.arc(3 * tw + tw / 2, 110, 7, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#5a3a1a'; ctx.beginPath(); ctx.arc(7 * tw + tw / 2, 100, 5, 0, Math.PI * 2); ctx.fill();
  // Plaque
  ctx.fillStyle = 'rgba(200,180,80,0.7)';
  ctx.fillRect(5 * tw + 2, 155, tw - 4, 12);
  ctx.fillRect(9 * tw + 2, 155, tw - 4, 10);
  // Inflamed gum
  ctx.fillStyle = '#b04040';
  ctx.beginPath(); ctx.arc(4 * tw, 200, 18, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(8 * tw + tw, 60, 16, 0, Math.PI * 2); ctx.fill();
  dentalScanState.capturedUrl = canvas.toDataURL('image/jpeg', 0.6);
  setTimeout(function () {
    var f = analyseDentalImage(ctx, 360, 270);
    dentalScanState.findings = f;
    dentalScanState.status = 'done';
    renderDentalScanDone();
    toastSuccess('Sample dental image analysed');
  }, 400);
}

function renderDentalScanProcessing() {
  var body = $('dentalBody');
  clearChildren(body);
  var wrap = el('div', 'overlay-center');
  wrap.innerHTML =
    '<div class="dental-processing">' +
      (dentalScanState.capturedUrl ? '<img src="' + dentalScanState.capturedUrl + '" class="captured-img">' : '') +
      '<div class="spinner-rose">' + ico('loader-circle', 'animate-spin') + '</div>' +
      '<div class="done-sub">Running computer-vision analysis…</div>' +
    '</div>' +
    '<canvas id="dentalCanvas" class="hidden"></canvas>';
  body.appendChild(wrap);
  refreshIcons();
}

function renderDentalScanDone() {
  var body = $('dentalBody');
  clearChildren(body);
  var f = dentalScanState.findings;
  if (!f) return;
  var oralGrade = f.oralHealthScore >= 80 ? 'GOOD' : f.oralHealthScore >= 55 ? 'FAIR' : 'POOR';
  var gradeCls = oralGrade === 'GOOD' ? 'badge-emerald' : oralGrade === 'FAIR' ? 'badge-amber' : 'badge-rose';
  var wrap = el('div', 'overlay-center');
  wrap.innerHTML =
    '<div class="dental-done">' +
      '<div class="done-check rose">' + ico('check') + '</div>' +
      '<div class="done-title">Scan complete</div>' +
      (dentalScanState.capturedUrl ? '<img src="' + dentalScanState.capturedUrl + '" class="done-img">' : '') +
      '<div class="score-card"><div class="score-lbl">Oral Health Score</div><div class="score-val">' + f.oralHealthScore + '<span class="score-unit">/100</span></div><span class="badge ' + gradeCls + '">' + oralGrade + '</span></div>' +
      '<div class="result-grid">' +
        '<div class="result-card"><div class="result-card-lbl">Teeth detected</div><div class="result-card-val">' + f.toothCountEstimate + '</div>' + (f.toothCountEstimate < 8 ? '<div class="result-card-flag warning">low count</div>' : '') + '</div>' +
        '<div class="result-card"><div class="result-card-lbl">Caries spots</div><div class="result-card-val">' + f.cariesSpots.length + '</div>' + (f.cariesLikely ? '<div class="result-card-flag rose">likely</div>' : '') + '</div>' +
        '<div class="result-card"><div class="result-card-lbl">Plaque</div><div class="result-card-val">' + (f.plaqueLikely ? 'Detected' : 'None') + '</div>' + (f.plaqueLikely ? '<div class="result-card-flag amber">likely</div>' : '') + '</div>' +
        '<div class="result-card"><div class="result-card-lbl">Gingivitis</div><div class="result-card-val">' + (f.gingivitisLikely ? 'Detected' : 'None') + '</div>' + (f.gingivitisLikely ? '<div class="result-card-flag rose">likely</div>' : '') + '</div>' +
      '</div>' +
      '<div class="auto-obs"><div class="auto-obs-title">Auto observations:</div><div class="auto-obs-body"></div></div>' +
      '<div class="done-btn-row"><button class="btn btn-outline btn-block rescan-btn">' + ico('rotate-cw') + ' Rescan</button><button class="btn btn-rose btn-block use-btn">' + ico('check') + ' Use results</button></div>' +
    '</div>';
  wrap.querySelector('.auto-obs-body').textContent = buildDentalObservations(f);
  body.appendChild(wrap);
  wrap.querySelector('.rescan-btn').onclick = function () {
    dentalScanState.findings = null;
    dentalScanState.capturedUrl = null;
    dentalScanState.status = 'idle';
    renderDentalScanIdle();
  };
  wrap.querySelector('.use-btn').onclick = function () { closeDentalScanTool(true); };
  refreshIcons();
}

function renderDentalScanDenied() {
  var body = $('dentalBody');
  clearChildren(body);
  var wrap = el('div', 'overlay-center');
  wrap.innerHTML =
    '<div class="dental-denied">' +
      '<div class="big-ico muted">' + ico('camera') + '</div>' +
      '<div class="done-title">Camera unavailable</div>' +
      '<div class="done-sub">Use the sample dental image to test the CV analysis pipeline.</div>' +
      '<button class="btn btn-outline btn-block btn-lg sample-btn">' + ico('image') + ' Use sample image</button>' +
    '</div>';
  body.appendChild(wrap);
  wrap.querySelector('.sample-btn').onclick = useDentalSampleImage;
  refreshIcons();
}

function closeDentalScanTool(useResults) {
  if (dentalScanState.stream) {
    dentalScanState.stream.getTracks().forEach(function (t) { t.stop(); });
    dentalScanState.stream = null;
  }
  hide('dentalOverlay');
  if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
  if (useResults && dentalScanState.findings) {
    var f = dentalScanState.findings;
    dentalForm.oralHealth = f.oralHealthScore >= 80 ? 'Good' : f.oralHealthScore >= 55 ? 'Fair' : 'Poor';
    dentalForm.cariesPresent = f.cariesLikely;
    dentalForm.gingivitis = f.gingivitisLikely;
    var obs = buildDentalObservations(f);
    dentalForm.observations = (dentalForm.observations ? dentalForm.observations + ' ' : '') + obs;
    if (f.cariesLikely || f.gingivitisLikely) dentalForm.referralNeeded = true;
    renderDentalForm();
    toastSuccess('Dental scan results populated — review & save');
  }
}

/* ===================================================================
 * REFERRALS
 * =================================================================== */
function renderReferrals() {
  clearChildren($('referralList'));
  var sel = $('refPatient');
  clearChildren(sel);
  sel.appendChild(new Option('Select patient…', ''));
  if (STATE.cachedPatients && STATE.cachedPatients.length) {
    STATE.cachedPatients.forEach(function (p) {
      sel.appendChild(new Option(p.PatientCode + ' · ' + p.FullName, p.PatientID));
    });
  } else if (STATE.activeOutreachId) {
    api.patients(STATE.activeOutreachId).then(function (r) {
      STATE.cachedPatients = r.data || [];
      STATE.cachedPatients.forEach(function (p) {
        sel.appendChild(new Option(p.PatientCode + ' · ' + p.FullName, p.PatientID));
      });
    });
  }
  $('referralSubmit').onclick = onReferralSubmit;
  loadReferralList();
}

function onReferralSubmit() {
  clearInlineError('referralError');
  var patientId = $('refPatient').value;
  var reason = $('refReason').value;
  var dest = $('refDestination').value;
  var pri = $('refPriority').value;
  if (!patientId) { showInlineError('referralError', 'Select a patient'); return; }
  if (!reason || !dest) { showInlineError('referralError', 'Reason & destination required'); return; }
  api.createReferral({
    PatientID: patientId,
    OutreachID: STATE.activeOutreachId,
    Reason: reason,
    Destination: dest,
    Priority: pri
  }).then(function (r) {
    toastSuccess('Referral ' + r.data.ReferralCode + ' created');
    $('refReason').value = '';
    $('refDestination').value = '';
    showReferralSlip(r.data);
    loadReferralList();
  }).catch(function (e) {
    showInlineError('referralError', e.message);
  });
}

function loadReferralList() {
  var host = $('referralList');
  clearChildren(host);
  api.referrals().then(function (r) {
    var refs = r.data || [];
    if (!refs.length) {
      host.appendChild(emptyState('file-text', 'No referrals issued yet'));
      refreshIcons();
      return;
    }
    refs.forEach(function (ref) {
      var priCls = ref.Priority === 'Emergency' ? 'badge-rose' : ref.Priority === 'Urgent' ? 'badge-amber' : 'badge-secondary';
      var row = el('div', 'card list-row');
      row.innerHTML =
        '<div class="list-row-icon primary">' + ico('file-text') + '</div>' +
        '<div class="list-row-body">' +
          '<div class="list-row-title"><span class="name"></span><span class="badge-outline mono">' + escapeHtml(ref.ReferralCode) + '</span></div>' +
          '<div class="list-row-sub"></div>' +
        '</div>' +
        '<span class="badge ' + priCls + '">' + escapeHtml(ref.Priority) + '</span>' +
        '<button class="btn btn-outline btn-sm print-btn">' + ico('printer') + '</button>';
      row.querySelector('.name').textContent = ref.patient ? ref.patient.FullName : '—';
      row.querySelector('.list-row-sub').textContent = (ref.Reason || '') + ' → ' + (ref.Destination || '');
      row.querySelector('.print-btn').addEventListener('click', function () { showReferralSlip(ref); });
      host.appendChild(row);
    });
    refreshIcons();
  }).catch(function () {
    host.appendChild(emptyState('alert-triangle', 'Could not load referrals'));
    refreshIcons();
  });
}

function showReferralSlip(ref) {
  var host = $('referralPrintHost');
  clearChildren(host);
  var overlay = el('div', 'slip-overlay');
  var priCls = ref.Priority === 'Emergency' ? 'badge-rose' : ref.Priority === 'Urgent' ? 'badge-amber' : 'badge-secondary';
  var slip = el('div', 'slip-card');
  slip.innerHTML =
    '<div class="slip-toolbar no-print">' +
      '<h2>Referral Slip Preview</h2>' +
      '<div class="slip-actions">' +
        '<button class="btn btn-primary btn-sm print-now-btn">' + ico('printer') + ' Print / PDF</button>' +
        '<button class="btn btn-outline btn-sm slip-close-btn">' + ico('arrow-left') + ' Close</button>' +
      '</div>' +
    '</div>' +
    '<div class="twc-referral-slip">' +
      '<div class="slip-header">' +
        '<div class="twc-logo-tile" data-size="32"><svg viewBox="0 0 48 48" width="29" height="29" fill="none"><rect x="33" y="6" width="3.4" height="9" rx="1" fill="#fff"/><rect x="30.4" y="8.6" width="8.6" height="3.4" rx="1" fill="#fff"/><rect x="6" y="6" width="36" height="36" rx="5" stroke="#fff" stroke-width="2.2" fill="none"/><text x="24" y="24" text-anchor="middle" font-family="system-ui, sans-serif" font-weight="800" font-size="9.5" fill="#fff" letter-spacing="0.5">TWC</text><text x="24" y="34" text-anchor="middle" font-family="system-ui, sans-serif" font-weight="700" font-size="6.2" fill="#fff" letter-spacing="1.4">LABS</text></svg></div>' +
        '<div class="slip-header-text"><div class="slip-header-name">TWC LABS</div><div class="slip-header-sub">Outreach Referral Slip</div></div>' +
      '</div>' +
      '<div class="slip-body">' +
        '<div class="slip-top-row"><div><div class="slip-lbl">Referral Code</div><div class="slip-mono slip-strong">' + escapeHtml(ref.ReferralCode) + '</div></div><span class="badge ' + priCls + '">' + escapeHtml(ref.Priority) + '</span></div>' +
        '<div class="slip-grid-2">' +
          '<div><div class="slip-lbl">Patient</div><div class="slip-strong">' + escapeHtml(ref.patient ? ref.patient.FullName : '—') + '</div></div>' +
          '<div><div class="slip-lbl">Code</div><div class="slip-mono">' + escapeHtml(ref.patient ? ref.patient.PatientCode : '—') + '</div></div>' +
          '<div><div class="slip-lbl">Age / Sex</div><div>' + (ref.patient && ref.patient.Age ? ref.patient.Age + 'y' : '—') + ' ' + (ref.patient && ref.patient.Sex ? '· ' + ref.patient.Sex : '') + '</div></div>' +
          '<div><div class="slip-lbl">Phone</div><div>' + escapeHtml(ref.patient && ref.patient.Phone ? ref.patient.Phone : '—') + '</div></div>' +
        '</div>' +
        '<div class="slip-section"><div class="slip-lbl">Reason for referral</div><div class="slip-text">' + escapeHtml(ref.Reason || '') + '</div></div>' +
        '<div class="slip-section"><div class="slip-lbl">Referred to</div><div class="slip-text slip-strong">' + escapeHtml(ref.Destination || '') + '</div></div>' +
        '<div class="slip-foot-row">' +
          '<div><div class="slip-lbl">Issued by</div><div class="slip-strong">' + escapeHtml(ref.issuedBy || '—') + '</div></div>' +
          '<div class="slip-foot-right"><div class="slip-lbl">Date</div><div class="slip-strong">' + fmtDateShort(ref.CreatedAt) + '</div></div>' +
        '</div>' +
        '<div class="slip-disclaimer">NDPA compliant · This slip contains protected health information. Handle with care.</div>' +
      '</div>' +
    '</div>';
  overlay.appendChild(slip);
  host.appendChild(overlay);
  refreshIcons();
  setTimeout(function () { overlay.classList.add('open'); }, 10);
  slip.querySelector('.slip-close-btn').onclick = function () {
    overlay.classList.remove('open');
    setTimeout(function () { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 200);
  };
  slip.querySelector('.print-now-btn').onclick = function () { window.print(); };
  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) {
      overlay.classList.remove('open');
      setTimeout(function () { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 200);
    }
  });
}

/* ===================================================================
 * SITES (SuperAdmin)
 * =================================================================== */
function renderSites() {
  $('siteForm').onsubmit = function (e) {
    e.preventDefault();
    api.createSite({
      Name: $('sName').value,
      Location: $('sLocation').value,
      Region: $('sRegion').value
    }).then(function () {
      toastSuccess('Site created');
      $('siteForm').reset();
      renderSitesList();
    }).catch(function (e) { toastError(e.message); });
  };
  renderSitesList();
}

function renderSitesList() {
  var host = $('sitesList');
  clearChildren(host);
  api.sites().then(function (r) {
    STATE.cachedSites = r.data || [];
    if (!STATE.cachedSites.length) {
      host.appendChild(emptyState('building-2', 'No sites yet'));
      refreshIcons();
      return;
    }
    STATE.cachedSites.forEach(function (s) {
      var row = el('div', 'list-row tight');
      row.innerHTML =
        '<div class="list-row-icon primary">' + ico('building-2') + '</div>' +
        '<div class="list-row-body"><div class="list-row-title"><span class="name"></span></div><div class="list-row-sub"></div></div>' +
        '<span class="badge ' + (s.Active ? 'badge-emerald' : 'badge-secondary') + '">' + (s.Active ? 'Active' : 'Inactive') + '</span>';
      row.querySelector('.name').textContent = s.Name;
      row.querySelector('.list-row-sub').textContent = (s.Location || '') + (s.Region ? ' · ' + s.Region : '');
      host.appendChild(row);
    });
    refreshIcons();
  }).catch(function () {
    host.appendChild(emptyState('alert-triangle', 'Could not load sites'));
    refreshIcons();
  });
}

/* ===================================================================
 * USERS (SuperAdmin)
 * =================================================================== */
function renderUsers() {
  var host = $('usersList');
  clearChildren(host);
  api.users().then(function (r) {
    var users = r.data || [];
    if (!users.length) {
      host.appendChild(emptyState('users', 'No users yet'));
      refreshIcons();
      return;
    }
    users.forEach(function (u) {
      var roleKey = ROLE_FROM_API[u.Role] || u.Role;
      var card = el('div', 'card list-row');
      var tempPw = u.MustChangePassword ? '<span class="badge badge-amber tiny">Temp pw</span>' : '';
      card.innerHTML =
        '<div class="avatar avatar-primary">' + escapeHtml(initials(u.FullName)) + '</div>' +
        '<div class="list-row-body">' +
          '<div class="list-row-title"><span class="name"></span>' + tempPw + '</div>' +
          '<div class="list-row-sub email"></div>' +
        '</div>' +
        '<div class="list-row-right"><span class="badge ' + (ROLE_ACCENT_CLASS[roleKey] || 'role-secondary') + '">' + escapeHtml(ROLE_LABELS[roleKey] || u.Role) + '</span>' +
        '<div class="list-row-meta">' + escapeHtml(u.SiteID ? lookupSiteName(u.SiteID) || 'All sites' : 'All sites') + '</div></div>';
      card.querySelector('.name').textContent = u.FullName;
      card.querySelector('.email').textContent = u.Email;
      host.appendChild(card);
    });
    refreshIcons();
  }).catch(function () {
    host.appendChild(emptyState('alert-triangle', 'Could not load users'));
    refreshIcons();
  });
}

/* ===================================================================
 * AUDIT LOG (SuperAdmin)
 * =================================================================== */
function renderAudit() {
  var tbody = $('auditTable').querySelector('tbody');
  clearChildren(tbody);
  api.audit().then(function (r) {
    var logs = r.data || [];
    if (!logs.length) {
      var tr = el('tr'); tr.innerHTML = '<td colspan="5" class="empty-cell">No audit entries yet</td>';
      tbody.appendChild(tr);
      return;
    }
    logs.forEach(function (l) {
      var tr = el('tr');
      tr.innerHTML =
        '<td class="cell-ts">' + escapeHtml(fmtDateTime(l.Timestamp)) + '</td>' +
        '<td class="cell-user">' + escapeHtml(l.UserEmail || '—') + '</td>' +
        '<td><span class="badge-outline">' + escapeHtml(l.Action || '—') + '</span></td>' +
        '<td>' + escapeHtml(l.Resource || '—') + '</td>' +
        '<td class="hide-sm cell-details">' + escapeHtml(l.Details || '') + '</td>';
      tbody.appendChild(tr);
    });
  }).catch(function () {
    var tr = el('tr'); tr.innerHTML = '<td colspan="5" class="empty-cell">Could not load audit log</td>';
    tbody.appendChild(tr);
  });
}

/* ===================================================================
 * EXECUTIVE REPORTS (Gemini)
 * =================================================================== */
function renderReports() {
  var sel = $('repOutreach');
  clearChildren(sel);
  sel.appendChild(new Option('All outreaches', 'all'));
  STATE.cachedOutreaches.forEach(function (o) {
    sel.appendChild(new Option(o.Name, o.OutreachID));
  });
  // Refresh if empty
  if (!STATE.cachedOutreaches.length) {
    api.outreaches().then(function (r) {
      STATE.cachedOutreaches = r.data || [];
      STATE.cachedOutreaches.forEach(function (o) {
        sel.appendChild(new Option(o.Name, o.OutreachID));
      });
    });
  }
  var genBtn = $('genReportBtn');
  genBtn.innerHTML = ico('sparkles') + ' Generate';
  refreshIcons();
  genBtn.onclick = function () {
    var oid = sel.value === 'all' ? null : sel.value;
    genBtn.disabled = true; genBtn.innerHTML = ico('loader-circle', 'animate-spin') + ' Generating…';
    refreshIcons();
    hide('reportMetricsHost');
    clearChildren($('reportHost'));
    api.executiveReport(oid).then(function (r) {
      var metrics = r.metrics || {};
      renderReportMetrics(metrics);
      var md = r.markdown || '';
      $('reportHost').appendChild(el('div', 'card report-card', '<div class="twc-markdown">' + mdToHtml(md) + '</div>'));
      show('repPrintBtn');
      toastSuccess('Executive report generated via Gemini');
    }).catch(function (e) {
      toastError(e.message);
    }).then(function () {
      genBtn.disabled = false; genBtn.innerHTML = ico('sparkles') + ' Generate';
      refreshIcons();
    });
  };
  $('repPrintBtn').onclick = function () { window.print(); };
}

function renderReportMetrics(m) {
  var host = $('reportMetricsHost');
  clearChildren(host);
  var tiles = [
    ['Patients', m.totalPatients],
    ['Vitals captured', m.vitalsCaptured],
    ['Blood sugar tests', m.diagnosticsCaptured],
    ['Eye checks', m.eyeChecks],
    ['Dental checks', m.dentalChecks],
    ['Referrals', m.referrals],
    ['Avg age', m.avgAge],
    ['Hypertension flagged', m.hypertensiveCount],
    ['Diabetes flagged', m.hyperglycemicCount]
  ];
  tiles.forEach(function (t) {
    var tile = el('div', 'card metric-tile');
    tile.innerHTML = '<div class="metric-tile-val"></div><div class="metric-tile-lbl"></div>';
    tile.querySelector('.metric-tile-val').textContent = (t[1] == null ? 0 : t[1]);
    tile.querySelector('.metric-tile-lbl').textContent = t[0];
    host.appendChild(tile);
  });
  host.classList.remove('hidden');
}

function mdToHtml(md) {
  if (!md) return '';
  var h = escapeHtml(md);
  h = h.replace(/^### (.*)$/gm, '<h3>$1</h3>');
  h = h.replace(/^## (.*)$/gm, '<h2>$1</h2>');
  h = h.replace(/^# (.*)$/gm, '<h1>$1</h1>');
  h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/^[-*] (.*)$/gm, '<li>$1</li>');
  h = h.replace(/^\d+\. (.*)$/gm, '<li>$1</li>');
  h = h.replace(/(<li[\s\S]*?<\/li>)/g, function (m) { return '<ul>' + m + '</ul>'; });
  h = h.replace(/^---$/gm, '<hr>');
  h = h.replace(/\n{2,}/g, '<br><br>');
  return '<div class="md-body">' + h + '</div>';
}

/* ===================================================================
 * GAS SOURCE (SuperAdmin ONLY)
 * =================================================================== */
var gasSourceState = { files: [], group: 'All', activePath: null };

function renderGasSource() {
  // Guard: SuperAdmin only — should never be visible to others, but double-check
  if (STATE.user.role !== 'SUPER_ADMIN') {
    navigate('dashboard');
    return;
  }
  // Lazy-load gas source files via the API (this route doesn't exist yet in
  // Code.gs but we'll try gracefully; on failure show a built-in local list).
  api.gasSource().then(function (r) {
    gasSourceState.files = r.files || [];
    if (!gasSourceState.files.length) {
      // Fall back to a local static description so the view is still useful.
      gasSourceState.files = [
        { path: 'api/Code.gs', name: 'api/Code.gs', desc: 'GAS JSON API backend (split architecture). Routes, auth, captures, Gemini.', lineCount: 1700, lang: 'JavaScript', group: 'Split: Backend', content: '// See api/Code.gs in the project repository.' },
        { path: 'github-pages/index.html', name: 'github-pages/index.html', desc: 'Static PWA shell hosted on GitHub Pages.', lineCount: 530, lang: 'HTML', group: 'Split: Frontend', content: '<!-- See github-pages/index.html -->' },
        { path: 'github-pages/app.js', name: 'github-pages/app.js', desc: 'Vanilla JS client — auth, RBAC, capture tools, CV/signal processing.', lineCount: 1500, lang: 'JavaScript', group: 'Split: Frontend', content: '// See github-pages/app.js' },
        { path: 'github-pages/styles.css', name: 'github-pages/styles.css', desc: 'iOS-clean TWC design system.', lineCount: 700, lang: 'CSS', group: 'Split: Frontend', content: '/* See github-pages/styles.css */' },
        { path: 'github-pages/manifest.json', name: 'github-pages/manifest.json', desc: 'PWA manifest.', lineCount: 30, lang: 'JSON', group: 'Split: Frontend', content: '{}' },
        { path: 'github-pages/sw.js', name: 'github-pages/sw.js', desc: 'Service worker for offline caching.', lineCount: 30, lang: 'JavaScript', group: 'Split: Frontend', content: '// SW' },
        { path: 'Code.gs', name: 'Code.gs', desc: 'All-in-GAS backend (Option A).', lineCount: 1700, lang: 'JavaScript', group: 'All-in-GAS', content: '// See Code.gs' },
        { path: 'Index.html', name: 'Index.html', desc: 'GAS HtmlService template (Option A).', lineCount: 530, lang: 'HTML', group: 'All-in-GAS', content: '<!-- -->' },
        { path: 'JavaScript.html', name: 'JavaScript.html', desc: 'Inline JS (Option A).', lineCount: 1500, lang: 'JavaScript', group: 'All-in-GAS', content: '//' },
        { path: 'Stylesheet.html', name: 'Stylesheet.html', desc: 'Inline CSS (Option A).', lineCount: 700, lang: 'CSS', group: 'All-in-GAS', content: '/* */' },
        { path: 'ServiceWorker.html', name: 'ServiceWorker.html', desc: 'Inline SW (Option A).', lineCount: 30, lang: 'JavaScript', group: 'All-in-GAS', content: '//' },
        { path: 'manifest.json', name: 'manifest.json', desc: 'Inline manifest (Option A).', lineCount: 30, lang: 'JSON', group: 'All-in-GAS', content: '{}' },
        { path: 'DEPLOYMENT-GUIDE.md', name: 'DEPLOYMENT-GUIDE.md', desc: 'Full step-by-step deployment guide, schema, checklist & troubleshooting.', lineCount: 250, lang: 'Markdown', group: 'Guides', content: '# Deployment Guide\n\nSee project repository.' }
      ];
    }
    var total = r.totalLines || gasSourceState.files.reduce(function (s, f) { return s + (f.lineCount || 0); }, 0);
    $('gasHeroDesc').textContent = total.toLocaleString() + ' lines across ' + gasSourceState.files.length + ' files. Two architectures: deploy everything in GAS, or split into a GAS API + GitHub Pages frontend.';

    // Count per arch
    $('archCountA').textContent = gasSourceState.files.filter(function (f) { return fileGroup(f) === 'Option A'; }).length + ' files';
    $('archCountB').textContent = gasSourceState.files.filter(function (f) { return fileGroup(f) === 'Option B'; }).length + ' files';

    renderGasTabs();
    renderGasFileList();
    renderGasCodePanel();
    refreshIcons();
  }).catch(function () {
    $('gasHeroDesc').textContent = 'Could not load source listing.';
  });

  // Wire up arch cards + tabs + copy + download
  $('archOptionA').onclick = function () { gasSourceState.group = 'Option A'; gasSourceState.activePath = null; renderGasTabs(); renderGasFileList(); renderGasCodePanel(); };
  $('archOptionB').onclick = function () { gasSourceState.group = 'Option B'; gasSourceState.activePath = null; renderGasTabs(); renderGasFileList(); renderGasCodePanel(); };
  $('gasCopyBtn').onclick = function () {
    var f = activeGasFile();
    if (!f) return;
    navigator.clipboard.writeText(f.content || '').then(function () { toastSuccess('Copied to clipboard'); }).catch(function () { toastError('Could not copy'); });
  };
  $('gasDownloadBtn').onclick = function () {
    var f = activeGasFile();
    if (!f) return;
    var blob = new Blob([f.content || ''], { type: 'text/plain' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = f.name.split('/').pop();
    a.click();
    URL.revokeObjectURL(url);
    toastSuccess('Downloaded ' + f.name);
  };
}

function fileGroup(f) {
  if (!f || !f.group) return 'All';
  if (f.group === 'Guides') return 'Guides';
  if (f.group === 'All-in-GAS') return 'Option A';
  if (String(f.group).indexOf('Split') === 0) return 'Option B';
  return 'All';
}

function activeGasFile() {
  var visible = gasSourceState.group === 'All'
    ? gasSourceState.files
    : gasSourceState.files.filter(function (f) { return fileGroup(f) === gasSourceState.group; });
  if (!visible.length) return null;
  return visible.find(function (f) { return f.path === gasSourceState.activePath; }) || visible[0];
}

function renderGasTabs() {
  var host = $('gasTabs');
  clearChildren(host);
  var groups = [
    { key: 'All',        label: 'All files',                  icon: 'code-2' },
    { key: 'Option A',   label: 'Option A · All-in-GAS',      icon: 'cloud' },
    { key: 'Option B',   label: 'Option B · GAS + GitHub Pages', icon: 'split' },
    { key: 'Guides',     label: 'Guides',                     icon: 'book-open' }
  ];
  groups.forEach(function (g) {
    var count = g.key === 'All' ? gasSourceState.files.length : gasSourceState.files.filter(function (f) { return fileGroup(f) === g.key; }).length;
    var btn = el('button', 'gas-tab' + (gasSourceState.group === g.key ? ' active' : ''));
    btn.innerHTML = '<span class="gas-tab-ico">' + ico(g.icon) + '</span><span class="gas-tab-lbl">' + escapeHtml(g.label) + '</span><span class="gas-tab-count">' + count + '</span>';
    btn.onclick = function () { gasSourceState.group = g.key; gasSourceState.activePath = null; renderGasTabs(); renderGasFileList(); renderGasCodePanel(); };
    host.appendChild(btn);
  });
  refreshIcons();
}

function renderGasFileList() {
  var host = $('gasFileList');
  clearChildren(host);
  var visible = gasSourceState.group === 'All'
    ? gasSourceState.files
    : gasSourceState.files.filter(function (f) { return fileGroup(f) === gasSourceState.group; });
  visible.forEach(function (f) {
    var isActive = activeGasFile() && activeGasFile().path === f.path;
    var btn = el('button', 'gas-file' + (isActive ? ' active' : ''));
    btn.innerHTML =
      '<span class="gas-file-ico">' + ico('file-code-2') + '</span>' +
      '<div class="gas-file-body">' +
        '<div class="gas-file-name"></div>' +
        '<div class="gas-file-desc"></div>' +
        '<div class="gas-file-badges"><span class="badge-outline tiny">' + (f.lineCount || 0) + ' lines</span><span class="badge-outline tiny">' + escapeHtml(f.lang || 'Text') + '</span></div>' +
      '</div>';
    btn.querySelector('.gas-file-name').textContent = f.name;
    btn.querySelector('.gas-file-desc').textContent = f.desc || '';
    btn.addEventListener('click', function () { gasSourceState.activePath = f.path; renderGasFileList(); renderGasCodePanel(); });
    host.appendChild(btn);
  });
  refreshIcons();
}

function renderGasCodePanel() {
  var f = activeGasFile();
  if (!f) {
    $('gasCodeName').textContent = '—';
    $('gasCodeGroup').textContent = '—';
    $('gasCodeBody').textContent = '—';
    return;
  }
  $('gasCodeName').textContent = f.name;
  $('gasCodeGroup').textContent = f.group || '—';
  $('gasCodeBody').textContent = f.content || '';
}

/* ===================================================================
 * PWA + SW + ONLINE/OFFINE
 * =================================================================== */
var deferredPrompt = null;
function setupPWA() {
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    show('pwaInstall');
  });
  $('pwaInstallBtn').onclick = function () {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(function () {
      deferredPrompt = null;
      hide('pwaInstall');
    });
  };
  $('pwaDismiss').onclick = function () { hide('pwaInstall'); };

  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(function () { /* offline mode best-effort */ });
  }
}

function onOnline() {
  STATE.online = true;
  toastSuccess('Back online — syncing buffered captures');
  syncBufferedCaptures();
}
function onOffline() {
  STATE.online = false;
  toastWarn('Offline — captures will be buffered & synced on reconnect');
}

function bufferCapture(item) {
  var buf = JSON.parse(localStorage.getItem('twc_buffer') || '[]');
  buf.push(item);
  localStorage.setItem('twc_buffer', JSON.stringify(buf));
}

function syncBufferedCaptures() {
  var buf = JSON.parse(localStorage.getItem('twc_buffer') || '[]');
  if (!buf.length) return;
  api.syncBuffer(buf).then(function (r) {
    if (r && r.written) {
      toastSuccess(r.written + ' captures synced');
      localStorage.removeItem('twc_buffer');
    }
  }).catch(function () { /* will retry next online */ });
}

/* ===================================================================
 * FULLSCREEN HELPERS
 * =================================================================== */
function requestOverlayFullscreen(node) {
  if (!node) return;
  try {
    if (node.requestFullscreen) node.requestFullscreen().catch(function () {});
    else if (node.webkitRequestFullscreen) node.webkitRequestFullscreen();
  } catch (e) { /* overlay is fixed-positioned anyway */ }
}

/* ===================================================================
 * SHARED UI HELPERS
 * =================================================================== */
function emptyState(icoName, title, sub) {
  // icoName is a lucide icon name (e.g. 'alert-triangle', 'circle', 'calendar-days').
  // Caller must invoke refreshIcons() after appending the returned node to the DOM.
  return el('div', 'card empty-card', '<div class="empty-ico">' + ico(icoName) + '</div><div class="empty-title">' + escapeHtml(title) + '</div>' + (sub ? '<div class="empty-sub">' + escapeHtml(sub) + '</div>' : ''));
}

/* ===================================================================
 * CLOSE BUTTONS FOR OVERLAYS
 * =================================================================== */
function wireOverlayCloseButtons() {
  var rppgClose = $('rppgCloseBtn'); if (rppgClose) rppgClose.onclick = function () { closeRppgTool(false); };
  var rppgMax = $('rppgMaxBtn'); if (rppgMax) rppgMax.onclick = function () { requestOverlayFullscreen($('rppgOverlay')); };
  var vaClose = $('vaCloseBtn'); if (vaClose) vaClose.onclick = function () { stopVaAll(); hide('vaOverlay'); if (document.fullscreenElement) document.exitFullscreen().catch(function () {}); };
  var vaMax = $('vaMaxBtn'); if (vaMax) vaMax.onclick = function () { requestOverlayFullscreen($('vaOverlay')); };
  var dentalClose = $('dentalCloseBtn'); if (dentalClose) dentalClose.onclick = function () { closeDentalScanTool(false); };
  var dentalMax = $('dentalMaxBtn'); if (dentalMax) dentalMax.onclick = function () { requestOverlayFullscreen($('dentalOverlay')); };
}

/* ===================================================================
 * INIT
 * =================================================================== */
document.addEventListener('DOMContentLoaded', function () {
  wireOverlayCloseButtons();
  // Convert any static <i data-lucide> elements that weren't already
  // converted by the inline script in index.html (defensive — in case
  // lucide loaded after the inline call).
  refreshIcons();
  boot();
});
