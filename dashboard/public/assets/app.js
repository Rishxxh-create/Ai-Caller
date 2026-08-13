'use strict';
/* ==========================================================================
   RapidX Voice , Console (product dashboard) SPA.
   Vanilla JS. Zero dependencies. Hash routing. Talks only to our own /api/*
   so provider keys stay server side. No em dashes anywhere. Use commas or periods.
   ========================================================================== */

/* ---------- tiny DOM helpers ---------- */
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const el = (tag, attrs, kids) => {
  const n = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    if (k === 'class') n.className = attrs[k];
    else if (k === 'html') n.innerHTML = attrs[k];
    else if (k.slice(0, 2) === 'on' && typeof attrs[k] === 'function') n.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
    else if (attrs[k] != null && attrs[k] !== false) n.setAttribute(k, attrs[k]);
  }
  if (kids != null) (Array.isArray(kids) ? kids : [kids]).forEach((c) => {
    if (c == null || c === false) return;
    n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  });
  return n;
};

/* XSS guard. Always escape any user supplied string before it touches innerHTML.
   Most rendering uses el()+textContent which is safe by construction. esc() is the
   belt-and-suspenders for the rare html: paths. */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ---------- app state ---------- */
const State = {
  me: null,            // { user, tenant }
  health: null,        // { ok, providers, model }
  agents: [],
  providers: null,
  usage: null,
  telephony: null,
  wallet: null,
  presets: [],
  tickets: [],
  demoLinks: [],
  activeAgentId: null, // for Talk-to-it
  loaded: { agents: false, providers: false, usage: false, telephony: false, wallet: false, presets: false, tickets: false, demoLinks: false }
};

const VOICE_MODELS = ['bulbul:v3', 'bulbul:v2'];
const TTS_LANGUAGES = ['en-IN', 'hi-IN', 'ta-IN', 'te-IN', 'bn-IN', 'gu-IN', 'kn-IN', 'ml-IN', 'mr-IN', 'od-IN', 'pa-IN'];
/* Friendly names for the language select, e.g. "English", "Hindi". */
const LANG_LABELS = { 'en-IN': 'English', 'hi-IN': 'Hindi', 'ta-IN': 'Tamil', 'te-IN': 'Telugu', 'bn-IN': 'Bengali', 'gu-IN': 'Gujarati', 'kn-IN': 'Kannada', 'ml-IN': 'Malayalam', 'mr-IN': 'Marathi', 'od-IN': 'Odia', 'pa-IN': 'Punjabi' };
function langLabel(code) { return LANG_LABELS[code] || code || 'English'; }
/* All Sarvam Bulbul voices. V3 list first, then the seven v2-only voices. */
const SPEAKERS = ['shubh', 'aditya', 'ritu', 'priya', 'neha', 'rahul', 'pooja', 'rohan', 'simran', 'kavya', 'amit', 'dev', 'ishita', 'shreya', 'ratan', 'varun', 'manan', 'sumit', 'roopa', 'kabir', 'aayan', 'ashutosh', 'advait', 'anand', 'tanya', 'tarun', 'sunny', 'mani', 'gokul', 'vijay', 'shruti', 'suhani', 'mohit', 'kavitha', 'rehan', 'soham', 'rupali', 'anushka', 'abhilash', 'manisha', 'vidya', 'arya', 'karun', 'hitesh'];
const V2_VOICES = ['anushka', 'abhilash', 'manisha', 'vidya', 'arya', 'karun', 'hitesh'];
function modelForVoice(v) { return V2_VOICES.indexOf(v) !== -1 ? 'bulbul:v2' : 'bulbul:v3'; }
function voiceLabel(v) { return V2_VOICES.indexOf(v) !== -1 ? v + ' (v2)' : v; }
const BULBUL_V2_TONES = ['neutral', 'happy', 'sad', 'excited', 'angry', 'whisper'];
/* Rs per 1000 chars. Sarvam Bulbul promo about Rs 0.50 / 1000. Bulbul v2 slightly higher. */
const RATE = { 'bulbul:v3': 0.50, 'bulbul:v2': 0.99 };
function normalizeModel(model) {
  if (model === 'mulberry') return 'bulbul:v3';
  if (model === 'muga') return 'bulbul:v2';
  return model || 'bulbul:v3';
}

/* ===========================================================================
   FETCH WRAPPER
   credentials:include so the rxv_sess cookie rides along. JSON in, JSON out.
   A 401 on any authed call bounces to the login card.
   =========================================================================== */
async function api(path, opts) {
  opts = opts || {};
  const init = { method: opts.method || 'GET', credentials: 'include', headers: {} };
  const controller = new AbortController();
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 35000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  init.signal = controller.signal;
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    clearTimeout(timeout);
    if (e && e.name === 'AbortError') throw new ApiError(408, 'The agent took too long to respond. Please try again.');
    throw new ApiError(0, 'Network error. Is the server running.');
  }
  clearTimeout(timeout);
  if (res.status === 401 && !opts.allow401) {
    State.me = null;
    if (!path.endsWith('/api/me')) renderAuth();
    throw new ApiError(401, 'Please sign in.');
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.indexOf('application/json') !== -1) {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error || data.message || ('Request failed (' + res.status + ').'), data);
    return data;
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new ApiError(res.status, txt || ('Request failed (' + res.status + ').'));
  }
  return res; // raw (e.g. audio/wav)
}
function ApiError(status, message, data) { this.status = status; this.message = message; this.data = data || {}; }
ApiError.prototype = Object.create(Error.prototype);

/* ===========================================================================
   TOASTS
   =========================================================================== */
function toast(message, kind, title) {
  kind = kind || 'info';
  const host = $('#toasts');
  const t = el('div', { class: 'toast ' + kind }, [
    el('span', { class: 'ti' }),
    el('div', {}, [title ? el('b', {}, title) : null, el('div', {}, message)])
  ]);
  host.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, kind === 'err' ? 5200 : 3400);
}

/* ===========================================================================
   MODAL
   =========================================================================== */
function modal(opts) {
  // opts: { title, body(node), confirmText, confirmKind, onConfirm, cancelText }
  const host = $('#modal-host');
  const close = () => { host.classList.add('hide'); host.setAttribute('aria-hidden', 'true'); host.innerHTML = ''; };
  const confirmBtn = el('button', { class: 'btn ' + (opts.confirmKind === 'danger' ? 'btn-primary' : 'btn-primary') }, opts.confirmText || 'Confirm');
  if (opts.confirmKind === 'danger') confirmBtn.style.background = 'linear-gradient(100deg,#fb7185,#e11d48)';
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    try { await opts.onConfirm(); close(); }
    catch (e) { confirmBtn.disabled = false; toast(e.message || 'Action failed.', 'err'); }
  });
  const card = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, [
    el('h3', {}, opts.title || ''),
    opts.body || null,
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn btn-ghost', onclick: close }, opts.cancelText || 'Cancel'),
      confirmBtn
    ])
  ]);
  host.innerHTML = '';
  host.appendChild(el('div', { onclick: (e) => { if (e.target === e.currentTarget) close(); }, style: 'position:absolute;inset:0' }));
  host.appendChild(card);
  host.classList.remove('hide');
  host.setAttribute('aria-hidden', 'false');
  return close;
}

/* ===========================================================================
   SMALL UTILITIES
   =========================================================================== */
function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]).join('').toUpperCase() || '?';
}
function brandSVG(size) {
  // Inline logo mark, gradient. Returns an <svg> node so we never depend on logo.svg loading.
  const ns = 'http://www.w3.org/2000/svg';
  const gid = 'lg' + Math.random().toString(36).slice(2, 7);
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 40 40');
  svg.setAttribute('width', size || 30); svg.setAttribute('height', size || 30);
  svg.innerHTML =
    '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#34E7E4"/><stop offset="0.55" stop-color="#6E7BFF"/><stop offset="1" stop-color="#A855F7"/>' +
    '</linearGradient></defs>' +
    '<path d="M20 3 L34 11 V29 L20 37 L6 29 V11 Z" fill="none" stroke="url(#' + gid + ')" stroke-width="2"/>' +
    '<path d="M14 20 h2 l2 -6 3 12 2 -8 2 4 h3" fill="none" stroke="url(#' + gid + ')" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
  return svg;
}
function fmtInr(n) {
  const v = Number(n || 0);
  return v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}
function skeleton(kind, n) {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < (n || 1); i++) frag.appendChild(el('div', { class: 'sk ' + (kind || 'sk-card') }));
  return frag;
}

/* ===========================================================================
   BOOT
   =========================================================================== */
async function boot() {
  try {
    const me = await api('/api/me', { allow401: true });
    State.me = me;
    renderShell();
  } catch (e) {
    if (e.status === 401) renderAuth();
    else { renderAuth(); }
  }
}

/* ===========================================================================
   AUTH GATE
   =========================================================================== */
function renderAuth() {
  let mode = 'login'; // or 'signup'
  const root = $('#app');
  root.removeAttribute('aria-busy');

  function draw() {
    const errBox = el('div', { class: 'auth-err', id: 'authErr' });
    const fields = [];
    if (mode === 'signup') {
      fields.push(field('Your name', el('input', { class: 'input', id: 'f_name', type: 'text', placeholder: 'Shreyas Raj', autocomplete: 'name' })));
      fields.push(field('Company', el('input', { class: 'input', id: 'f_company', type: 'text', placeholder: 'Acme Co', autocomplete: 'organization' })));
    }
    fields.push(field('Email', el('input', { class: 'input', id: 'f_email', type: 'email', placeholder: 'you@company.com', autocomplete: 'email' })));
    fields.push(field('Password', el('input', { class: 'input', id: 'f_pass', type: 'password', placeholder: '••••••••', autocomplete: mode === 'signup' ? 'new-password' : 'current-password' })));

    const submit = el('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, mode === 'login' ? 'Sign in' : 'Create account');

    const form = el('form', { class: 'auth-form', onsubmit: onSubmit }, fields.concat([errBox, submit]));

    const card = el('div', { class: 'auth-card' }, [
      el('div', { class: 'auth-brand' }, [
        (function () { const s = brandSVG(34); s.classList.add('lm'); return s; })(),
        el('span', { class: 'nm' }, [document.createTextNode('RapidX '), el('em', {}, 'Voice')])
      ]),
      el('h1', {}, mode === 'login' ? 'Welcome back' : 'Start building'),
      el('p', { class: 'sub' }, mode === 'login' ? 'Sign in to your voice agent console.' : 'Spin up a tenant and ship AI voice agents from ₹1/min for the AI layer. Telephony is separate.'),
      form,
      el('div', { class: 'auth-toggle' }, [
        document.createTextNode(mode === 'login' ? 'New to RapidX Voice. ' : 'Already have an account. '),
        el('button', { type: 'button', onclick: () => { mode = mode === 'login' ? 'signup' : 'login'; draw(); } }, mode === 'login' ? 'Create one' : 'Sign in')
      ]),
      mode === 'login' ? el('div', { class: 'auth-demo' }, 'Use your workspace email and password. Test accounts are provisioned securely by the platform admin.') : null
    ]);

    root.innerHTML = '';
    root.appendChild(el('div', { class: 'auth-wrap' }, card));
    const first = $('#' + (mode === 'signup' ? 'f_name' : 'f_email'));
    if (first) first.focus();
  }

  function field(label, input) {
    return el('div', { class: 'field' }, [el('label', {}, label), input]);
  }

  async function onSubmit(e) {
    e.preventDefault();
    const err = $('#authErr');
    err.classList.remove('show');
    const email = ($('#f_email').value || '').trim();
    const password = $('#f_pass').value || '';
    if (!email || !password) { showErr('Email and password are required.'); return; }
    if (mode === 'signup' && password.length < 12) { showErr('Use at least 12 characters for your password.'); return; }
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = mode === 'login' ? 'Signing in...' : 'Creating...';
    try {
      let body, route;
      if (mode === 'signup') {
        body = { email: email, password: password, name: ($('#f_name').value || '').trim(), company: ($('#f_company').value || '').trim() };
        route = '/api/auth/signup';
      } else {
        body = { email: email, password: password };
        route = '/api/auth/login';
      }
      const res = await api(route, { method: 'POST', body: body, allow401: true });
      State.me = { user: res.user, tenant: res.tenant };
      resetData();
      toast(mode === 'login' ? 'Signed in.' : 'Account created.', 'ok');
      renderShell();
    } catch (ex) {
      btn.disabled = false; btn.textContent = mode === 'login' ? 'Sign in' : 'Create account';
      if (ex.status === 409) showErr('That email is already registered. Try signing in.');
      else if (ex.status === 401) showErr('Wrong email or password.');
      else showErr(ex.message || 'Something went wrong.');
    }
  }
  function showErr(m) { const err = $('#authErr'); err.textContent = m; err.classList.add('show'); }

  draw();
}
function resetData() {
  State.agents = []; State.providers = null; State.usage = null; State.telephony = null;
  State.wallet = null; State.presets = []; State.tickets = [];
  State.demoLinks = [];
  State.loaded = { agents: false, providers: false, usage: false, telephony: false, wallet: false, presets: false, tickets: false, demoLinks: false };
  State.activeAgentId = null;
}

/* ===========================================================================
   CONSOLE SHELL
   =========================================================================== */
const ROUTES = [
  { id: 'overview', label: 'Overview', icon: 'grid' },
  { id: 'agents', label: 'Agents', icon: 'users' },
  { id: 'knowledge', label: 'Knowledge base', icon: 'book' },
  { id: 'presets', label: 'Presets', icon: 'template' },
  { id: 'studio', label: 'Voice Studio', icon: 'wave' },
  { id: 'demos', label: 'Demo links', icon: 'link', ownerOnly: true },
  { id: 'talk', label: 'Talk to it', icon: 'mic' },
  { id: 'telephony', label: 'Telephony', icon: 'phone' },
  { id: 'billing', label: 'Billing', icon: 'wallet' },
  { id: 'support', label: 'Support', icon: 'support' },
  { id: 'admin', label: 'Admin', icon: 'shield', adminOnly: true },
  { id: 'settings', label: 'Settings', icon: 'gear' }
];

function navIcon(name) {
  const paths = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.4"/><rect x="14" y="3" width="7" height="7" rx="1.4"/><rect x="3" y="14" width="7" height="7" rx="1.4"/><rect x="14" y="14" width="7" height="7" rx="1.4"/>',
    users: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><path d="M16 6.2a3 3 0 0 1 0 5.6"/><path d="M17 14.5a5.5 5.5 0 0 1 3.5 5.5"/>',
    wave: '<path d="M2 12h2l2-6 3 14 3-18 3 14 2-6h2"/>',
    mic: '<rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5V21"/><path d="M8.5 21h7"/>',
    phone: '<path d="M5 3.5h3l1.5 4.5-2 1.5a12 12 0 0 0 5.5 5.5l1.5-2 4.5 1.5v3a1.5 1.5 0 0 1-1.6 1.5A16.5 16.5 0 0 1 3.5 5.1 1.5 1.5 0 0 1 5 3.5z"/>',
    gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v2.6M12 18.9v2.6M21.5 12h-2.6M5.1 12H2.5M18.5 5.5l-1.8 1.8M7.3 16.7l-1.8 1.8M18.5 18.5l-1.8-1.8M7.3 7.3 5.5 5.5"/>',
    template: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    wallet: '<path d="M4 6.5h14a2 2 0 0 1 2 2v9H4a2 2 0 0 1-2-2v-11a2 2 0 0 0 2 2z"/><path d="M15 11h7v4h-7a2 2 0 0 1 0-4z"/>',
    support: '<path d="M4 13a8 8 0 0 1 16 0v5a2 2 0 0 1-2 2h-3"/><path d="M4 13v4H2v-4h2M20 13v4h2v-4h-2"/>',
    shield: '<path d="M12 3 20 6v6c0 5-3.4 8-8 9-4.6-1-8-4-8-9V6l8-3z"/><path d="m9 12 2 2 4-5"/>',
    link: '<path d="M10.5 13.5a4 4 0 0 0 5.7 0l2.3-2.3a4 4 0 0 0-5.7-5.7l-1.3 1.3"/><path d="M13.5 10.5a4 4 0 0 0-5.7 0l-2.3 2.3a4 4 0 0 0 5.7 5.7l1.3-1.3"/>',
    book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15.5H6.5A2.5 2.5 0 0 0 4 21V5.5z"/><path d="M4 18.5A2.5 2.5 0 0 1 6.5 16H20"/><path d="M9 7.5h7M9 11h4"/>',
    logout: '<path d="M14 3.5H6.5A1.5 1.5 0 0 0 5 5v14a1.5 1.5 0 0 0 1.5 1.5H14"/><path d="M17 8l4 4-4 4"/><path d="M21 12H9"/>'
  };
  return '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + (paths[name] || paths.grid) + '</svg>';
}

function renderShell() {
  const root = $('#app');
  root.removeAttribute('aria-busy');
  const t = State.me.tenant, u = State.me.user;

  const visibleRoutes = ROUTES.filter((r) => {
    if (r.adminOnly && !['super_admin', 'admin'].includes(u.role)) return false;
    if (r.ownerOnly && !['super_admin', 'admin', 'owner'].includes(u.role)) return false;
    return true;
  });
  const nav = el('nav', { class: 'nav' }, visibleRoutes.map((r) =>
    el('a', { href: '#/' + r.id, 'data-route': r.id, html: navIcon(r.icon) + '<span>' + esc(r.label) + '</span>' })
  ));

  const side = el('aside', { class: 'side' }, [
    el('div', { class: 'side-brand' }, [
      (function () { const s = brandSVG(30); s.classList.add('lm'); return s; })(),
      el('span', { class: 'nm' }, [document.createTextNode('RapidX '), el('em', {}, 'Voice')])
    ]),
    nav,
    el('div', { class: 'side-foot' }, [
      el('div', { class: 'tenant-chip' }, [
        el('div', { class: 'av' }, initials(t.name)),
        el('div', { class: 'meta' }, [
          el('div', { class: 'tn', title: t.name }, t.name),
          el('div', { class: 'tp' }, (t.plan || 'studio') + ' plan')
        ])
      ]),
      el('button', { class: 'side-logout', onclick: doLogout, html: navIcon('logout') + '<span>Sign out</span>' })
    ])
  ]);

  const top = el('header', { class: 'top' }, [
    el('div', { class: 'flex items-center gap-2', style: 'min-width:0' }, [
      el('button', { class: 'menu-btn', 'aria-label': 'Menu', onclick: () => $('.shell').classList.toggle('nav-open'), html: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>' }),
      el('div', { class: 'top-route' }, [
        el('span', { class: 'crumb' }, 'RapidX Voice'),
        el('span', { class: 'ttl', id: 'routeTitle' }, 'Overview')
      ])
    ]),
    el('div', { class: 'health-row', id: 'healthRow' }, healthChips())
  ]);

  const impersonationBanner = State.me.impersonation ? el('div', { class: 'impersonation-banner' }, [
    el('div', {}, [el('b', {}, 'Viewing as ' + u.email), el('span', {}, 'Read-only safety mode. Reason: ' + (State.me.impersonation.reason || 'Support review'))]),
    el('button', { class: 'btn btn-dark', onclick: exitImpersonation }, 'Exit user view')
  ]) : null;

  const shell = el('div', { class: 'shell' + (impersonationBanner ? ' is-impersonating' : '') }, [
    side, top, impersonationBanner,
    el('main', { class: 'main', id: 'view' }),
    el('div', { class: 'nav-scrim', onclick: () => $('.shell').classList.remove('nav-open') })
  ]);

  root.innerHTML = '';
  root.appendChild(shell);

  window.removeEventListener('hashchange', onRoute);
  window.addEventListener('hashchange', onRoute);
  loadHealth();
  onRoute();
}

async function exitImpersonation() {
  await api('/api/auth/impersonation/exit', { method: 'POST', body: {} });
  State.me = await api('/api/me');
  renderShell();
  toast('Returned to super admin.', 'ok');
}

async function doLogout() {
  try { await api('/api/auth/logout', { method: 'POST', allow401: true }); } catch (e) {}
  State.me = null; resetData();
  toast('Signed out.', 'info');
  renderAuth();
}

/* ---- health chips ---- */
function healthChips() {
  const layers = [
    { key: 'tts', label: 'TTS' },
    { key: 'llm', label: 'Brain' },
    { key: 'telephony', label: 'Telephony' }
  ];
  return layers.map((L) => {
    const chip = el('span', { class: 'hchip loading', 'data-layer': L.key }, [
      el('span', { class: 'dot' }),
      el('span', { class: 'lbl-txt' }, L.label)
    ]);
    return chip;
  });
}
async function loadHealth() {
  try {
    const h = await api('/api/health', { allow401: true });
    State.health = h;
    paintHealth();
  } catch (e) {
    $$('#healthRow .hchip').forEach((c) => { c.className = 'hchip bad'; });
  }
}
function paintHealth() {
  const h = State.health; if (!h) return;
  const map = {
    tts: h.providers && h.providers.tts ? Object.values(h.providers.tts).some(Boolean) : false,
    llm: h.providers && h.providers.llm ? Object.values(h.providers.llm).some(Boolean) : false,
    telephony: h.providers && h.providers.telephony ? Object.values(h.providers.telephony).some(Boolean) : false
  };
  $$('#healthRow .hchip').forEach((c) => {
    const layer = c.getAttribute('data-layer');
    c.classList.remove('loading');
    c.className = 'hchip ' + (map[layer] ? 'ok' : 'bad');
    c.setAttribute('data-layer', layer);
  });
}

/* ===========================================================================
   ROUTER
   =========================================================================== */
function currentRoute() {
  const hash = (location.hash || '').replace(/^#\/?/, '').split('?')[0];
  const found = ROUTES.find((r) => r.id === hash &&
    (!r.adminOnly || (State.me && ['super_admin', 'admin'].includes(State.me.user.role))) &&
    (!r.ownerOnly || (State.me && ['super_admin', 'admin', 'owner'].includes(State.me.user.role))));
  return found ? found.id : 'overview';
}
function onRoute() {
  if (!State.me) return;
  const raw = (location.hash || '').replace(/^#\/?/, '').split('?')[0];
  const isNewAgent = raw === 'agents/new';
  const id = currentRoute();
  const navId = isNewAgent ? 'agents' : id;
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('data-route') === navId));
  const r = ROUTES.find((x) => x.id === id);
  const tt = $('#routeTitle'); if (tt) tt.textContent = isNewAgent ? 'Create agent' : (r ? r.label : 'Overview');
  $('.shell') && $('.shell').classList.remove('nav-open');
  const view = $('#view');
  view.innerHTML = '';
  const wrap = el('div', { class: 'view' });
  view.appendChild(wrap);
  const views = {
    overview: viewOverview, agents: viewAgents, knowledge: viewKnowledge, presets: viewPresets, studio: viewStudio, demos: viewDemoLinks,
    talk: viewTalk, telephony: viewTelephony, billing: viewBilling,
    support: viewSupport, admin: viewAdmin, settings: viewSettings
  };
  (isNewAgent ? viewAgentNew : (views[id] || viewOverview))(wrap);
}
function goto(id) { location.hash = '#/' + id; }

/* ---- shared view header ---- */
function viewHead(title, sub) {
  return el('div', { class: 'view-head' }, [el('h2', {}, title), sub ? el('p', {}, sub) : null]);
}

/* ===========================================================================
   1. OVERVIEW
   =========================================================================== */
async function viewOverview(root) {
  const name = State.me.user.name || State.me.user.email;
  root.appendChild(viewHead('Welcome back, ' + name + '.', 'Your voice stack at a glance. Provider health, usage, and the fastest way into a build.'));

  const statsRow = el('div', { class: 'grid grid-3' }, skeleton('sk-stat', 3));
  root.appendChild(statsRow);

  const body = el('div', { class: 'grid grid-12', style: 'margin-top:18px' }, [
    el('div', { class: 'card spark-card', id: 'sparkHost' }, skeleton('sk-card', 1)),
    el('div', { class: 'card card-pad', id: 'qaHost' }, [
      el('h3', { class: 't-h3', style: 'margin-bottom:14px' }, 'Quick actions'),
      el('div', { class: 'qa-row' }, [
        el('button', { class: 'btn btn-primary', onclick: () => goto('agents') }, 'Build an agent'),
        el('button', { class: 'btn btn-ghost', onclick: () => goto('studio') }, 'Open Voice Studio'),
        el('button', { class: 'btn btn-ghost', onclick: () => goto('talk') }, 'Talk to it'),
        el('button', { class: 'btn btn-ghost', onclick: () => goto('telephony') }, 'Telephony')
      ]),
      el('div', { class: 'divider', style: 'margin:18px 0' }),
      el('div', { id: 'provMini', class: 'soft', style: 'font-size:.85rem' }, 'Checking providers...')
    ])
  ]);
  root.appendChild(body);

  // load usage + agents in parallel
  try {
    const [usage, agentsRes] = await Promise.all([
      api('/api/usage'),
      State.loaded.agents ? Promise.resolve({ agents: State.agents }) : api('/api/agents')
    ]);
    State.usage = usage;
    State.agents = agentsRes.agents || [];
    State.loaded.agents = true;

    const totals = usage.totals || {};
    statsRow.innerHTML = '';
    statsRow.appendChild(statCard('Agents', String(State.agents.length), 'Live in this tenant'));
    statsRow.appendChild(statCard('Characters synthesized', fmtInr(totals.chars || 0), 'Across all days'));
    statsRow.appendChild(statCard('Estimated spend', '₹' + fmtInr(totals.costInr || estimateCost(usage)), 'At promo rates', true));

    const sh = $('#sparkHost'); sh.innerHTML = '';
    sh.appendChild(sparkPanel(usage.days || []));
  } catch (e) {
    statsRow.innerHTML = '';
    statsRow.appendChild(el('div', { class: 'card card-pad muted' }, 'Could not load usage. ' + esc(e.message)));
  }

  // provider mini summary
  ensureProviders().then(() => {
    const pm = $('#provMini'); if (!pm) return;
    const reg = State.providers || {};
    const live = [];
    ['tts', 'llm', 'telephony'].forEach((layer) => {
      (reg[layer] || []).forEach((p) => { if (p.live) live.push(p.label); });
    });
    pm.textContent = live.length ? ('Active providers: ' + live.join(', ') + '.') : 'No live providers detected.';
  }).catch(() => {});
}

function statCard(lbl, val, delta, up) {
  return el('div', { class: 'card stat' }, [
    el('div', { class: 'lbl' }, lbl),
    el('div', { class: 'val' }, val),
    el('div', { class: 'delta' + (up ? ' up' : '') }, delta)
  ]);
}
function estimateCost(usage) {
  // fallback if backend does not return costInr in totals
  let c = 0;
  (usage.days || []).forEach((d) => { c += (d.costInr || (d.chars || 0) / 1000 * RATE['bulbul:v3']); });
  return Math.round(c * 100) / 100;
}

/* ---- sparkline (inline SVG, no libs) ---- */
function sparkPanel(days) {
  const data = (days || []).map((d) => ({ day: d.day, v: d.chars || 0 }));
  const total = data.reduce((s, d) => s + d.v, 0);
  const head = el('div', { class: 'hd' }, [
    el('div', { class: 't' }, 'Usage, characters per day'),
    el('div', { class: 'v' }, fmtInr(total) + ' total')
  ]);
  const svg = buildSpark(data);
  const xlabels = el('div', { class: 'spark-x' }, [
    el('span', {}, data.length ? shortDay(data[0].day) : ''),
    el('span', {}, data.length ? shortDay(data[data.length - 1].day) : 'no data yet')
  ]);
  return el('div', {}, [head, svg, xlabels]);
}
function shortDay(iso) {
  if (!iso) return '';
  const p = iso.split('-'); return p.length === 3 ? (p[2] + '/' + p[1]) : iso;
}
function buildSpark(data) {
  const W = 600, H = 120, pad = 6;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'spark-svg');
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.innerHTML =
    '<defs>' +
    '<linearGradient id="sparkline" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#34E7E4"/><stop offset="0.6" stop-color="#6E7BFF"/><stop offset="1" stop-color="#A855F7"/></linearGradient>' +
    '<linearGradient id="sparkfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6E7BFF" stop-opacity="0.32"/><stop offset="1" stop-color="#6E7BFF" stop-opacity="0"/></linearGradient>' +
    '</defs>';
  if (!data.length) {
    const txt = document.createElementNS(ns, 'text');
    txt.setAttribute('x', W / 2); txt.setAttribute('y', H / 2 + 4); txt.setAttribute('text-anchor', 'middle');
    txt.setAttribute('fill', '#5C6479'); txt.setAttribute('font-size', '13'); txt.setAttribute('font-family', 'monospace');
    txt.textContent = 'Synthesize something to see usage here.';
    svg.appendChild(txt);
    return svg;
  }
  const max = Math.max(1, ...data.map((d) => d.v));
  const n = data.length;
  const x = (i) => pad + (n === 1 ? (W - 2 * pad) / 2 : (i / (n - 1)) * (W - 2 * pad));
  const y = (v) => H - pad - (v / max) * (H - 2 * pad);
  let line = '';
  data.forEach((d, i) => { line += (i === 0 ? 'M' : 'L') + x(i).toFixed(1) + ' ' + y(d.v).toFixed(1) + ' '; });
  const area = 'M' + x(0).toFixed(1) + ' ' + (H - pad) + ' ' + line.replace(/^M/, 'L') + 'L' + x(n - 1).toFixed(1) + ' ' + (H - pad) + ' Z';
  const areaP = document.createElementNS(ns, 'path'); areaP.setAttribute('class', 'area'); areaP.setAttribute('d', area);
  const lineP = document.createElementNS(ns, 'path'); lineP.setAttribute('class', 'ln'); lineP.setAttribute('d', line.trim());
  svg.appendChild(areaP); svg.appendChild(lineP);
  // last point dot
  const c = document.createElementNS(ns, 'circle');
  c.setAttribute('cx', x(n - 1)); c.setAttribute('cy', y(data[n - 1].v)); c.setAttribute('r', 3.2);
  c.setAttribute('fill', '#A855F7'); c.setAttribute('stroke', '#fff'); c.setAttribute('stroke-width', '1');
  svg.appendChild(c);
  return svg;
}

/* ===========================================================================
   PROVIDERS + AGENTS data loaders
   =========================================================================== */
async function ensureProviders() {
  if (State.loaded.providers) return State.providers;
  const res = await api('/api/providers');
  // res can be { tts:[...], llm:[...], telephony:[...] } or { providers:{...} }
  State.providers = res.providers || res;
  State.loaded.providers = true;
  return State.providers;
}
async function ensureAgents(force) {
  if (State.loaded.agents && !force) return State.agents;
  const res = await api('/api/agents');
  State.agents = res.agents || [];
  State.loaded.agents = true;
  return State.agents;
}
async function ensureTelephony(force) {
  if (State.loaded.telephony && !force) return State.telephony;
  const res = await api('/api/telephony/status');
  State.telephony = res;
  State.loaded.telephony = true;
  return State.telephony;
}

/* ===========================================================================
   2. AGENTS
   =========================================================================== */
async function viewAgents(root) {
  root.appendChild(el('div', { style: 'display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap' }, [
    viewHead('Agents', 'Each agent is a persona plus a voice. Preview the voice, then assign a number and ship it.'),
    el('button', { class: 'btn btn-primary', onclick: () => goto('agents/new') }, 'Create Agent')
  ]));

  const gridHost = el('div', { id: 'agentsGrid', class: 'agents-grid', style: 'margin-top:22px' }, skeleton('sk-card', 3));
  root.appendChild(gridHost);

  try {
    await Promise.all([ensureAgents(true), ensureTelephony().catch(() => null), ensureProviders().catch(() => null)]);
    refillDidOptions();
    paintAgents();
  } catch (e) {
    gridHost.innerHTML = '';
    gridHost.appendChild(el('div', { class: 'empty muted' }, 'Could not load agents. ' + esc(e.message)));
  }
}

async function viewAgentNew(root) {
  root.appendChild(el('div', { style: 'display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap' }, [
    viewHead('Create agent', 'Set up the persona and voice, then tune language, pronunciation, and knowledge in Settings.'),
    el('button', { class: 'btn btn-ghost', onclick: () => goto('agents') }, 'Back to agents')
  ]));
  try {
    await Promise.all([ensureTelephony().catch(() => null), ensureProviders().catch(() => null)]);
    root.appendChild(buildAgentForm(null));
    setTimeout(refillDidOptions, 0);
  } catch (e) {
    root.appendChild(el('div', { class: 'empty muted' }, 'Could not load the builder. ' + esc(e.message)));
  }
}

function dids() {
  const t = State.telephony || {};
  const list = t.dids || (t.did ? [{ number: t.did }] : []);
  return list.map((d) => (typeof d === 'string' ? d : d.number || d.did)).filter(Boolean);
}
function refillDidOptions() {
  const sel = $('#f_did'); if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '';
  sel.appendChild(el('option', { value: '' }, 'No number assigned'));
  dids().forEach((n) => sel.appendChild(el('option', { value: n }, n)));
  if (cur) sel.value = cur;
}

function buildAgentForm(existing) {
  const e = existing || {};
  const tts = e.tts || {};
  const state = {
    model: normalizeModel(tts.model),
    speaker: tts.speaker || 'shubh',
    f0: tts.f0_up_key != null ? tts.f0_up_key : 0,
    language: tts.language || 'en-IN'
  };

  const nameI = el('input', { class: 'input', id: 'f_name', type: 'text', value: e.name || '', placeholder: 'Front Desk', maxlength: 80 });
  const personaI = el('textarea', { class: 'textarea', id: 'f_persona', rows: 8, maxlength: 10000, placeholder: 'You are a warm, sharp receptionist. Answer in 1 to 2 short spoken sentences, qualify the lead, and book a callback. Describe in detail how the agent should behave, what to collect, and any guardrails.' }, e.persona || '');
  const greetI = el('input', { class: 'input', id: 'f_greeting', type: 'text', value: e.greeting || '', placeholder: 'Hi, thanks for calling RapidX. How can I help today.', maxlength: 240 });
  const descI = el('input', { class: 'input', id: 'f_desc', type: 'text', value: (tts.description || ''), placeholder: 'Optional voice direction, e.g. calm and confident' });

  const modelSeg = el('div', { class: 'seg', id: 'f_model_seg' }, VOICE_MODELS.map((m) =>
    el('button', { type: 'button', class: m === state.model ? 'on' : '', 'data-m': m, onclick: () => { state.model = m; syncVoice(); } }, m)
  ));
  const speakerSel = el('select', { class: 'select', id: 'f_speaker' }, SPEAKERS.map((s) =>
    el('option', { value: s, selected: s === state.speaker ? 'selected' : false }, voiceLabel(s))
  ));
  speakerSel.addEventListener('change', () => {
    state.speaker = speakerSel.value;
    const m = modelForVoice(state.speaker);
    if (m !== state.model) { state.model = m; syncVoice(); }
  });
  const f0Val = el('span', { class: 'rv', id: 'f_f0_val' }, String(state.f0));
  const f0Range = el('input', { type: 'range', id: 'f_f0', min: -12, max: 12, step: 1, value: state.f0, oninput: (ev) => { state.f0 = +ev.target.value; f0Val.textContent = (state.f0 > 0 ? '+' : '') + state.f0; } });
  if (state.f0 > 0) f0Val.textContent = '+' + state.f0;

  const langSel = el('select', { class: 'select', id: 'f_lang' }, TTS_LANGUAGES.map((lc) => el('option', { value: lc, selected: state.language === lc ? 'selected' : false }, langLabel(lc))));
  langSel.addEventListener('change', () => { state.language = langSel.value; });

  const didSel = el('select', { class: 'select', id: 'f_did' }, [el('option', { value: '' }, 'No number assigned')]);
  if (e.telephony && e.telephony.did) { /* set after dids load */ setTimeout(() => { try { didSel.value = e.telephony.did; } catch (x) {} }, 0); }

  const speakerField = field('Voice', speakerSel);
  const descField = field('Voice direction (bulbul:v3)', descI);
  const variablesI = el('input', { class: 'input', id: 'f_variables', type: 'text', value: (Array.isArray(e.variables) ? e.variables : []).join(', '), placeholder: 'caller_name, callback_number, reason, insurance', maxlength: 300 });
  function syncVoice() {
    $$('#f_model_seg button').forEach((b) => b.classList.toggle('on', b.getAttribute('data-m') === state.model));
    speakerField.style.display = '';
    descField.style.display = state.model === 'bulbul:v3' ? '' : 'none';
  }

  /* ---- pronunciation dictionary (JSON file only) ---- */
  let pronoWords = {};
  try { pronoWords = (e.pronunciations && typeof e.pronunciations === 'object' && !Array.isArray(e.pronunciations)) ? e.pronunciations : {}; } catch (x) {}
  const pronoInfo = el('div', { class: 'hint' });
  const clearPronoBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => { pronoWords = {}; paintProno(); toast('Pronunciation dictionary cleared.', 'ok'); } }, 'Clear');
  const pronoFile = el('input', { type: 'file', id: 'f_prono_file', class: 'input', style: 'max-width:320px', accept: '.json,application/json' });
  function paintProno() {
    const keys = Object.keys(pronoWords);
    clearPronoBtn.disabled = !keys.length;
    pronoInfo.textContent = keys.length
      ? keys.length + ' entries loaded (e.g. ' + keys.slice(0, 3).join(', ') + '). Only .json files are accepted.'
      : 'Only .json files are accepted, e.g. { "RapidX": "rap-id-x", "Qatar": "ku-ter" }.';
  }
  pronoFile.addEventListener('change', () => {
    const file = pronoFile.files && pronoFile.files[0];
    if (!file) return;
    if (!/\.json$/i.test(file.name)) { toast('Only JSON files are accepted.', 'err'); pronoFile.value = ''; return; }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const obj = JSON.parse(reader.result);
        let rawWords = {};
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          if (Array.isArray(obj.entries)) rawWords = Object.fromEntries(obj.entries.filter((x) => x && x.word != null && x.pronunciation != null).map((x) => [String(x.word), String(x.pronunciation)]));
          else rawWords = obj;
        } else {
          throw new Error('expected a JSON object of words to pronunciations');
        }
        const clean = {};
        for (const k of Object.keys(rawWords)) {
          if (Object.keys(clean).length >= 500) break;
          const v = rawWords[k];
          if (typeof v !== 'string' && typeof v !== 'number') continue;
          clean[k.slice(0, 200)] = String(v).slice(0, 500);
        }
        pronoWords = clean;
        paintProno();
        toast('Pronunciation dictionary loaded (' + Object.keys(clean).length + ' entries).', 'ok');
      } catch (err) {
        toast('Invalid JSON: ' + err.message, 'err');
      }
      pronoFile.value = '';
    };
    reader.readAsText(file);
  });
  paintProno();

  /* ---- knowledge base (facts) ---- */
  const factsDraft = ((e.knowledge && e.knowledge.facts) || []).map((f) => ({ id: f.id, title: f.title || '', content: f.content || '' }));
  const factsList = el('div', { class: 'kfacts', style: 'margin-top:10px' });
  function paintFacts() {
    factsList.innerHTML = '';
    if (!factsDraft.length) {
      factsList.appendChild(el('div', { class: 'empty muted', style: 'padding:14px' }, 'No knowledge yet. Add a titled fact below, e.g. pricing or opening hours.'));
      return;
    }
    factsDraft.forEach((f, i) => {
      const titleI = el('input', { class: 'input', value: f.title, placeholder: 'Short title, e.g. Pricing', maxlength: 120, oninput: (ev) => { f.title = ev.target.value; } });
      const contentI = el('textarea', { class: 'textarea', rows: 3, value: f.content, placeholder: 'What the agent should know.', maxlength: 6000, oninput: (ev) => { f.content = ev.target.value; } });
      factsList.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'flex', style: 'justify-content:space-between;align-items:center;margin-bottom:10px' }, [
          el('b', {}, 'Fact ' + (i + 1)),
          el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => { factsDraft.splice(i, 1); paintFacts(); } }, 'Remove')
        ]),
        el('div', { class: 'form-grid' }, [
          field('Title', titleI),
          (function () { const f2 = field('Content', contentI); f2.classList.add('full'); return f2; })()
        ])
      ]));
    });
  }
  paintFacts();
  const addFactBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => { factsDraft.push({ id: 'kf_' + Math.random().toString(36).slice(2, 10), title: '', content: '' }); paintFacts(); } }, '+ Add fact');

  const submitBtn = el('button', { class: 'btn btn-primary' }, existing ? 'Save changes' : 'Create agent');
  const form = el('form', { onsubmit: onSave, class: 'stack col', style: 'gap:16px' }, [
    el('div', { class: 'card builder' }, [
      el('h3', {}, existing ? 'Edit agent' : 'New agent'),
      el('p', { class: 'hint' }, existing ? 'Update the persona, voice, or settings.' : 'Set up the basics, then tune voice and knowledge in Settings.'),
      el('div', { class: 'form-grid' }, [
        field('Agent name', nameI),
        field('Assigned number', didSel),
        (function () { const f = field('Persona', personaI); f.classList.add('full'); return f; })(),
        (function () { const f = field('Variables to collect', variablesI); f.classList.add('full'); f.appendChild(el('p', { class: 'hint' }, 'Comma-separated fields the agent should collect on the call. Each collected value is stored with the call.')); return f; })(),
        (function () { const f = field('Greeting', greetI); f.classList.add('full'); return f; })()
      ])
    ]),
    el('div', { class: 'card builder' }, [
      el('h3', {}, 'Settings'),
      el('p', { class: 'hint' }, 'Language, voices, pronunciation dictionary, and knowledge base.'),
      el('div', { class: 'form-grid' }, [
        field('Language', langSel),
        field('Voice model', modelSeg),
        field('Pitch, f0_up_key', el('div', { class: 'range-row' }, [f0Range, f0Val])),
        speakerField,
        descField
      ]),
      el('div', { class: 'sett-group' }, [
        el('label', {}, 'Pronunciation dictionary (JSON file only)'),
        el('div', { class: 'flex', style: 'gap:10px;align-items:center;flex-wrap:wrap' }, [pronoFile, clearPronoBtn]),
        pronoInfo
      ]),
      el('div', { class: 'sett-group' }, [
        el('label', {}, 'Knowledge base'),
        el('p', { class: 'hint' }, 'Facts are baked into the agent brain everywhere. Add titled facts so the agent can answer about your business.'),
        el('div', { style: 'margin-top:10px' }, [addFactBtn]),
        factsList
      ]),
      el('div', { class: 'flex gap-2', style: 'margin-top:18px;align-items:center' }, [submitBtn, existing ? el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => modalClose() }, 'Cancel') : null])
    ])
  ]);

  syncVoice();

  let _modalClose = null;
  function modalClose() { if (_modalClose) _modalClose(); }
  form._setModalClose = (fn) => { _modalClose = fn; };

  async function onSave(ev) {
    ev.preventDefault();
    const name = nameI.value.trim();
    const persona = personaI.value.trim();
    if (!name) { toast('Give the agent a name.', 'err'); nameI.focus(); return; }
    if (!persona) { toast('Add a persona so the agent knows how to behave.', 'err'); personaI.focus(); return; }
    submitBtn.disabled = true; submitBtn.textContent = existing ? 'Saving...' : 'Creating...';
    const payload = {
      name: name,
      persona: persona,
      greeting: greetI.value.trim(),
      did: didSel.value || '',
      variables: variablesI.value.split(',').map((v) => v.trim()).filter(Boolean),
      tts: { model: state.model, speaker: state.speaker, f0_up_key: state.f0, description: descI.value.trim(), language: state.language },
      pronunciations: pronoWords,
      knowledge: { facts: factsDraft }
    };
    try {
      if (existing) {
        payload.id = existing.id;
        const res = await api('/api/agents/update', { method: 'POST', body: payload });
        const idx = State.agents.findIndex((a) => a.id === existing.id);
        if (idx !== -1) State.agents[idx] = res.agent || Object.assign({}, existing, payload);
        toast('Agent updated.', 'ok');
        modalClose();
      } else {
        const res = await api('/api/agents', { method: 'POST', body: payload });
        if (res.agent) State.agents.push(res.agent);
        toast('Agent created.', 'ok');
        goto('agents');
      }
      paintAgents();
    } catch (ex) {
      toast(ex.message || 'Could not save agent.', 'err');
    } finally {
      submitBtn.disabled = false; submitBtn.textContent = existing ? 'Save changes' : 'Create agent';
    }
  }

  return form;
}

function paintAgents() {
  const grid = $('#agentsGrid'); if (!grid) return;
  refillDidOptions();
  grid.innerHTML = '';
  if (!State.agents.length) {
    grid.appendChild(el('div', { class: 'empty' }, [
      el('div', { class: 'ttl' }, 'No agents yet'),
      el('div', {}, 'Click Create Agent to build your first voice agent.')
    ]));
    return;
  }
  State.agents.forEach((a) => grid.appendChild(agentCard(a)));
}

function agentCard(a) {
  const tts = a.tts || {};
  const voiceLine = normalizeModel(tts.model || 'bulbul:v3') + ' / ' + (tts.speaker || 'speaker') + (tts.language ? ' / ' + langLabel(tts.language) : '') + (tts.f0_up_key ? ' / pitch ' + (tts.f0_up_key > 0 ? '+' : '') + tts.f0_up_key : '');
  const did = a.telephony && a.telephony.did ? a.telephony.did : null;

  const previewBtn = el('button', { class: 'btn btn-ghost btn-sm' }, 'Preview voice');
  previewBtn.addEventListener('click', () => previewAgentVoice(a, previewBtn));

  // textContent everywhere = XSS safe for persona/name
  return el('div', { class: 'card card-glow agent-card' }, [
    el('div', { class: 'ac-top' }, [
      el('div', { class: 'ac-av' }, initials(a.name)),
      el('div', { style: 'min-width:0' }, [
        el('div', { class: 'ac-name' }, a.name),
        el('div', { class: 'ac-voice' }, voiceLine)
      ])
    ]),
    el('div', { class: 'ac-persona' }, a.persona || 'No persona set.'),
    ...((Array.isArray(a.variables) && a.variables.length) ? [el('div', { class: 'ac-meta' }, a.variables.map((v) => el('span', { class: 'tag' }, v)))] : []),
    el('div', { class: 'ac-meta' }, [
      did ? el('span', { class: 'tag' }, did) : el('span', { class: 'tag' }, 'no number'),
      el('span', { class: 'tag' }, normalizeModel(tts.model || 'bulbul:v3')),
      el('span', { class: 'tag' }, langLabel(tts.language))
    ]),
    el('div', { class: 'ac-actions' }, [
      previewBtn,
      el('button', { class: 'btn btn-ghost btn-sm', onclick: () => openEditAgent(a) }, 'Edit'),
      el('button', { class: 'btn btn-ghost btn-sm', onclick: () => confirmDeleteAgent(a) }, 'Delete')
    ])
  ]);
}

async function previewAgentVoice(a, btn) {
  const tts = a.tts || {};
  const text = (a.greeting && a.greeting.trim()) || ('Hi, this is ' + (a.name || 'your agent') + '. How can I help today.');
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = 'Synthesizing...';
  try {
    const body = { text, model: normalizeModel(tts.model), speaker: tts.speaker, f0_up_key: tts.f0_up_key, description: tts.description, language: tts.language };
    const res = await api('/api/tts', { method: 'POST', body: body });
    const buf = await res.arrayBuffer();
    const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    await audio.play();
    btn.textContent = 'Playing...';
    audio.onended = () => { btn.textContent = old; btn.disabled = false; URL.revokeObjectURL(url); };
  } catch (ex) {
    toast(ex.message || 'Voice preview failed.', 'err');
    btn.textContent = old; btn.disabled = false;
  }
}

function openEditAgent(a) {
  const form = buildAgentForm(a);
  const host = $('#modal-host');
  const close = () => { host.classList.add('hide'); host.setAttribute('aria-hidden', 'true'); host.innerHTML = ''; };
  form._setModalClose(() => { close(); paintAgents(); });
  const card = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', style: 'max-width:640px' }, [form]);
  host.innerHTML = '';
  host.appendChild(el('div', { onclick: (ev) => { if (ev.target === ev.currentTarget) close(); }, style: 'position:absolute;inset:0' }));
  host.appendChild(card);
  host.classList.remove('hide');
  host.setAttribute('aria-hidden', 'false');
  setTimeout(refillDidOptions, 0);
}

function confirmDeleteAgent(a) {
  modal({
    title: 'Delete agent',
    body: el('p', {}, ['Delete ', el('b', {}, a.name), '. This cannot be undone.']),
    confirmText: 'Delete agent', confirmKind: 'danger',
    onConfirm: async () => {
      await api('/api/agents/delete', { method: 'POST', body: { id: a.id } });
      State.agents = State.agents.filter((x) => x.id !== a.id);
      paintAgents();
      toast('Agent deleted.', 'ok');
    }
  });
}

/* helper used by builder */
function field(label, input) { return el('div', { class: 'field' }, [el('label', {}, label), input]); }

/* ===========================================================================
   3. VOICE STUDIO
   =========================================================================== */
function viewStudio(root) {
  root.appendChild(viewHead('Voice Studio', 'Type anything, pick a model, and synthesize. See the waveform, hear it back, and watch the cost in real time.'));

  const st = { model: 'bulbul:v3', tone: 'neutral', speaker: 'shubh', f0: 0, stream: false, language: 'en-IN' };

  const textArea = el('textarea', { class: 'textarea studio-text', id: 's_text', placeholder: 'Welcome to RapidX Voice. Production-grade AI voice starts from ₹1 per minute for the AI layer.' }, 'Welcome to RapidX Voice. Production-grade AI voice starts from ₹1 per minute for the AI layer.');

  // model picker
  const modelSeg = el('div', { class: 'seg' }, VOICE_MODELS.map((m) =>
    el('button', { type: 'button', class: m === st.model ? 'on' : '', 'data-m': m, onclick: () => { st.model = m; syncCtl(); updateCost(); } }, m)
  ));
  // bulbul:v2 tone presets
  const toneSeg = el('div', { class: 'seg', id: 's_tones' }, BULBUL_V2_TONES.map((tn) =>
    el('button', { type: 'button', class: tn === st.tone ? 'on' : '', 'data-t': tn, onclick: () => { st.tone = tn; $$('#s_tones button').forEach((b) => b.classList.toggle('on', b.getAttribute('data-t') === tn)); } }, tn)
  ));
  // voice selector (v3 voices, plus v2-only ones labeled)
  const speakerSel = el('select', { class: 'select' }, SPEAKERS.map((s) => el('option', { value: s, selected: s === st.speaker ? 'selected' : false }, voiceLabel(s))));
  speakerSel.addEventListener('change', () => {
    st.speaker = speakerSel.value;
    const m = modelForVoice(st.speaker);
    if (m !== st.model) { st.model = m; syncCtl(); updateCost(); }
  });
  const f0Val = el('span', { class: 'rv' }, '0');
  const f0Range = el('input', { type: 'range', min: -12, max: 12, step: 1, value: 0, oninput: (ev) => { st.f0 = +ev.target.value; f0Val.textContent = (st.f0 > 0 ? '+' : '') + st.f0; } });
  const descI = el('input', { class: 'input', placeholder: 'Optional voice direction, e.g. warm and reassuring' });
  descI.addEventListener('input', () => { st.desc = descI.value; });
  const langSel = el('select', { class: 'select', id: 's_lang' }, TTS_LANGUAGES.map((lc) => el('option', { value: lc, selected: lc === st.language ? 'selected' : false }, langLabel(lc))));
  langSel.addEventListener('change', () => { st.language = langSel.value; });

  const bulbulV2Ctl = field('Tone (bulbul:v2)', toneSeg);
  const bulbulV3Speaker = field('Voice', speakerSel);
  const bulbulV3Pitch = field('Pitch, f0_up_key', el('div', { class: 'range-row' }, [f0Range, f0Val]));
  const bulbulV3Desc = field('Voice direction (bulbul:v3)', descI);
  function syncCtl() {
    $$('.seg button[data-m]').forEach((b) => b.classList.toggle('on', b.getAttribute('data-m') === st.model));
    const isV3 = st.model === 'bulbul:v3';
    bulbulV2Ctl.style.display = isV3 ? 'none' : '';
    bulbulV3Speaker.style.display = '';
    [bulbulV3Pitch, bulbulV3Desc].forEach((f) => f.style.display = isV3 ? '' : 'none');
  }

  const charsEl = el('span', { class: 'c-chars', id: 's_chars' }, '0 chars');
  const costEl = el('span', { class: 'c-cost', id: 's_cost' }, [document.createTextNode('about '), el('b', {}, '₹0.00')]);
  function updateCost() {
    const len = (textArea.value || '').length;
    const capped = Math.min(len, 2000);
    const cost = capped / 1000 * (RATE[st.model] || RATE['bulbul:v3']);
    charsEl.textContent = len + ' chars' + (len > 2000 ? ' (capped at 2000)' : '');
    costEl.innerHTML = '';
    costEl.appendChild(document.createTextNode('about '));
    costEl.appendChild(el('b', {}, '₹' + cost.toFixed(2)));
  }
  textArea.addEventListener('input', updateCost);

  const streamToggle = el('label', { class: 'streamtoggle' }, [
    el('input', { type: 'checkbox', onchange: (ev) => { st.stream = ev.target.checked; } }),
    document.createTextNode('Stream progressively (low latency)')
  ]);

  const synthBtn = el('button', { class: 'btn btn-primary' }, 'Synthesize');
  const audioEl = el('audio', { controls: 'controls', preload: 'none' });
  const waveCanvas = el('canvas', { class: 'wave-canvas', id: 's_wave' });
  const playerRow = el('div', { class: 'player-row', style: 'display:none' }, [audioEl]);

  synthBtn.addEventListener('click', () => doSynthesize(st, textArea, synthBtn, audioEl, waveCanvas, playerRow));

  const main = el('div', { class: 'card studio-main' }, [
    field('Text to speak', textArea),
    el('div', { class: 'wave-wrap' }, [waveCanvas, playerRow]),
    el('div', { class: 'flex items-center gap-2', style: 'flex-wrap:wrap' }, [synthBtn, streamToggle])
  ]);

  const side = el('div', { class: 'studio-side' }, [
    el('div', { class: 'card card-pad' }, [
      el('h3', { class: 't-h3', style: 'margin-bottom:14px' }, 'Voice'),
      field('Model', modelSeg),
      field('Language', langSel),
      bulbulV2Ctl, bulbulV3Speaker, bulbulV3Pitch, bulbulV3Desc
    ]),
    el('div', { class: 'card card-pad' }, [
      el('h3', { class: 't-h3', style: 'margin-bottom:14px' }, 'Economics'),
      el('div', { class: 'cost-readout' }, [charsEl, costEl]),
      el('p', { class: 'muted', style: 'font-size:.8rem;margin-top:10px' }, 'Sarvam Bulbul promo is about Rs 0.50 per 1000 chars, roughly 20x cheaper than ElevenLabs.')
    ])
  ]);

  root.appendChild(el('div', { class: 'studio-grid' }, [main, side]));
  syncCtl(); updateCost();
  // size the canvas after layout
  setTimeout(() => sizeCanvas(waveCanvas), 30);
  window.addEventListener('resize', () => sizeCanvas(waveCanvas), { once: true });
}

async function doSynthesize(st, textArea, btn, audioEl, canvas, playerRow) {
  const raw = (textArea.value || '').trim();
  if (!raw) { toast('Type something to synthesize.', 'err'); textArea.focus(); return; }
  let text = raw.slice(0, 2000);
  // bulbul:v2 tone is applied as a [tone] prefix
  if (st.model === 'bulbul:v2' && st.tone && st.tone !== 'neutral') text = '[' + st.tone + '] ' + text;

  const old = btn.textContent; btn.disabled = true; btn.textContent = 'Synthesizing...';

  if (st.stream) {
    try {
      await streamSynthesize(text, st, canvas, btn);
      btn.disabled = false; btn.textContent = old;
      refreshUsageSoft();
      return;
    } catch (ex) {
      toast('Stream failed, falling back to file. ' + (ex.message || ''), 'info');
      // fall through to normal synth
    }
  }

  try {
    const body = { text: text, model: st.model };
    if (st.model === 'bulbul:v2' || st.model === 'bulbul:v3') {
      body.speaker = st.speaker;
      body.f0_up_key = st.f0;
      if (st.language) body.language = st.language;
      if (st.model === 'bulbul:v3' && st.desc) body.description = st.desc;
    }
    const res = await api('/api/tts', { method: 'POST', body: body });
    const chars = res.headers.get('X-Chars');
    const credits = res.headers.get('X-Credits-Used');
    const buf = await res.arrayBuffer();
    const blob = new Blob([buf], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    audioEl.src = url; playerRow.style.display = '';
    drawWaveformFromBuffer(buf.slice(0), canvas);
    audioEl.play().catch(() => {});
    toast('Synthesized ' + (chars || text.length) + ' chars' + (credits ? ', ' + credits + ' credits.' : '.'), 'ok');
    refreshUsageSoft();
  } catch (ex) {
    toast(ex.message || 'Synthesis failed.', 'err');
  } finally {
    btn.disabled = false; btn.textContent = old;
  }
}

function refreshUsageSoft() {
  // invalidate cached usage so Overview reflects new chars next visit
  State.loaded.usage = false; State.usage = null;
}

/* ---- waveform rendering ---- */
function sizeCanvas(canvas) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 560, h = canvas.clientHeight || 90;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // idle baseline
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(110,123,255,0.25)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
}
function drawWaveformFromBuffer(arrbuf, canvas) {
  try {
    const samples = decodeWavPcm(arrbuf);
    if (!samples) { sizeCanvas(canvas); return; }
    drawWaveform(samples, canvas);
  } catch (e) { sizeCanvas(canvas); }
}
function decodeWavPcm(arrbuf) {
  const dv = new DataView(arrbuf);
  if (dv.byteLength < 44) return null;
  // verify RIFF/WAVE
  if (dv.getUint32(0, false) !== 0x52494646) return null; // 'RIFF'
  // walk chunks to find fmt + data
  let off = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (off + 8 <= dv.byteLength) {
    const id = dv.getUint32(off, false);
    const sz = dv.getUint32(off + 4, true);
    if (id === 0x666d7420) { // 'fmt '
      fmt = { format: dv.getUint16(off + 8, true), channels: dv.getUint16(off + 10, true), bits: dv.getUint16(off + 22, true) };
    } else if (id === 0x64617461) { // 'data'
      dataOff = off + 8; dataLen = sz; break;
    }
    off += 8 + sz + (sz & 1);
  }
  if (!fmt || dataOff < 0 || fmt.bits !== 16) return null;
  const n = Math.floor(dataLen / 2);
  const ch = fmt.channels || 1;
  const out = new Float32Array(Math.floor(n / ch));
  let j = 0;
  for (let i = 0; i + ch <= n; i += ch) {
    const s = dv.getInt16(dataOff + i * 2, true);
    out[j++] = s / 32768;
  }
  return out;
}
function drawWaveform(samples, canvas) {
  sizeCanvas(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width / dpr, h = canvas.height / dpr;
  ctx.clearRect(0, 0, w, h);
  const bars = Math.max(40, Math.min(180, Math.floor(w / 4)));
  const block = Math.floor(samples.length / bars) || 1;
  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, '#34E7E4'); grad.addColorStop(0.6, '#6E7BFF'); grad.addColorStop(1, '#A855F7');
  ctx.fillStyle = grad;
  const bw = w / bars;
  for (let b = 0; b < bars; b++) {
    let peak = 0;
    for (let k = 0; k < block; k++) { const v = Math.abs(samples[b * block + k] || 0); if (v > peak) peak = v; }
    const bh = Math.max(2, peak * (h * 0.92));
    const x = b * bw, y = (h - bh) / 2;
    const r = Math.min(bw * 0.34, 2);
    roundRect(ctx, x + bw * 0.18, y, bw * 0.64, bh, r);
  }
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath(); ctx.fill();
}

/* ---- streaming TTS (PCM int16 LE 24kHz) via /api/ws-connect then wss Sarvam ---- */
async function streamSynthesize(text, st, canvas, btn) {
  const mint = await api('/api/ws-connect', { method: 'POST', body: { text: text, model: st.model } });
  if (!mint.ws_url) throw new ApiError(0, 'No ws_url returned.');
  return new Promise((resolve, reject) => {
    let ws, audioCtx, nextTime = 0, started = false, chunks = [];
    const SR = 24000;
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SR }); } catch (e) { return reject(new ApiError(0, 'No Web Audio.')); }
    const url = mint.ws_url + (mint.token && mint.ws_url.indexOf('token=') === -1 ? (mint.ws_url.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(mint.token) : '');
    try { ws = new WebSocket(url); } catch (e) { return reject(new ApiError(0, 'WebSocket failed.')); }
    ws.binaryType = 'arraybuffer';
    const fail = (m) => { try { ws.close(); } catch (e) {} reject(new ApiError(0, m)); };
    const timeout = setTimeout(() => fail('Stream timed out.'), 20000);
    ws.onopen = () => { try { ws.send(JSON.stringify({ text: text, model: st.model })); } catch (e) {} };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        try { const m = JSON.parse(ev.data); if (m.type === 'end' || m.done) { clearTimeout(timeout); finish(); } } catch (e) {}
        return;
      }
      const pcm = new Int16Array(ev.data);
      if (!pcm.length) return;
      chunks.push(pcm);
      const f32 = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i] / 32768;
      const ab = audioCtx.createBuffer(1, f32.length, SR);
      ab.copyToChannel(f32, 0);
      const src = audioCtx.createBufferSource(); src.buffer = ab; src.connect(audioCtx.destination);
      const now = audioCtx.currentTime;
      if (nextTime < now) nextTime = now + 0.04;
      src.start(nextTime); nextTime += ab.duration;
      started = true;
    };
    ws.onclose = () => { clearTimeout(timeout); if (started) finish(); else fail('Stream closed early.'); };
    ws.onerror = () => { clearTimeout(timeout); fail('Stream connection error.'); };
    function finish() {
      // draw the gathered waveform once
      if (chunks.length) {
        let total = 0; chunks.forEach((c) => total += c.length);
        const all = new Float32Array(total); let o = 0;
        chunks.forEach((c) => { for (let i = 0; i < c.length; i++) all[o++] = c[i] / 32768; });
        try { drawWaveform(all, canvas); } catch (e) {}
      }
      try { ws.close(); } catch (e) {}
      resolve();
    }
  });
}

/* ===========================================================================
   4. DEMO LINKS
   =========================================================================== */
async function viewDemoLinks(root) {
  root.appendChild(viewHead('Demo links', 'Create a tenant-branded web voice experience for one agent, then share it without exposing Studio access or provider secrets.'));
  const grid = el('div', { class: 'demo-admin-grid' }, [
    el('div', { class: 'card demo-create-card', id: 'demoCreateHost' }),
    el('div', { class: 'card demo-list-card', id: 'demoListHost' })
  ]);
  root.appendChild(grid);

  const createHost = $('#demoCreateHost', root);
  const listHost = $('#demoListHost', root);
  createHost.appendChild(skeleton('sk-card', 1));
  listHost.appendChild(skeleton('sk-card', 1));

  try {
    await ensureAgents();
    const payload = await api('/api/demo-links');
    State.demoLinks = payload.demoLinks || [];
    State.loaded.demoLinks = true;
  } catch (error) {
    createHost.innerHTML = '';
    listHost.innerHTML = '';
    listHost.appendChild(el('div', { class: 'demo-error', role: 'alert' }, error.message || 'Demo links could not be loaded.'));
    return;
  }

  function ephemeralUrl(id) {
    try { return sessionStorage.getItem('rxv_demo_' + id) || ''; } catch (_) { return ''; }
  }
  function rememberUrl(id, url) {
    try { sessionStorage.setItem('rxv_demo_' + id, url); } catch (_) {}
  }
  async function copyUrl(url) {
    if (!url) return;
    try { await navigator.clipboard.writeText(url); toast('Demo link copied.', 'ok'); }
    catch (_) {
      const input = el('textarea', { style: 'position:fixed;opacity:0;pointer-events:none' }, url);
      document.body.appendChild(input); input.select(); document.execCommand('copy'); input.remove();
      toast('Demo link copied.', 'ok');
    }
  }
  function openUrl(url) {
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  }
  function redraw() {
    root.innerHTML = '';
    viewDemoLinks(root);
  }

  createHost.innerHTML = '';
  createHost.appendChild(el('div', { class: 'demo-card-head' }, [
    el('div', {}, [el('h3', { class: 't-h3' }, 'Create a share link'), el('p', { class: 'muted' }, 'The full URL is shown once. Only its SHA-256 hash is stored on the server.')])
  ]));
  if (!State.agents.length) {
    createHost.appendChild(el('div', { class: 'empty' }, [
      el('div', { class: 'ttl' }, 'Create an agent first'),
      el('p', {}, 'A demo link must be scoped to one tenant-owned agent.'),
      el('button', { class: 'btn btn-primary', onclick: () => goto('agents') }, 'Open agents')
    ]));
  } else {
    const agent = el('select', { class: 'select', id: 'demoAgent' }, State.agents.map((item) => el('option', { value: item.id }, item.name)));
    const label = el('input', { class: 'input', id: 'demoLabel', maxlength: '80', placeholder: 'Prospect demo' });
    const expiry = el('select', { class: 'select', id: 'demoExpiry' }, [1, 3, 7, 14, 30].map((days) => el('option', { value: days, selected: days === 7 ? 'selected' : false }, days + (days === 1 ? ' day' : ' days'))));
    const duration = el('select', { class: 'select', id: 'demoDuration' }, [60, 180, 300, 600].map((seconds) => el('option', { value: seconds, selected: seconds === 300 ? 'selected' : false }, Math.round(seconds / 60) + (seconds === 60 ? ' minute' : ' minutes'))));
    const starts = el('input', { class: 'input', id: 'demoStarts', type: 'number', min: '1', max: '1000', value: '25', inputmode: 'numeric' });
    const submit = el('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, 'Create demo link');
    const form = el('form', { class: 'demo-create-form' }, [
      el('div', { class: 'field full' }, [el('label', {}, 'Agent'), agent]),
      el('div', { class: 'field full' }, [el('label', {}, 'Internal label'), label]),
      el('div', { class: 'field' }, [el('label', {}, 'Expires after'), expiry]),
      el('div', { class: 'field' }, [el('label', {}, 'Call duration'), duration]),
      el('div', { class: 'field full' }, [el('label', {}, 'Maximum starts'), starts]),
      submit
    ]);
    form.addEventListener('submit', async (event) => {
      event.preventDefault(); submit.disabled = true; submit.textContent = 'Creating...';
      try {
        const result = await api('/api/demo-links', { method: 'POST', body: {
          agentId: agent.value, label: label.value.trim(), expiresInDays: Number(expiry.value),
          maxSessionSeconds: Number(duration.value), maxStarts: Number(starts.value)
        } });
        const fullUrl = location.origin + result.sharePath;
        rememberUrl(result.demoLink.id, fullUrl);
        State.demoLinks.unshift(result.demoLink);
        await copyUrl(fullUrl);
        toast('Created and copied. Open it in a separate tab to test.', 'ok', 'Demo ready');
        redraw();
      } catch (error) {
        toast(error.message || 'Demo link could not be created.', 'err');
        submit.disabled = false; submit.textContent = 'Create demo link';
      }
    });
    createHost.appendChild(form);
  }

  listHost.innerHTML = '';
  listHost.appendChild(el('div', { class: 'demo-card-head' }, [
    el('div', {}, [el('h3', { class: 't-h3' }, 'Distributed demos'), el('p', { class: 'muted' }, 'Revoke access immediately or create a replacement when a one-time URL is no longer available.')]),
    el('span', { class: 'tag' }, State.demoLinks.length + ' total')
  ]));
  if (!State.demoLinks.length) {
    listHost.appendChild(el('div', { class: 'empty' }, [el('div', { class: 'ttl' }, 'No demo links yet'), el('p', {}, 'Create one to share a branded web voice experience.') ]));
  } else {
    const agentNames = Object.fromEntries(State.agents.map((item) => [item.id, item.name]));
    const list = el('div', { class: 'demo-link-list' });
    State.demoLinks.forEach((item) => {
      const url = ephemeralUrl(item.id);
      const status = item.status || 'active';
      const card = el('article', { class: 'demo-link-row' }, [
        el('div', { class: 'demo-link-main' }, [
          el('div', { class: 'demo-link-title' }, [el('strong', {}, item.label), el('span', { class: 'demo-status ' + status }, status)]),
          el('div', { class: 'demo-link-meta' }, [
            el('span', {}, agentNames[item.agentId] || 'Agent'),
            el('span', {}, item.starts + ' of ' + item.maxStarts + ' starts'),
            el('span', {}, 'Expires ' + new Date(item.expiresAt).toLocaleDateString())
          ]),
          !url && status === 'active' ? el('p', { class: 'demo-once-note' }, 'The secret URL is not recoverable after this browser session. Revoke and replace it if needed.') : null
        ]),
        el('div', { class: 'demo-link-actions' }, [
          el('button', { class: 'btn btn-ghost', disabled: !url ? 'disabled' : false, onclick: () => openUrl(url) }, 'Open'),
          el('button', { class: 'btn btn-ghost', disabled: !url ? 'disabled' : false, onclick: () => copyUrl(url) }, 'Copy'),
          status === 'active' ? el('button', { class: 'btn btn-danger-soft', onclick: () => modal({
            title: 'Revoke this demo link?',
            body: el('p', { class: 'muted' }, 'Visitors will no longer be able to start a voice session with this URL.'),
            confirmText: 'Revoke link', confirmKind: 'danger',
            onConfirm: async () => { await api('/api/demo-links/revoke', { method: 'POST', body: { id: item.id } }); try { sessionStorage.removeItem('rxv_demo_' + item.id); } catch (_) {} toast('Demo link revoked.', 'ok'); redraw(); }
          }) }, 'Revoke') : null
        ])
      ]);
      list.appendChild(card);
    });
    listHost.appendChild(list);
  }
}

/* ===========================================================================
   4.5 KNOWLEDGE BASE
   =========================================================================== */
async function viewKnowledge(root) {
  root.appendChild(viewHead('Knowledge base', 'Teach your agents with facts and documents. Facts are baked into the agent brain everywhere. Documents are uploaded to Dograh and retrieved at call time. Sync to push it all into the live workflow.'));

  await ensureAgents().catch(() => {});
  if (!State.agents.length) {
    root.appendChild(el('div', { class: 'empty' }, [
      el('div', { class: 'ttl' }, 'No agents yet'),
      el('div', {}, 'Create an agent first, then give it knowledge.')
    ]));
    return;
  }
  if (!State.activeAgentId && State.agents.length) State.activeAgentId = State.agents[0].id;
  const agent = State.agents.find((a) => a.id === State.activeAgentId) || State.agents[0];

  let status = null;
  try { status = await api('/api/knowledge/status?agentId=' + encodeURIComponent(agent.id)); } catch (e) {}

  const agentSel = el('select', { class: 'select' }, State.agents.map((a) =>
    el('option', { value: a.id, selected: a.id === agent.id ? 'selected' : false }, a.name)
  ));
  agentSel.addEventListener('change', (ev) => {
    State.activeAgentId = ev.target.value;
    const wrap = root.parentNode;
    if (wrap) { wrap.innerHTML = ''; viewKnowledge(wrap); }
  });

  const factsDraft = ((status && status.knowledge ? status.knowledge.facts : []) || []).map((f) => ({ id: f.id, title: f.title || '', content: f.content || '' }));

  const factsList = el('div', { class: 'kfacts' });
  function paintFacts() {
    factsList.innerHTML = '';
    if (!factsDraft.length) {
      factsList.appendChild(el('div', { class: 'empty muted', style: 'padding:14px' }, 'No facts yet. Add a titled fact below.'));
      return;
    }
    factsDraft.forEach((f, i) => {
      const titleI = el('input', { class: 'input', value: f.title, placeholder: 'Short title, e.g. Pricing', maxlength: 120, oninput: (ev) => { f.title = ev.target.value; } });
      const contentI = el('textarea', { class: 'textarea', rows: 3, value: f.content, placeholder: 'What the agent should know.', maxlength: 6000, oninput: (ev) => { f.content = ev.target.value; } });
      const row = el('div', { class: 'card' }, [
        el('div', { class: 'flex', style: 'justify-content:space-between;align-items:center;margin-bottom:10px' }, [
          el('b', {}, 'Fact ' + (i + 1)),
          el('button', { class: 'btn btn-ghost btn-sm', onclick: () => { factsDraft.splice(i, 1); paintFacts(); } }, 'Remove')
        ]),
        el('div', { class: 'form-grid' }, [
          field('Title', titleI),
          (function () { const f2 = field('Content', contentI); f2.classList.add('full'); return f2; })()
        ])
      ]);
      factsList.appendChild(row);
    });
  }
  paintFacts();

  const addFactBtn = el('button', { class: 'btn btn-ghost btn-sm', onclick: () => { factsDraft.push({ id: 'kf_' + Math.random().toString(36).slice(2, 10), title: '', content: '' }); paintFacts(); } }, '+ Add fact');
  const saveFactsBtn = el('button', { class: 'btn btn-primary' }, 'Save facts');
  saveFactsBtn.addEventListener('click', async () => {
    saveFactsBtn.disabled = true; saveFactsBtn.textContent = 'Saving...';
    try {
      const res = await api('/api/agents/update', { method: 'POST', body: { id: agent.id, knowledge: { facts: factsDraft } } });
      const idx = State.agents.findIndex((a) => a.id === agent.id);
      if (idx !== -1) State.agents[idx] = res.agent;
      status = Object.assign({}, status || {}, { knowledge: res.agent.knowledge });
      toast('Facts saved.', 'ok');
    } catch (ex) {
      toast(ex.message || 'Could not save facts.', 'err');
    } finally {
      saveFactsBtn.disabled = false; saveFactsBtn.textContent = 'Save facts';
    }
  });

  const docList = el('div', { class: 'kdocs' });
  let dograhDocs = [];
  function attachedDocs() { return (status && status.knowledge ? status.knowledge.documents : []) || []; }
  function paintDocs() {
    const attached = attachedDocs();
    docList.innerHTML = '';
    if (!attached.length) {
      docList.appendChild(el('div', { class: 'empty muted', style: 'padding:14px' }, 'No documents attached. Upload a file to teach the agent from its content.'));
      return;
    }
    attached.forEach((doc) => {
      docList.appendChild(el('div', { class: 'doc-row' }, [
        el('div', { style: 'min-width:0' }, [
          el('div', { class: 'doc-name' }, doc.filename || doc.uuid),
          el('div', { class: 'hint' }, 'Status: ' + (doc.status || 'unknown'))
        ]),
        el('button', { class: 'btn btn-ghost btn-sm', onclick: () => removeDocument(doc) }, 'Remove')
      ]));
    });
  }
  function removeDocument(doc) {
    modal({
      title: 'Remove document',
      body: el('p', {}, ['Remove ', el('b', {}, doc.filename || doc.uuid), ' from this agent', (status && status.dograhConfigured) ? ' and delete it from Dograh' : '', '?']),
      confirmText: 'Remove', confirmKind: 'danger',
      onConfirm: async () => {
        const res = await api('/api/knowledge/documents/delete', { method: 'POST', body: { agentId: agent.id, uuid: doc.uuid, purge: !!(status && status.dograhConfigured) } });
        const idx = State.agents.findIndex((a) => a.id === agent.id);
        if (idx !== -1) State.agents[idx] = res.agent;
        status = Object.assign({}, status || {}, { knowledge: res.agent.knowledge });
        paintDocs(); paintAttachSel();
        toast('Document removed.', 'ok');
      }
    });
  }

  const fileIn = el('input', { type: 'file', class: 'input', style: 'max-width:320px' });
  const uploadBtn = el('button', { class: 'btn' }, 'Upload');
  uploadBtn.addEventListener('click', async () => {
    const file = fileIn.files && fileIn.files[0];
    if (!file) { toast('Pick a file first.', 'err'); return; }
    if (!status || !status.dograhConfigured) {
      toast('Dograh is not configured, so document upload is unavailable. Add DOGRAH_BASE_URL and DOGRAH_API_KEY.', 'err');
      return;
    }
    uploadBtn.disabled = true; uploadBtn.textContent = 'Uploading...';
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Could not read the file.'));
        reader.readAsDataURL(file);
      });
      const comma = dataUrl.indexOf(',');
      const content = comma === -1 ? '' : dataUrl.slice(comma + 1);
      const res = await api('/api/knowledge/documents/upload', {
        method: 'POST', timeoutMs: 120000,
        body: { agentId: agent.id, filename: file.name, mimeType: file.type || 'application/octet-stream', content }
      });
      const idx = State.agents.findIndex((a) => a.id === agent.id);
      if (idx !== -1) State.agents[idx] = res.agent;
      status = Object.assign({}, status || {}, { knowledge: res.agent.knowledge });
      fileIn.value = '';
      paintDocs(); paintAttachSel();
      toast('Uploaded. Dograh is chunking it now.', 'ok');
    } catch (ex) {
      toast(ex.message || 'Upload failed.', 'err');
    } finally {
      uploadBtn.disabled = false; uploadBtn.textContent = 'Upload';
    }
  });

  const attachSel = el('select', { class: 'select', style: 'max-width:320px' });
  const attachBtn = el('button', { class: 'btn btn-ghost' }, 'Attach');
  function paintAttachSel() {
    attachSel.innerHTML = '';
    const attached = attachedDocs();
    const avail = dograhDocs.filter((d) => !attached.some((x) => x.uuid === d.uuid));
    attachSel.appendChild(el('option', { value: '' }, 'Pick a Dograh document'));
    avail.forEach((d) => attachSel.appendChild(el('option', { value: d.uuid + '|' + d.filename }, d.filename)));
  }
  attachBtn.addEventListener('click', async () => {
    const val = attachSel.value;
    if (!val) { toast('Pick a document first.', 'err'); return; }
    const parts = val.split('|');
    const uuid = parts[0];
    const filename = parts.slice(1).join('|');
    attachBtn.disabled = true;
    try {
      const res = await api('/api/knowledge/documents/attach', { method: 'POST', body: { agentId: agent.id, uuid, filename } });
      const idx = State.agents.findIndex((a) => a.id === agent.id);
      if (idx !== -1) State.agents[idx] = res.agent;
      status = Object.assign({}, status || {}, { knowledge: res.agent.knowledge });
      paintDocs(); paintAttachSel();
      toast('Document attached.', 'ok');
    } catch (ex) {
      toast(ex.message || 'Could not attach document.', 'err');
    } finally {
      attachBtn.disabled = false;
    }
  });

  async function refreshDocs() {
    dograhDocs = [];
    try { dograhDocs = (await api('/api/knowledge/documents')).documents || []; } catch (e) {}
    paintAttachSel();
  }

  const syncStatus = el('div', { class: 'hint' });
  const dograhOn = !!(status && status.dograhConfigured);
  const workflowOn = !!(status && status.workflowConfigured);
  if (!dograhOn) syncStatus.textContent = 'Dograh is not configured. Facts still work in web chat and previews, but the live voice workflow cannot be synced.';
  else if (!workflowOn) syncStatus.textContent = 'Dograh is configured but DOGRAH_WORKFLOW_ID is missing, so the live workflow cannot be synced.';
  else syncStatus.textContent = 'Sync writes the facts and document refs into the live workflow and publishes it.';

  const syncBtn = el('button', { class: 'btn btn-primary', disabled: !(dograhOn && workflowOn) }, 'Sync live workflow');
  syncBtn.addEventListener('click', async () => {
    syncBtn.disabled = true; syncBtn.textContent = 'Syncing...';
    try {
      const res = await api('/api/knowledge/sync', { method: 'POST', timeoutMs: 60000, body: { agentId: agent.id } });
      const idx = State.agents.findIndex((a) => a.id === agent.id);
      if (idx !== -1) State.agents[idx] = res.agent;
      status = Object.assign({}, status || {}, { knowledge: res.agent.knowledge });
      toast('Live workflow synced and published.', 'ok');
    } catch (ex) {
      toast(ex.message || 'Sync failed.', 'err');
    } finally {
      syncBtn.disabled = false; syncBtn.textContent = 'Sync live workflow';
    }
  });

  paintDocs();
  refreshDocs();

  root.appendChild(el('div', { class: 'card' }, [
    el('h3', {}, 'Agent'),
    field('Agent', agentSel)
  ]));

  root.appendChild(el('div', { class: 'card' }, [
    el('h3', {}, 'Facts'),
    el('p', { class: 'hint' }, 'Short, titled entries baked straight into the agent brain. They work in web chat, previews, and live calls. Up to 20 facts.'),
    factsList,
    el('div', { class: 'flex gap-2', style: 'margin-top:14px;align-items:center' }, [addFactBtn, saveFactsBtn])
  ]));

  root.appendChild(el('div', { class: 'card' }, [
    el('h3', {}, 'Documents'),
    el('p', { class: 'hint' }, 'Upload files to Dograh, and the live agent retrieves the relevant parts at call time. You can also attach files you already uploaded. Max 4 MB per file.'),
    docList,
    el('div', { class: 'flex gap-2', style: 'margin-top:14px;align-items:center;flex-wrap:wrap' }, [fileIn, uploadBtn, attachSel, attachBtn]),
    el('div', { style: 'margin-top:12px' }, [
      el('button', { class: 'btn btn-ghost btn-sm', onclick: () => refreshDocs() }, 'Refresh Dograh documents')
    ])
  ]));

  root.appendChild(el('div', { class: 'card' }, [
    el('h3', {}, 'Live workflow'),
    syncStatus,
    el('div', { style: 'margin-top:12px' }, [syncBtn])
  ]));
}

/* ===========================================================================
   5. TALK TO IT
   =========================================================================== */
async function viewTalk(root) {
  root.appendChild(viewHead('Talk to your agent', 'A direct realtime voice call through the same Dograh workflow runtime used on the phone.'));

  await ensureAgents().catch(() => {});
  if (!State.activeAgentId && State.agents.length) State.activeAgentId = State.agents[0].id;

  const orb = el('div', { class: 'voice-orb', role: 'button', tabindex: '0', 'aria-label': 'Start or end the live voice call' }, [el('span'), el('span'), el('span'), el('span'), el('span')]);
  const transcript = el('div', { class: 'voice-call-stage', id: 't_voice_call', 'aria-live': 'polite' }, [
    orb,
    el('div', { class: 'voice-call-stage-title' }, 'Ready for a live voice call'),
    el('div', { class: 'voice-call-stage-copy' }, 'Tap the orb or press Start voice call. Speak naturally, interrupt the agent, and continue without pressing send.')
  ]);
  const agentSel = el('select', { class: 'select' }, State.agents.length
    ? State.agents.map((a) => el('option', { value: a.id, selected: a.id === State.activeAgentId ? 'selected' : false }, a.name))
    : [el('option', { value: '' }, 'No agents yet')]);
  agentSel.addEventListener('change', () => { State.activeAgentId = agentSel.value; });

  const statusDot = el('span', { class: 'conversation-dot', 'aria-hidden': 'true' });
  const statusText = el('span', {}, 'Ready');
  const statusPill = el('div', { class: 'conversation-status idle', role: 'status' }, [statusDot, statusText]);
  const runtimePill = el('div', { class: 'conversation-pipeline' }, 'Dograh realtime voice · Deepgram · Groq · Sarvam');
  const timingText = el('div', { class: 'conversation-timing', 'aria-live': 'polite' }, 'Latency is measured inside the live call runtime');
  const sessionBtn = el('button', { class: 'btn btn-primary conversation-btn', 'aria-label': 'Start voice call' }, [
    el('span', { class: 'conversation-btn-icon', 'aria-hidden': 'true', html: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.9.33 1.78.62 2.63a2 2 0 0 1-.45 2.11L8 9.73a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.85.29 1.73.5 2.63.62A2 2 0 0 1 22 16.9z"/></svg>' }),
    el('span', { class: 'conversation-btn-label' }, 'Start voice call')
  ]);
  const audio = el('audio', { autoplay: 'autoplay', playsinline: 'playsinline' });

  let pc = null;
  let ws = null;
  let stream = null;
  let running = false;
  let peerId = '';
  let callStarted = 0;

  function setStatus(phase, label) {
    statusPill.className = 'conversation-status ' + phase;
    statusText.textContent = label;
  }
  function setButton(active) {
    running = active;
    $('.conversation-btn-label', sessionBtn).textContent = active ? 'End voice call' : 'Start voice call';
    sessionBtn.classList.toggle('active', active);
    sessionBtn.setAttribute('aria-label', active ? 'End voice call' : 'Start voice call');
    agentSel.disabled = active;
  }
  function appendBubble(role, text, live) {
    $('.voice-call-stage-title', transcript).textContent = String(text || 'Voice call status');
    return transcript;
  }
  function stopCall(message) {
    setButton(false);
    if (ws && ws.readyState < 2) { try { ws.close(); } catch (_) {} }
    ws = null;
    if (pc) { try { pc.getSenders().forEach((s) => s.track && s.track.stop()); pc.close(); } catch (_) {} }
    pc = null;
    if (stream) stream.getTracks().forEach((track) => track.stop());
    stream = null;
    audio.srcObject = null;
    setStatus('idle', message || 'Ready');
    timingText.textContent = callStarted ? 'Call ended after ' + Math.max(1, Math.round((Date.now() - callStarted) / 1000)) + 's' : 'Latency is measured inside the live call runtime';
    callStarted = 0;
  }
  function securePeerId() {
    const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
    return 'PC-' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  async function fetchTurn(url) {
    try {
      const response = await fetch(url, { credentials: 'include' });
      return response.ok ? await response.json() : null;
    } catch (_) { return null; }
  }
  async function handleSignal(message) {
    if (!pc) return;
    if (message.type === 'answer') {
      await pc.setRemoteDescription({ type: 'answer', sdp: message.payload.sdp });
      return;
    }
    if (message.type === 'ice-candidate') {
      const c = message.payload && message.payload.candidate;
      if (c) await pc.addIceCandidate(c).catch(() => {});
      return;
    }
    if (message.type === 'call-ended') return stopCall('Call ended');
    if (message.type === 'error' || message.type === 'rtf-pipeline-error') {
      const detail = (message.payload && (message.payload.message || message.payload.error)) || 'Realtime voice call failed';
      appendBubble('bot', detail, false);
      setStatus('error', 'Call error');
      return;
    }
    if (message.type === 'rtf-user-transcription') {
      const p = message.payload || {};
      if (p.text) setStatus('thinking', p.final ? 'Agent thinking' : 'Listening');
      return;
    }
    if (message.type === 'rtf-bot-text') {
      return;
    }
    if (message.type === 'rtf-bot-started-speaking') setStatus('speaking', 'Agent speaking');
    if (message.type === 'rtf-bot-stopped-speaking') setStatus('listening', 'Listening');
    if (message.type === 'rtf-ttfb-metric') {
      const p = message.payload || {};
      timingText.textContent = (Number(p.ttfb_seconds || 0) * 1000).toFixed(0) + 'ms first response · ' + String(p.processor || p.model || 'live runtime');
    }
  }
  async function startCall() {
    if (running || !State.activeAgentId) return;
    setButton(true); setStatus('connecting', 'Connecting realtime call');
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const session = await api('/api/voice/session', { method: 'POST', timeoutMs: 15000, body: { agentId: State.activeAgentId } });
      // Prefer the same-origin session response. A direct credentialed fetch to
      // Dograh can be rejected by browsers when its CORS response uses `*`.
      const turn = session.turnCredentials || await fetchTurn(session.turnCredentialsUrl);
      const iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }];
      if (turn && turn.uris && turn.uris.length) {
        iceServers.push({ urls: turn.uris, username: turn.username, credential: turn.password });
      }
      pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: turn ? 'relay' : 'all' });
      window.__sarvamPc = pc;
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      pc.ontrack = (event) => { if (event.track.kind === 'audio') { audio.srcObject = event.streams[0]; audio.play().catch(() => {}); } };
      pc.onconnectionstatechange = () => {
        if (!pc) return;
        console.log('Sarvam WebRTC state', pc.connectionState, pc.iceConnectionState);
        timingText.textContent = 'WebRTC ' + pc.connectionState + ' · ICE ' + pc.iceConnectionState;
        if (pc.connectionState === 'connected') { callStarted = Date.now(); setStatus('listening', 'Live call connected'); }
        if (pc.connectionState === 'failed') { setStatus('error', 'Connection failed'); stopCall('Connection failed'); }
      };
      peerId = securePeerId();
      ws = new WebSocket(session.signalingUrl);
      ws.onmessage = async (event) => {
        try { await handleSignal(JSON.parse(event.data)); }
        catch (error) { setStatus('error', 'Signaling error'); toast(error.message || 'Realtime signaling failed.', 'err'); }
      };
      ws.onclose = (event) => { if (running && event.reason !== 'call ended') stopCall('Call ended'); };
      await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('Dograh signaling connection failed')); });
      pc.onicecandidate = (event) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        console.log('Sarvam WebRTC candidate', event.candidate ? event.candidate.type : 'complete');
        if (event.candidate) timingText.textContent = 'ICE candidate: ' + event.candidate.type + ' · ' + event.candidate.protocol;
        ws.send(JSON.stringify({ type: 'ice-candidate', payload: { candidate: event.candidate ? { candidate: event.candidate.candidate, sdpMid: event.candidate.sdpMid, sdpMLineIndex: event.candidate.sdpMLineIndex } : null, pc_id: peerId } }));
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      ws.send(JSON.stringify({ type: 'offer', payload: { sdp: offer.sdp, type: 'offer', pc_id: peerId, workflow_id: session.workflowId, workflow_run_id: session.workflowRunId } }));
    } catch (error) {
      stopCall('Could not connect');
      setStatus('error', 'Needs attention');
      appendBubble('bot', error.message || 'Could not start the realtime voice call.', false);
      toast(error.message || 'Realtime voice call failed.', 'err');
    }
  }

  sessionBtn.addEventListener('click', () => running ? stopCall('Ready') : startCall());
  orb.addEventListener('click', () => running ? stopCall('Ready') : startCall());
  orb.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); running ? stopCall('Ready') : startCall(); }
  });

  const panel = el('div', { class: 'card talk-panel' }, [
    el('div', { class: 'talk-head' }, [
      el('div', { class: 'talk-identity' }, [el('div', { class: 'who' }, ['Phone-runtime conversation ', el('span', {}, '(automatic turn-taking)')]), statusPill, runtimePill, timingText]),
      el('div', { class: 'talk-agent-select' }, [el('span', {}, 'Agent'), agentSel])
    ]),
    transcript,
    el('div', { class: 'talk-input' }, [sessionBtn, audio])
  ]);
  const info = el('div', { class: 'talk-side' }, [el('div', { class: 'card card-pad' }, [
    el('h3', { class: 't-h3' }, 'The actual phone runtime'),
    el('p', { class: 'muted' }, 'Your microphone is connected to Dograh over WebRTC. Dograh runs the same published workflow, Deepgram, Groq and Sarvam pipeline used for phone calls.'),
    el('hr', { class: 'divider' }),
    el('p', { class: 'muted' }, 'Turn detection, interruption, agent speech and latency now happen inside the call engine. Transcript text is a live diagnostic view, not the mechanism driving the page.'),
    el('p', { class: 'muted' }, 'Use End voice call to release the microphone and close the peer connection.')
  ])]);
  root.appendChild(el('div', { class: 'talk-grid' }, [panel, info]));
}

async function viewTalkLegacy(root) {
  root.appendChild(viewHead('Talk to it', 'A live loop. Speak or type, the agent thinks with the brain, then answers in its own voice.'));

  await ensureAgents().catch(() => {});
  if (!State.activeAgentId && State.agents.length) State.activeAgentId = State.agents[0].id;

  const convo = []; // { role:'user'|'bot', text }
  const transcript = el('div', { class: 'transcript', id: 't_transcript', 'aria-live': 'polite' }, [
    el('div', { class: 'bubble sys' }, State.agents.length ? 'Start a conversation. The agent will greet you, listen automatically and keep the call going.' : 'Create an agent first, then come back to talk to it.')
  ]);

  const agentSel = el('select', { class: 'select' }, State.agents.length
    ? State.agents.map((a) => el('option', { value: a.id, selected: a.id === State.activeAgentId ? 'selected' : false }, a.name))
    : [el('option', { value: '' }, 'No agents yet')]);
  agentSel.addEventListener('change', () => { State.activeAgentId = agentSel.value; });

  const textIn = el('input', { class: 'input', placeholder: State.agents.length ? 'Type a message...' : 'Create an agent to begin', disabled: State.agents.length ? false : 'disabled' });
  const sendBtn = el('button', { class: 'btn btn-primary' }, 'Send');
  const sessionBtn = el('button', { class: 'btn btn-primary conversation-btn', 'aria-label': 'Start conversation' }, [
    el('span', { class: 'conversation-btn-icon', 'aria-hidden': 'true', html: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.9.33 1.78.62 2.63a2 2 0 0 1-.45 2.11L8 9.73a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.85.29 1.73.5 2.63.62A2 2 0 0 1 22 16.9z"/></svg>' }),
    el('span', { class: 'conversation-btn-label' }, 'Start conversation')
  ]);
  const statusDot = el('span', { class: 'conversation-dot', 'aria-hidden': 'true' });
  const statusText = el('span', {}, 'Ready');
  const statusPill = el('div', { class: 'conversation-status idle', role: 'status' }, [statusDot, statusText]);
  const pipelinePill = el('div', { class: 'conversation-pipeline' }, 'Deepgram Nova-3 → Groq Llama 3.3 70B → Sarvam Bulbul');
  const timingText = el('div', { class: 'conversation-timing', 'aria-live': 'polite' }, 'Latency appears after the first turn');

  function getActiveAgent() { return State.agents.find((a) => a.id === State.activeAgentId) || State.agents[0]; }

  function addBubble(role, text) {
    if ($('.bubble.sys', transcript)) { const s = $('.bubble.sys', transcript); if (convo.length === 0) s.remove(); }
    const b = el('div', { class: 'bubble ' + (role === 'user' ? 'user' : 'bot') }, text); // textContent = XSS safe
    transcript.appendChild(b);
    transcript.scrollTop = transcript.scrollHeight;
    return b;
  }
  function addTyping() {
    const b = el('div', { class: 'bubble bot', html: '<span class="typing"><i></i><i></i><i></i></span>' });
    transcript.appendChild(b); transcript.scrollTop = transcript.scrollHeight; return b;
  }

  let sessionActive = false;
  let phase = 'idle';
  let busy = false;
  let mediaStream = null;
  let audioCtx = null;
  let analyser = null;
  let mediaRec = null;
  let deepgramSocket = null;
  let vadTimer = null;
  let recChunks = [];
  let discardCapture = false;
  let currentAudio = null;
  let activeSpeechSources = [];
  let liveBubble = null;
  let turnId = 0;
  const turnTiming = { stt: null, llm: null, tts: null };

  const PHASE_LABELS = {
    idle: 'Ready', connecting: 'Connecting microphone', listening: 'Listening',
    transcribing: 'Transcribing', thinking: 'Thinking', speaking: 'Agent speaking', error: 'Needs attention'
  };

  function setPhase(next) {
    phase = next;
    statusPill.className = 'conversation-status ' + next;
    statusText.textContent = PHASE_LABELS[next] || next;
    transcript.setAttribute('data-phase', next);
  }

  function updateTiming() {
    const parts = [];
    if (turnTiming.stt != null) parts.push('STT ' + (turnTiming.stt / 1000).toFixed(2) + 's');
    if (turnTiming.llm != null) parts.push('Groq ' + (turnTiming.llm / 1000).toFixed(2) + 's');
    if (turnTiming.tts != null) parts.push('Sarvam ' + (turnTiming.tts / 1000).toFixed(2) + 's');
    timingText.textContent = parts.length ? parts.join('  ·  ') : 'Latency appears after the first turn';
  }

  function setSessionButton(active) {
    const label = $('.conversation-btn-label', sessionBtn);
    label.textContent = active ? 'End conversation' : 'Start conversation';
    sessionBtn.classList.toggle('active', active);
    sessionBtn.setAttribute('aria-label', active ? 'End conversation' : 'Start conversation');
  }

  function clearVad() {
    if (vadTimer) clearInterval(vadTimer);
    vadTimer = null;
  }

  function paintLiveTranscript(text) {
    text = String(text || '').trim();
    if (!text) return;
    if (!liveBubble || !liveBubble.isConnected) {
      liveBubble = el('div', { class: 'bubble user live-transcript' }, text);
      transcript.appendChild(liveBubble);
    } else {
      liveBubble.textContent = text;
    }
    transcript.scrollTop = transcript.scrollHeight;
  }

  function clearLiveTranscript() {
    if (liveBubble && liveBubble.isConnected) liveBubble.remove();
    liveBubble = null;
  }

  async function openDeepgramStream() {
    const wsScheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(wsScheme + '//' + location.host + '/api/stt/stream');
    deepgramSocket = socket;
    const segments = [];
    let interim = '';
    let finalizeStarted = 0;
    let settled = false;
    let resolveFinal;
    let rejectFinal;
    let finalizeTimer = null;
    const finalText = new Promise((resolve, reject) => { resolveFinal = resolve; rejectFinal = reject; });
    const settle = (text) => {
      if (settled) return;
      settled = true;
      if (finalizeTimer) clearTimeout(finalizeTimer);
      if (finalizeStarted) turnTiming.stt = Date.now() - finalizeStarted;
      updateTiming();
      resolveFinal(String(text || '').trim());
    };

    let resolveReady;
    let rejectReady;
    let readyResolved = false;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });

    socket.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'ProxyReady') { readyResolved = true; resolveReady(); return; }
      if (msg.type === 'ProxyError') {
        const err = new Error(msg.message || 'Deepgram live stream failed.');
        rejectReady(err);
        if (readyResolved && !settled) rejectFinal(err);
        return;
      }
      if (msg.type !== 'Results') return;
      const alt = ((((msg.channel || {}).alternatives) || [])[0]) || {};
      const text = String(alt.transcript || '').trim();
      if (text) {
        if (msg.is_final) {
          if (segments[segments.length - 1] !== text) segments.push(text);
          interim = '';
        } else {
          interim = text;
        }
        paintLiveTranscript(segments.concat(interim ? [interim] : []).join(' '));
      }
      if (msg.from_finalize) settle(segments.concat(interim ? [interim] : []).join(' '));
    };
    socket.onerror = () => {
      const err = new Error('Deepgram live stream failed.');
      if (!readyResolved) rejectReady(err);
      else if (!settled) rejectFinal(err);
    };
    socket.onclose = () => {
      if (!readyResolved) rejectReady(new Error('Deepgram connection closed early.'));
      else if (!settled) settle(segments.concat(interim ? [interim] : []).join(' '));
    };

    const readyTimeout = setTimeout(() => rejectReady(new Error('Deepgram connection timed out.')), 8000);
    socket.addEventListener('error', () => rejectReady(new Error('Deepgram connection failed.')), { once: true });
    try {
      await ready.finally(() => clearTimeout(readyTimeout));
    } catch (e) {
      try { socket.close(); } catch (_) {}
      throw e;
    }

    return {
      socket,
      finalText,
      finalize() {
        if (socket.readyState !== WebSocket.OPEN) return settle(segments.join(' '));
        finalizeStarted = Date.now();
        socket.send(JSON.stringify({ type: 'Finalize' }));
        finalizeTimer = setTimeout(() => settle(segments.concat(interim ? [interim] : []).join(' ')), 2500);
      },
      close() {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'CloseStream' }));
        try { socket.close(); } catch (e) {}
      }
    };
  }

  function cancelCapture() {
    clearVad();
    if (mediaRec && mediaRec.state === 'recording') {
      discardCapture = true;
      try { mediaRec.stop(); } catch (e) {}
    }
    if (deepgramSocket) { try { deepgramSocket.close(); } catch (e) {} deepgramSocket = null; }
    clearLiveTranscript();
  }

  async function runTurn(userText) {
    userText = (userText || '').trim();
    if (!userText || busy) return;
    const agent = getActiveAgent();
    if (!agent) { toast('Pick an agent first.', 'err'); return; }
    cancelCapture();
    const myTurn = ++turnId;
    busy = true;
    addBubble('user', userText);
    convo.push({ role: 'user', text: userText });
    textIn.value = '';
    const typing = addTyping();
    setPhase('thinking');
    try {
      const chat = await api('/api/chat', {
        method: 'POST', timeoutMs: 30000,
        body: { messages: convo.map((m) => ({ role: m.role === 'bot' ? 'model' : 'user', text: m.text })), agentId: agent.id }
      });
      turnTiming.llm = Number(chat.latency_ms) || null;
      updateTiming();
      if (myTurn !== turnId) { typing.remove(); return; }
      const reply = (chat.text || '').trim() || 'Sorry, I did not catch that.';
      typing.remove();
      addBubble('bot', reply);
      convo.push({ role: 'bot', text: reply });
      setPhase('speaking');
      await speakReply(reply, agent);
    } catch (ex) {
      typing.remove();
      addBubble('sys', 'The turn failed: ' + (ex.message || 'unknown error'));
      setPhase('error');
      toast(ex.message || 'Chat failed.', 'err');
    } finally {
      busy = false;
      if (sessionActive) listenForTurn();
      else if (phase !== 'error') setPhase('idle');
    }
  }

  async function speakReply(text, agent) {
    const tts = agent.tts || {};
    const ttsStarted = performance.now();
    try {
      const mint = await api('/api/ws-connect', {
        method: 'POST', timeoutMs: 12000,
        body: { text: text.slice(0, 2000), model: normalizeModel(tts.model || 'bulbul:v3') }
      });
      if (!mint.ws_url) throw new Error('Sarvam stream URL was not returned.');
      const url = mint.ws_url + (mint.token && mint.ws_url.indexOf('token=') === -1
        ? (mint.ws_url.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(mint.token)
        : '');
      const playbackContext = audioCtx || new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
      if (playbackContext.state === 'suspended') await playbackContext.resume();
      await new Promise((resolve, reject) => {
        const socket = new WebSocket(url);
        socket.binaryType = 'arraybuffer';
        let nextTime = 0;
        let receivedAudio = false;
        let finished = false;
        const timeout = setTimeout(() => finish(new Error('Sarvam stream timed out.')), 20000);

        function finish(error) {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          try { socket.close(); } catch (_) {}
          if (error) return reject(error);
          const remainingMs = Math.max(0, (nextTime - playbackContext.currentTime) * 1000);
          setTimeout(resolve, remainingMs + 30);
        }

        socket.onopen = () => {
          const frame = { text: text.slice(0, 2000), model: normalizeModel(tts.model || 'bulbul:v3') };
          if (frame.model === 'bulbul:v2' || frame.model === 'bulbul:v3') {
            if (tts.description) frame.description = tts.description;
            else frame.speaker = tts.speaker || 'shubh';
            frame.f0_up_key = Number.isFinite(tts.f0_up_key) ? tts.f0_up_key : 0;
          }
          socket.send(JSON.stringify(frame));
        };
        socket.onmessage = (event) => {
          if (typeof event.data === 'string') {
            try {
              const message = JSON.parse(event.data);
              if (message.type === 'end' || message.type === 'done' || message.done) finish(receivedAudio ? null : new Error('Sarvam returned no audio.'));
            } catch (_) {}
            return;
          }
          const pcm = new Int16Array(event.data);
          if (!pcm.length) return;
          if (!receivedAudio) {
            receivedAudio = true;
            turnTiming.tts = Math.round(performance.now() - ttsStarted);
            updateTiming();
          }
          const samples = new Float32Array(pcm.length);
          for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768;
          const buffer = playbackContext.createBuffer(1, samples.length, 24000);
          buffer.copyToChannel(samples, 0);
          const source = playbackContext.createBufferSource();
          source.buffer = buffer;
          source.connect(playbackContext.destination);
          source.onended = () => { activeSpeechSources = activeSpeechSources.filter((item) => item !== source); };
          activeSpeechSources.push(source);
          if (nextTime < playbackContext.currentTime) nextTime = playbackContext.currentTime + 0.025;
          source.start(nextTime);
          nextTime += buffer.duration;
        };
        socket.onerror = () => finish(new Error('Sarvam stream connection failed.'));
        socket.onclose = () => { if (!finished) finish(receivedAudio ? null : new Error('Sarvam stream closed early.')); };
      });
    } catch (streamError) {
      // Keep a reliable batch fallback, but the normal path above starts audio
      // on Sarvam's first PCM chunk and is the path reflected in the latency UI.
      try {
        const res = await api('/api/tts', { method: 'POST', timeoutMs: 60000, body: { text: text.slice(0, 2000), model: normalizeModel(tts.model || 'bulbul:v3'), speaker: tts.speaker, f0_up_key: tts.f0_up_key, description: tts.description } });
        const buf = await res.arrayBuffer();
        turnTiming.tts = Math.round(performance.now() - ttsStarted);
        updateTiming();
        const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
        const audio = new Audio(url);
        currentAudio = audio;
        await new Promise((resolve) => {
          const done = () => { URL.revokeObjectURL(url); if (currentAudio === audio) currentAudio = null; resolve(); };
          audio.onended = done;
          audio.onerror = done;
          audio.play().catch(done);
        });
      } catch (_) {
        toast('Voice playback failed, the transcript is still available.', 'err');
      }
    }
  }

  sendBtn.addEventListener('click', () => runTurn(textIn.value));
  textIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') runTurn(textIn.value); });

  async function listenForTurn() {
    if (!sessionActive || busy || !mediaStream || !analyser) return;
    clearVad();
    discardCapture = false;
    recChunks = [];

    setPhase('connecting');
    let dg;
    try {
      dg = await openDeepgramStream();
    } catch (ex) {
      setPhase('error');
      addBubble('sys', 'Deepgram could not open a live transcription stream. Retrying.');
      toast(ex.message || 'Deepgram connection failed.', 'err');
      if (sessionActive) setTimeout(listenForTurn, 900);
      return;
    }

    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
    mediaRec = new MediaRecorder(mediaStream, mime ? { mimeType: mime } : undefined);
    const samples = new Uint8Array(analyser.fftSize);
    const captureStartedAt = Date.now();
    const audioSends = [];
    let speechStarted = false;
    let speechStartedAt = 0;
    let lastVoiceAt = 0;

    mediaRec.ondataavailable = (e) => {
      if (!e.data.size) return;
      recChunks.push(e.data);
      if (dg.socket.readyState === WebSocket.OPEN) {
        const sent = e.data.arrayBuffer().then((buf) => {
          if (dg.socket.readyState === WebSocket.OPEN) dg.socket.send(buf);
        }).catch(() => {});
        audioSends.push(sent);
      }
    };
    mediaRec.onstop = async () => {
      clearVad();
      const chunks = recChunks.slice();
      if (discardCapture) { discardCapture = false; dg.close(); return; }
      if (!sessionActive) return;
      if (!speechStarted || !chunks.length) {
        dg.close();
        setTimeout(listenForTurn, 180);
        return;
      }

      const blob = new Blob(chunks, { type: mediaRec.mimeType || 'audio/webm' });
      if (blob.size < 900) { dg.close(); setTimeout(listenForTurn, 180); return; }
      setPhase('transcribing');
      try {
        await Promise.all(audioSends);
        dg.finalize();
        let words = await dg.finalText;
        dg.close();
        if (!words) {
          const b64 = await blobToBase64(blob);
          const fallback = await api('/api/stt', { method: 'POST', timeoutMs: 45000, body: { audio: b64, mime: blob.type } });
          words = String(fallback.text || '').trim();
          turnTiming.stt = Number(fallback.latency_ms) || turnTiming.stt;
        }
        turnTiming.llm = null;
        turnTiming.tts = null;
        updateTiming();
        clearLiveTranscript();
        if (words) await runTurn(String(words).trim());
        else if (sessionActive) listenForTurn();
      } catch (ex) {
        dg.close();
        clearLiveTranscript();
        addBubble('sys', 'I could not transcribe that turn. I am listening again.');
        toast(ex.message || 'Transcription failed.', 'err');
        if (sessionActive) listenForTurn();
      }
    };

    mediaRec.start(250);
    setPhase('listening');
    vadTimer = setInterval(() => {
      if (!sessionActive || !mediaRec || mediaRec.state !== 'recording') return;
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i++) {
        const v = (samples[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / samples.length);
      const now = Date.now();
      if (rms >= 0.022) {
        if (!speechStarted) { speechStarted = true; speechStartedAt = now; }
        lastVoiceAt = now;
      }
      const endedTurn = speechStarted && now - speechStartedAt > 280 && now - lastVoiceAt > 900;
      const maxTurn = now - captureStartedAt > 30000;
      if (endedTurn || maxTurn) {
        try { mediaRec.stop(); } catch (e) {}
      }
    }, 60);
  }

  async function startConversation() {
    if (sessionActive) return;
    if (!window.isSecureContext) {
      toast('A live conversation needs the secure HTTPS Studio URL.', 'err');
      return;
    }
    const agent = getActiveAgent();
    if (!agent) { toast('Create or select an agent first.', 'err'); return; }
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      toast('This browser cannot open an audio call. Use a current Chrome, Brave, Edge or Safari build.', 'err');
      return;
    }

    setPhase('connecting');
    sessionBtn.disabled = true;
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      audioCtx.createMediaStreamSource(mediaStream).connect(analyser);
      sessionActive = true;
      agentSel.disabled = true;
      setSessionButton(true);
      const greeting = String(agent.greeting || 'Hello, how can I help you today?').trim();
      addBubble('bot', greeting);
      convo.push({ role: 'bot', text: greeting });
      setPhase('speaking');
      await speakReply(greeting, agent);
      if (sessionActive) listenForTurn();
    } catch (e) {
      toast('Microphone access failed. Allow the mic for this site, then start again.', 'err');
      endConversation(false);
      setPhase('error');
    } finally {
      sessionBtn.disabled = false;
    }
  }

  function endConversation(showMessage) {
    const wasActive = sessionActive;
    sessionActive = false;
    turnId += 1;
    cancelCapture();
    if (currentAudio) { try { currentAudio.pause(); } catch (e) {} currentAudio = null; }
    activeSpeechSources.forEach((source) => { try { source.stop(); } catch (_) {} });
    activeSpeechSources = [];
    if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
    analyser = null;
    if (audioCtx) { try { audioCtx.close(); } catch (e) {} }
    audioCtx = null;
    agentSel.disabled = false;
    setSessionButton(false);
    setPhase('idle');
    if (wasActive && showMessage !== false) addBubble('sys', 'Conversation ended.');
  }

  sessionBtn.addEventListener('click', () => {
    if (sessionActive) endConversation(true);
    else startConversation();
  });

  const panel = el('div', { class: 'card talk-panel' }, [
    el('div', { class: 'talk-head' }, [
      el('div', { class: 'talk-identity' }, [
        el('div', { class: 'who' }, [document.createTextNode('Live conversation '), el('span', {}, '(automatic turn-taking)')]),
        statusPill,
        pipelinePill,
        timingText
      ]),
      el('div', { class: 'talk-agent-select' }, [el('span', {}, 'Agent'), agentSel])
    ]),
    transcript,
    el('div', { class: 'talk-input' }, [sessionBtn, textIn, sendBtn])
  ]);

  const side = el('div', { class: 'talk-side' }, [
    el('div', { class: 'card card-pad' }, [
      el('h3', { class: 't-h3' }, 'How it works'),
      el('p', { class: 'soft', style: 'font-size:.88rem' }, 'Start once. Sarvam greets you, then Deepgram streams every word into the transcript while you speak. Groq answers, Sarvam speaks, and listening resumes automatically.'),
      el('div', { class: 'divider', style: 'margin:6px 0' }),
      el('div', { class: 'soft', style: 'font-size:.84rem' },
        'The status and measured Deepgram, Groq and Sarvam latency make every stage of the turn explicit.'),
      el('div', { class: 'soft', style: 'font-size:.84rem;margin-top:10px' }, 'Use End conversation to release the microphone. Typed messages remain available at any time.')
    ])
  ]);

  root.appendChild(el('div', { class: 'talk-grid' }, [panel, side]));
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result); resolve(s.slice(s.indexOf(',') + 1)); };
    r.onerror = reject; r.readAsDataURL(blob);
  });
}

/* ===========================================================================
   5. TELEPHONY
   =========================================================================== */
async function viewTelephony(root) {
  root.appendChild(viewHead('Telephony', 'Your VoBiz numbers and call routing, connected through Dograh. Outbound calls require an explicit confirmation.'));

  const statusHost = el('div', { class: 'card card-pad', id: 'telStatus' }, skeleton('sk-line', 5));
  const dialHost = el('div', { class: 'card card-pad' }, dialForm());
  root.appendChild(el('div', { class: 'tel-grid' }, [statusHost, dialHost]));

  try {
    const s = await ensureTelephony(true);
    paintTelephony(statusHost, s);
    refreshDialNumbers(s);
  } catch (e) {
    statusHost.innerHTML = '';
    statusHost.appendChild(el('div', { class: 'muted' }, 'Could not reach VoBiz through Dograh. ' + esc(e.message)));
  }
}

function paintTelephony(host, s) {
  host.innerHTML = '';
  const connected = s.connected === true && s.provider === 'vobiz' && s.orchestrator === 'dograh';
  const config = s.configuration || {};
  const didList = Array.isArray(s.dids) ? s.dids : (s.did ? [{ number: s.did, status: 'active' }] : []);

  host.appendChild(el('div', { class: 'flex items-center justify-between', style: 'margin-bottom:14px' }, [
    el('h3', { class: 't-h3' }, 'VoBiz via Dograh'),
    el('span', { class: 'pill' }, [
      el('span', { class: 'dot' + (connected ? '' : ' bad') }),
      connected ? 'connected' : 'unavailable'
    ])
  ]));

  if (didList.length) {
    host.appendChild(el('div', { class: 'muted', style: 'font-size:.8rem;margin-bottom:8px' }, 'VoBiz numbers'));
    didList.forEach((d) => {
      const num = typeof d === 'string' ? d : (d.did_number || d.number || d.did || '');
      const status = d.user_status_label || d.status || 'active';
      const exp = d.expiry_date || d.expiry || d.expires || d.expiresAt;
      const route = d.inboundWorkflowName || (d.inboundWorkflowId ? 'Workflow ' + d.inboundWorkflowId : 'No inbound workflow');
      host.appendChild(el('div', { class: 'did-row' }, [
        el('div', {}, [
          el('div', { class: 'num' }, num),
          el('div', { class: 'exp' }, exp ? 'Expires ' + exp : route)
        ]),
        el('span', { class: 'pill' }, [el('span', { class: 'dot' + (status !== 'active' ? ' warn' : '') }), status])
      ]));
    });
  }

  host.appendChild(el('div', { class: 'divider', style: 'margin:14px 0' }));
  host.appendChild(el('div', { class: 'status-line' }, [
    el('span', { class: 'k' }, 'Configuration'),
    el('span', { class: 'v' }, config.name || ('VoBiz config ' + (config.id || '')))
  ]));
  host.appendChild(el('div', { class: 'status-line' }, [
    el('span', { class: 'k' }, 'Outbound workflow'),
    el('span', { class: 'v' }, s.workflowId ? 'Workflow ' + s.workflowId : 'not configured')
  ]));
  if (s.dashboard) host.appendChild(el('div', { class: 'status-line' }, [
    el('span', { class: 'k' }, 'Dograh'),
    el('a', { class: 'v', href: s.dashboard, target: '_blank', rel: 'noopener', style: 'color:var(--accent)' }, 'Open console')
  ]));

  host.appendChild(el('div', { class: 'inbound-note' }, 'Outbound calls are initiated by Dograh using the active VoBiz configuration. Inbound calls follow the workflow assigned to each VoBiz number.'));
}

function dialForm() {
  const numI = el('input', { class: 'input', id: 'dial_num', type: 'tel', inputmode: 'numeric', maxlength: 10, placeholder: '9876543210' });
  numI.addEventListener('input', () => { numI.value = numI.value.replace(/\D/g, '').slice(0, 10); });
  const btn = el('button', { class: 'btn btn-primary' }, 'Place call');
  const form = el('form', { class: 'dial-form', onsubmit: (e) => { e.preventDefault(); onDial(numI, btn); } }, [
    el('h3', { class: 't-h3' }, 'Outbound call'),
    el('p', { class: 'muted', style: 'font-size:.85rem' }, 'Enter a 10 digit Indian mobile number. Dograh dials it through your VoBiz number.'),
    el('div', { class: 'field' }, [
      el('label', {}, 'Number'),
      el('div', { class: 'dial-input-row' }, [el('span', { class: 'prefix' }, '+91'), numI])
    ]),
    el('div', { class: 'cost-warn' }, ['This places a ', el('b', {}, 'real paid VoBiz call'), ' and charges your telephony account.']),
    btn
  ]);
  return form;
}
function refreshDialNumbers() { /* placeholder for future caller-id selection */ }

function onDial(numI, btn) {
  const num = (numI.value || '').replace(/\D/g, '');
  if (num.length !== 10) { toast('Enter a valid 10 digit mobile number.', 'err'); numI.focus(); return; }
  modal({
    title: 'Confirm a real call',
    body: el('div', {}, [
      el('p', {}, ['You are about to place a real outbound call to ', el('b', {}, '+91 ' + num), '.']),
      el('div', { class: 'danger-note' }, [
        el('b', {}, 'This is a live, paid call. '),
        document.createTextNode('Dograh will initiate it through your VoBiz configuration and charge your telephony account. Only continue if you intend to ring this number now.')
      ])
    ]),
    confirmText: 'Yes, place the call', confirmKind: 'danger',
    onConfirm: async () => {
      btn.disabled = true; btn.textContent = 'Dialing...';
      try {
        const res = await api('/api/telephony/dial', { method: 'POST', body: { number: num, confirm: true } });
        toast('Call placed to +91 ' + num + '.', 'ok');
        State.loaded.telephony = false; // refresh wallet next view
      } catch (ex) {
        if (ex.status === 400 && ex.data && ex.data.code === 'needs_confirm') toast('Confirmation required. Please retry.', 'err');
        else toast(ex.message || 'Dial failed.', 'err');
        throw ex;
      } finally {
        btn.disabled = false; btn.textContent = 'Place call';
      }
    }
  });
}

/* ===========================================================================
   6. PRESETS, BILLING, SUPPORT, AND SUPER ADMIN
   =========================================================================== */
async function viewPresets(root) {
  root.appendChild(viewHead('Agent presets', 'Start with a production-minded intake flow, then customize the voice, instructions, calendar, and your own number.'));
  const notice = el('div', { class: 'inbound-note', style: 'margin:0 0 18px' }, 'Presets are starting points. Personal Injury does not provide legal advice, and Dental does not diagnose. Review the workflow and consent language before using it live.');
  const host = el('div', { class: 'preset-grid' }, skeleton('sk-card', 6));
  root.appendChild(notice); root.appendChild(host);
  try {
    const out = await api('/api/presets');
    State.presets = out.presets || [];
    host.innerHTML = '';
    State.presets.forEach((p) => {
      const privacy = p.recommendedPrivacyMode || p.privacyMode || 'standard';
      host.appendChild(el('article', { class: 'card preset-card' }, [
        el('div', { class: 'preset-icon' }, (p.name || '?').slice(0, 1)),
        el('div', { class: 'flex items-center justify-between gap-2' }, [
          el('h3', { class: 't-h3' }, p.name),
          el('span', { class: 'badge-ready' }, privacy.replace(/_/g, ' '))
        ]),
        el('p', { class: 'muted' }, p.description || 'Editable voice-agent starting point.'),
        el('div', { class: 'preset-meta' }, [
          el('span', {}, p.category || 'Voice agent'),
          el('span', {}, 'BYON ready')
        ]),
        el('button', { class: 'btn btn-primary', onclick: () => createFromPreset(p) }, 'Use this preset')
      ]));
    });
    if (!State.presets.length) host.appendChild(el('div', { class: 'empty muted' }, 'No presets are available.'));
  } catch (e) { host.innerHTML = ''; host.appendChild(el('div', { class: 'card card-pad muted' }, e.message)); }
}

function createFromPreset(preset) {
  modal({
    title: 'Create ' + preset.name,
    body: el('div', {}, [
      el('p', {}, 'This creates an editable agent in your workspace. No phone number is attached until you connect your own number.'),
      field('Agent name', el('input', { class: 'input', id: 'preset_agent_name', value: preset.name }))
    ]),
    confirmText: 'Create agent',
    onConfirm: async () => {
      const name = ($('#preset_agent_name').value || preset.name).trim();
      await api('/api/agents', { method: 'POST', body: { presetId: preset.id, name: name } });
      State.loaded.agents = false;
      toast(name + ' created.', 'ok');
      goto('agents');
    }
  });
}

async function viewBilling(root) {
  root.appendChild(viewHead('Billing', 'Prepaid INR wallet, immutable transaction history, and secure PayU checkout.'));
  const host = el('div', { class: 'grid grid-12' }, [
    el('section', { class: 'card card-pad', id: 'walletSummary' }, skeleton('sk-card', 1)),
    el('section', { class: 'card card-pad', id: 'walletLedger' }, skeleton('sk-card', 1))
  ]);
  root.appendChild(host);
  try {
    const out = await api('/api/wallet');
    const wallet = out.wallet || {}; const rows = out.ledger || [];
    const sum = $('#walletSummary'); sum.innerHTML = '';
    sum.appendChild(el('div', { class: 'muted' }, 'Available credit'));
    sum.appendChild(el('div', { class: 'wallet-big' }, ['₹' + fmtInr(wallet.balanceInr != null ? wallet.balanceInr : (wallet.balancePaise || 0) / 100), el('small', {}, ' INR') ]));
    sum.appendChild(el('p', { class: 'muted' }, 'New accounts receive a one-time ₹10 trial credit. Voice and carrier usage are deducted separately according to the live rate card.'));
    const packs = [{ id: 'starter', inr: 200 }, { id: 'growth', inr: 500 }, { id: 'scale', inr: 1000 }];
    sum.appendChild(el('div', { class: 'pack-row' }, packs.map((pack) => el('button', { class: 'btn btn-ghost', onclick: () => startRecharge(pack.id) }, 'Add ₹' + fmtInr(pack.inr)))));
    const ledger = $('#walletLedger'); ledger.innerHTML = '';
    ledger.appendChild(el('h3', { class: 't-h3', style: 'margin-bottom:14px' }, 'Transaction history'));
    rows.slice(0, 20).forEach((x) => ledger.appendChild(el('div', { class: 'ledger-row' }, [
      el('div', {}, [el('div', {}, x.description || String(x.type || '').replace(/_/g, ' ')), el('small', { class: 'muted' }, x.createdAt || '')]),
      el('b', { class: Number(x.amountPaise) >= 0 ? 'money-plus' : 'money-minus' }, (Number(x.amountPaise) >= 0 ? '+' : '') + '₹' + fmtInr(Number(x.amountPaise || 0) / 100))
    ])));
    if (!rows.length) ledger.appendChild(el('div', { class: 'muted' }, 'No wallet activity yet.'));
  } catch (e) { host.innerHTML = ''; host.appendChild(el('div', { class: 'card card-pad muted' }, e.message)); }
}

async function startRecharge(packId) {
  try {
    const out = await api('/api/payment-intents', { method: 'POST', body: { packId: packId } });
    const checkoutUrl = out.checkout && (out.checkout.action || out.checkout.url);
    if (checkoutUrl && out.checkout.fields) {
      const form = el('form', { method: 'POST', action: checkoutUrl });
      Object.keys(out.checkout.fields).forEach((k) => form.appendChild(el('input', { type: 'hidden', name: k, value: out.checkout.fields[k] })));
      document.body.appendChild(form); form.submit(); return;
    }
    toast(out.message || 'PayU checkout is not enabled yet. Your wallet was not charged.', 'info');
  } catch (e) { toast(e.message, 'err'); }
}

async function viewSupport(root) {
  root.appendChild(viewHead('Support', 'Open a ticket and keep every reply attached to your workspace.'));
  const subject = el('input', { class: 'input', placeholder: 'What do you need help with.' });
  const message = el('textarea', { class: 'input textarea', placeholder: 'Describe the issue, expected result, and what happened.' });
  const create = el('button', { class: 'btn btn-primary' }, 'Open ticket');
  const list = el('div', { class: 'ticket-list' }, skeleton('sk-card', 2));
  create.onclick = async () => {
    create.disabled = true;
    try {
      await api('/api/support/tickets', { method: 'POST', body: { subject: subject.value.trim(), message: message.value.trim(), priority: 'normal' } });
      subject.value = ''; message.value = ''; toast('Support ticket opened.', 'ok'); await loadTickets(list);
    } catch (e) { toast(e.message, 'err'); } finally { create.disabled = false; }
  };
  root.appendChild(el('div', { class: 'support-layout' }, [
    el('section', { class: 'card card-pad support-compose' }, [el('h3', { class: 't-h3' }, 'New ticket'), field('Subject', subject), field('Message', message), create]),
    list
  ]));
  await loadTickets(list);
}

async function loadTickets(host) {
  try {
    const out = await api('/api/support/tickets'); host.innerHTML = '';
    (out.tickets || []).forEach((t) => host.appendChild(ticketCard(t, false)));
    if (!(out.tickets || []).length) host.appendChild(el('div', { class: 'card card-pad muted' }, 'No support tickets yet.'));
  } catch (e) { host.innerHTML = ''; host.appendChild(el('div', { class: 'card card-pad muted' }, e.message)); }
}

function ticketCard(t, admin) {
  const messages = (t.messages || []).map((m) => el('div', { class: 'ticket-message' }, [
    el('b', {}, m.authorName || m.authorRole || 'User'), el('span', {}, m.message || m.body || '')
  ]));
  const reply = el('input', { class: 'input', placeholder: 'Write a reply.' });
  const send = el('button', { class: 'btn btn-ghost' }, 'Reply');
  send.onclick = async () => {
    const msg = reply.value.trim(); if (!msg) return;
    send.disabled = true;
    try {
      await api(admin ? '/api/admin/tickets/reply' : '/api/support/tickets/reply', { method: 'POST', body: { ticketId: t.id, message: msg } });
      toast('Reply sent.', 'ok'); onRoute();
    } catch (e) { toast(e.message, 'err'); } finally { send.disabled = false; }
  };
  const adminControls = admin ? el('div', { class: 'ticket-admin-controls' }, [
    (function () { const s = el('select', { class: 'select' }, ['open','in_progress','waiting_on_customer','resolved','closed'].map((v) => el('option', { value: v }, v.replace(/_/g, ' ')))); s.value = t.status || 'open'; s.setAttribute('data-ticket-status', t.id); return s; })(),
    (function () { const s = el('select', { class: 'select' }, ['low','normal','high','urgent'].map((v) => el('option', { value: v }, v))); s.value = t.priority || 'normal'; s.setAttribute('data-ticket-priority', t.id); return s; })(),
    el('button', { class: 'btn btn-ghost', onclick: async () => { const status = document.querySelector('[data-ticket-status="' + t.id + '"]').value; const priority = document.querySelector('[data-ticket-priority="' + t.id + '"]').value; await api('/api/admin/tickets/update', { method: 'POST', body: { ticketId: t.id, status: status, priority: priority } }); toast('Ticket updated.', 'ok'); onRoute(); } }, 'Update')
  ]) : null;
  return el('article', { class: 'card ticket-card' }, [
    el('div', { class: 'flex items-center justify-between gap-2' }, [el('h3', { class: 't-h3' }, t.subject), el('span', { class: 'pill' }, t.status || 'open')]),
    adminControls, ...messages, el('div', { class: 'ticket-reply' }, [reply, send])
  ]);
}

async function viewAdmin(root) {
  if (!State.me || !['super_admin', 'admin'].includes(State.me.user.role)) { goto('overview'); return; }
  const superAdmin = State.me.user.role === 'super_admin';
  root.appendChild(viewHead(superAdmin ? 'Super admin' : 'Operations admin', 'Users, workspaces, phone numbers, calls, billing, support, and immutable audit history.'));
  const stats = el('div', { class: 'grid grid-3' }, skeleton('sk-stat', 5));
  const tenantHost = el('div', { class: 'card card-pad admin-table' }, skeleton('sk-card', 1));
  const ticketHost = el('div', { class: 'ticket-list' }, skeleton('sk-card', 2));
  const eventHost = el('div', { class: 'card card-pad admin-table' }, skeleton('sk-card', 1));
  root.appendChild(stats); root.appendChild(el('div', { class: 'admin-layout' }, [tenantHost, ticketHost])); root.appendChild(eventHost);
  try {
    const calls = [api('/api/admin/tickets'), api('/api/admin/payment-events')];
    if (superAdmin) calls.unshift(api('/api/admin/overview'), api('/api/admin/tenants'), api('/api/admin/users'));
    const data = await Promise.all(calls);
    const o = superAdmin ? data[0] : { totals: {} }, ts = superAdmin ? data[1] : { tenants: [] }, users = superAdmin ? data[2] : { users: [] }, tickets = data[superAdmin ? 3 : 0], events = data[superAdmin ? 4 : 1];
    stats.innerHTML = '';
    const totals = o.totals || {};
    [['Tenants', totals.tenants || 'Restricted'], ['Users', totals.users || 'Restricted'], ['Open tickets', totals.openTickets != null ? totals.openTickets : (tickets.tickets || []).filter((t) => t.status !== 'closed').length], ['Wallet total', superAdmin ? '₹' + fmtInr((totals.walletPaise || 0) / 100) : 'Restricted'], ['Calls', superAdmin ? totals.calls : 'Restricted']].forEach((x) => stats.appendChild(statCard(x[0], String(x[1] || 0), 'All workspaces')));
    tenantHost.innerHTML = ''; tenantHost.appendChild(el('h3', { class: 't-h3' }, 'Tenants'));
    if (superAdmin) (ts.tenants || []).forEach((t) => tenantHost.appendChild(adminTenantRow(t, (users.users || []).filter((u) => u.tenantId === t.id))));
    else tenantHost.appendChild(el('div', { class: 'muted' }, 'Tenant controls require super admin access.'));
    ticketHost.innerHTML = ''; (tickets.tickets || []).forEach((t) => ticketHost.appendChild(ticketCard(t, true)));
    eventHost.innerHTML = ''; eventHost.appendChild(el('h3', { class: 't-h3' }, 'PayU webhook log'));
    (events.events || []).slice(0, 25).forEach((e) => eventHost.appendChild(el('div', { class: 'admin-row' }, [el('div', {}, [el('b', {}, e.txnid || 'Unknown transaction'), el('small', { class: 'muted' }, (e.reason || '') + ' · ' + (e.createdAt || ''))]), el('span', { class: 'pill' }, e.status || 'received')])));
    if (!(events.events || []).length) eventHost.appendChild(el('div', { class: 'muted' }, 'No PayU webhooks received yet.'));
  } catch (e) { tenantHost.innerHTML = ''; tenantHost.appendChild(el('div', { class: 'muted' }, e.message)); }
}

function adminTenantRow(t, users) {
  const wallet = t.wallet || {};
  const toggle = el('button', { class: 'btn btn-ghost' }, t.status === 'suspended' ? 'Reactivate' : 'Suspend');
  toggle.onclick = async () => {
    const status = t.status === 'suspended' ? 'active' : 'suspended';
    await api('/api/admin/tenants/status', { method: 'POST', body: { tenantId: t.id, status: status } });
    toast('Tenant set to ' + status + '.', 'ok'); onRoute();
  };
  const credit = el('button', { class: 'btn btn-ghost', onclick: () => adjustWallet(t) }, 'Adjust credit');
  const inspect = el('button', { class: 'btn btn-primary', onclick: () => inspectTenant(t, users || []) }, 'Open workspace');
  return el('div', { class: 'admin-row' }, [
    el('div', {}, [el('b', {}, t.name), el('small', { class: 'muted' }, (t.users || 0) + ' users, ₹' + fmtInr((wallet.balancePaise || 0) / 100))]),
    el('span', { class: 'pill' }, t.status || 'active'), el('div', { class: 'flex gap-2' }, [inspect, credit, toggle])
  ]);
}

async function inspectTenant(t, users) {
  const out = await api('/api/admin/tenant-detail?tenantId=' + encodeURIComponent(t.id));
  const tabs = [
    ['Users', (out.users || []).map((u) => u.name + ' · ' + u.email + ' · ' + u.role)],
    ['Agents', (out.agents || []).map((a) => a.name + ' · ' + ((a.telephony || {}).did || 'No number'))],
    ['Numbers', (out.numbers || []).map((n) => n.address + ' · ' + n.provider + ' · ' + n.status)],
    ['Calls', (out.usage || []).map((u) => u.day + ' · ' + (u.calls || 0) + ' calls')],
    ['Billing', (out.ledger || []).map((x) => (x.type || 'entry') + ' · ₹' + fmtInr((x.amountPaise || 0) / 100))],
    ['Support', (out.tickets || []).map((x) => x.subject + ' · ' + x.status)]
  ];
  const body = el('div', { class: 'tenant-inspector' }, tabs.map((tab) => el('section', {}, [el('h4', {}, tab[0]), ...(tab[1].length ? tab[1].map((line) => el('div', { class: 'inspector-line' }, line)) : [el('div', { class: 'muted' }, 'No records')])])));
  const user = (out.users || []).find((u) => u.role !== 'super_admin' && u.status === 'active');
  if (user) body.prepend(el('button', { class: 'btn btn-dark', onclick: () => startImpersonation(user) }, 'View as ' + user.email));
  modal({ title: out.tenant.name, body: body, confirmText: 'Close', onConfirm: async () => {} });
}

function startImpersonation(user) {
  const reason = el('input', { class: 'input', placeholder: 'Support ticket or investigation reason' });
  const password = el('input', { class: 'input', type: 'password', placeholder: 'Your super admin password' });
  modal({ title: 'View as ' + user.email, body: el('div', {}, [el('p', {}, 'This creates a 30 minute read-only user session. Billing, roles, status, and secrets remain blocked.'), field('Reason', reason), field('Re-enter your password', password)]), confirmText: 'Enter user view', onConfirm: async () => {
    await api('/api/admin/impersonations', { method: 'POST', body: { userId: user.id, reason: reason.value.trim(), password: password.value } });
    State.me = await api('/api/me'); renderShell(); goto('overview');
  }});
}

function adjustWallet(t) {
  const amount = el('input', { class: 'input', type: 'number', step: '0.01', placeholder: '100.00' });
  const reason = el('input', { class: 'input', placeholder: 'Required adjustment reason' });
  modal({ title: 'Adjust ' + t.name + ' wallet', body: el('div', {}, [field('Amount in INR, negative deducts', amount), field('Reason', reason)]), confirmText: 'Apply adjustment', onConfirm: async () => {
    const paise = Math.round(Number(amount.value) * 100);
    await api('/api/admin/wallet/adjust', { method: 'POST', body: { tenantId: t.id, amountPaise: paise, reason: reason.value.trim(), idempotencyKey: 'ui_' + Date.now() + '_' + Math.random().toString(36).slice(2) } });
    toast('Wallet adjusted.', 'ok'); onRoute();
  }});
}

/* ===========================================================================
   7. SETTINGS
   =========================================================================== */
async function viewSettings(root) {
  root.appendChild(viewHead('Settings', 'Implemented providers, selected server defaults, and your tenant identity. Live call workflows are configured separately.'));

  const provHost = el('div', { id: 'provHost' }, skeleton('sk-card', 3));
  root.appendChild(provHost);

  const t = State.me.tenant;
  const nameI = el('input', { class: 'input', id: 'set_name', type: 'text', value: t.name || '' });
  const colorVal = (t.branding && t.branding.color) || '#6E7BFF';
  const colorI = el('input', { type: 'color', id: 'set_color', value: colorVal });
  const colorHex = el('input', { class: 'input', id: 'set_color_hex', value: colorVal, style: 'max-width:130px;font-family:var(--mono)' });
  colorI.addEventListener('input', () => { colorHex.value = colorI.value; });
  colorHex.addEventListener('input', () => { if (/^#[0-9a-fA-F]{6}$/.test(colorHex.value)) colorI.value = colorHex.value; });

  const saveBtn = el('button', { class: 'btn btn-primary' }, 'Save tenant settings');
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true; saveBtn.textContent = 'Saving...';
    try {
      // tenant settings update is best effort. If the route is absent, surface a soft note.
      await api('/api/tenant/update', { method: 'POST', body: { name: nameI.value.trim(), color: colorI.value } });
      State.me.tenant.name = nameI.value.trim();
      State.me.tenant.branding = Object.assign({}, State.me.tenant.branding, { color: colorI.value });
      const tn = $('.tenant-chip .tn'); if (tn) { tn.textContent = State.me.tenant.name; tn.title = State.me.tenant.name; }
      const av = $('.tenant-chip .av'); if (av) av.textContent = initials(State.me.tenant.name);
      toast('Tenant settings saved.', 'ok');
    } catch (ex) {
      toast(ex.status === 404 ? 'Tenant settings endpoint not available in this build.' : (ex.message || 'Save failed.'), 'err');
    } finally {
      saveBtn.disabled = false; saveBtn.textContent = 'Save tenant settings';
    }
  });

  root.appendChild(el('div', { class: 'card card-pad', style: 'margin-top:8px' }, [
    el('h3', { class: 't-h3', style: 'margin-bottom:16px' }, 'Tenant'),
    el('div', { class: 'settings-form' }, [
      field('Tenant name', nameI),
      el('div', { class: 'field' }, [el('label', {}, 'Brand color'), el('div', { class: 'color-row' }, [colorI, colorHex])]),
      el('div', { class: 'flex gap-2', style: 'margin-top:6px' }, [saveBtn, el('button', { class: 'btn btn-ghost', onclick: doLogout }, 'Sign out')])
    ])
  ]));

  const privacySelect = el('select', { class: 'select', id: 'privacy_mode' }, [
    el('option', { value: 'standard' }, 'Standard retention'),
    el('option', { value: 'metadata_only' }, 'Privacy mode, metadata only'),
    el('option', { value: 'no_recording' }, 'HIPAA mode, no recording or transcript retention')
  ]);
  const privacySave = el('button', { class: 'btn btn-primary' }, 'Save privacy mode');
  privacySave.onclick = async () => {
    privacySave.disabled = true;
    try { await api('/api/privacy', { method: 'POST', body: { mode: privacySelect.value } }); toast('Privacy mode saved.', 'ok'); }
    catch (e) { toast(e.message, 'err'); } finally { privacySave.disabled = false; }
  };
  const provider = el('select', { class: 'select' }, [el('option', { value: 'vobiz' }, 'VoBiz'), el('option', { value: 'telnyx' }, 'Telnyx'), el('option', { value: 'sip' }, 'SIP trunk')]);
  const address = el('input', { class: 'input', placeholder: 'Verified E.164 number or SIP address' });
  const label = el('input', { class: 'input', placeholder: 'Main sales line' });
  const byonList = el('div', { class: 'byon-list muted' }, 'Loading connections...');
  const byonSave = el('button', { class: 'btn btn-ghost' }, 'Connect my number');
  byonSave.onclick = async () => {
    byonSave.disabled = true;
    try { await api('/api/byon', { method: 'POST', body: { provider: provider.value, address: address.value.trim(), label: label.value.trim() } }); toast('Number connection saved for verification.', 'ok'); await loadByon(byonList); }
    catch (e) { toast(e.message, 'err'); } finally { byonSave.disabled = false; }
  };
  root.appendChild(el('div', { class: 'settings-split' }, [
    el('section', { class: 'card card-pad' }, [
      el('h3', { class: 't-h3' }, 'Privacy and HIPAA mode'),
      el('p', { class: 'muted privacy-copy' }, 'HIPAA mode disables recording and transcript retention in RapidX Voice. It does not by itself make your organization HIPAA compliant. You still need appropriate provider BAAs, policies, access controls, consent, and legal review.'),
      field('Retention policy', privacySelect), privacySave
    ]),
    el('section', { class: 'card card-pad' }, [
      el('h3', { class: 't-h3' }, 'Bring your own number'),
      el('p', { class: 'muted privacy-copy' }, 'Connect only a number or SIP address that your organization owns and has verified with the carrier.'),
      field('Provider', provider), field('Number or SIP address', address), field('Label', label), byonSave, byonList
    ])
  ]));
  Promise.all([
    api('/api/privacy').then((x) => { privacySelect.value = x.mode || 'standard'; }),
    loadByon(byonList)
  ]).catch(() => {});

  try {
    const reg = await ensureProviders();
    paintProviders(provHost, reg);
  } catch (e) {
    provHost.innerHTML = '';
    provHost.appendChild(el('div', { class: 'card card-pad muted' }, 'Could not load providers. ' + esc(e.message)));
  }
}

async function loadByon(host) {
  const out = await api('/api/byon'); host.innerHTML = '';
  (out.connections || []).forEach((x) => host.appendChild(el('div', { class: 'status-line' }, [
    el('span', { class: 'k' }, x.label || x.provider), el('span', { class: 'v' }, (x.address || '') + ' · ' + (x.status || 'pending'))
  ])));
  if (!(out.connections || []).length) host.textContent = 'No number connected yet.';
}

function paintProviders(host, reg) {
  host.innerHTML = '';
  const layers = [
    { key: 'tts', label: 'Text to speech' },
    { key: 'llm', label: 'Brain, LLM' },
    { key: 'telephony', label: 'Telephony' }
  ];
  layers.forEach((L) => {
    const list = reg[L.key] || [];
    const wrap = el('div', { class: 'prov-layer' }, [
      el('div', { class: 'lh' }, [el('span', { class: 'lt' }, L.label)]),
      el('div', { class: 'prov-grid' }, list.length ? list.map(provCard) : [el('div', { class: 'muted' }, 'No providers registered.')])
    ]);
    host.appendChild(wrap);
  });
}
function provCard(p) {
  const live = !!p.live;
  const selected = !!p.selected;
  const needs = p.needs || [];
  return el('div', { class: 'card prov-card' }, [
    el('div', { class: 'pc-top' }, [
      el('div', { class: 'pc-name' }, p.label || p.id),
      selected && live
        ? el('span', { class: 'badge-live' }, [el('span', { class: 'd' }), 'Selected'])
        : live
          ? el('span', { class: 'badge-ready' }, [el('span', { class: 'd' }), 'Configured'])
          : el('span', { class: 'badge-ready' }, [el('span', { class: 'd' }), 'Needs setup'])
    ]),
    selected && live
      ? el('div', { class: 'pc-needs' }, 'Default provider for dashboard-owned requests.')
      : live
        ? el('div', { class: 'pc-needs' }, 'Credentials available. Select it through trusted server configuration.')
      : el('div', { class: 'pc-needs' }, needs.length
          ? ['To enable, add ', ...needs.flatMap((n, i) => i ? [document.createTextNode(', '), el('code', {}, n)] : [el('code', {}, n)]), document.createTextNode(' to your .env.')]
          : 'Adapter is implemented but not configured.')
  ]);
}

/* ===========================================================================
   START
   =========================================================================== */
let _booted = false;
function bootOnce() { if (_booted) return; _booted = true; boot(); }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootOnce);
else bootOnce();
