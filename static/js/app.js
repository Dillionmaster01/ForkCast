// Forkcast - app shell, sign-in, and the small toolkit every screen shares.
import { renderPlan } from './plan.js';
import { renderRecipes, renderRecipe } from './recipes.js';
import { renderShop, renderPantry } from './shop.js';
import { renderMe } from './me.js';

export const S = {
  token: lsGet('fc_token'),
  me: null,
  users: [],
  foods: [],
  foodsById: {},
  weekStartsMonday: lsGet('fc_week_mon') === '1',
};

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
export function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } }

// ── api ──────────────────────────────────────────────────────────────
export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: `Bearer ${S.token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (res.status === 401 && S.token && !path.startsWith('/api/login')) {
    S.token = null;
    lsSet('fc_token', null);
    boot();
    throw new Error('Signed out');
  }
  if (!res.ok) throw new Error((data && data.detail) || `Something went wrong (${res.status})`);
  return data;
}

// ── tiny helpers ────────────────────────────────────────────────────
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
export const fmtK = (n) => (n == null ? '–' : Math.round(n).toLocaleString('en-US'));
export const fmtMoney = (n) => (n == null ? '' : `$${Number(n).toFixed(2)}`);
export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

export const SLOTS = [
  { id: 'breakfast', label: 'Breakfast' },
  { id: 'lunch', label: 'Lunch' },
  { id: 'dinner', label: 'Dinner' },
  { id: 'dessert', label: 'Dessert' },
  { id: 'snack', label: 'Snacks' },
];
export const slotLabel = (id) => (SLOTS.find((s) => s.id === id) || { label: id }).label;

// dates are plain YYYY-MM-DD strings in the person's own calendar
export function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const dowOf = (iso) => new Date(iso + 'T12:00:00').getDay();
export const fmtDay = (iso) => `${DOW[dowOf(iso)]} ${MON[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
export const fmtShort = (iso) => `${MON[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
export const dowName = (iso) => DOW[dowOf(iso)];
export const monthName = (m) => ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m];
export function weekStartFor(iso) {
  const dow = dowOf(iso);
  const back = S.weekStartsMonday ? (dow + 6) % 7 : dow;
  return addDays(iso, -back);
}

export const userById = (id) => S.users.find((u) => u.id === id);
export function avatar(u, cls = '') {
  if (!u) return '';
  return `<span class="avatar ${cls}" style="background:${esc(u.color)};color:${cls.includes('planned') ? esc(u.color) : '#fff'}" title="${esc(u.name)}">${esc((u.name || '?')[0].toUpperCase())}</span>`;
}

const ICONS = {
  plan: '<path d="M7 3v3M17 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z"/><path d="M8 13h3v3H8z"/>',
  recipes: '<path d="M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4Z"/><path d="M5 17a3 3 0 0 1 3-3h10M9 8h5"/>',
  shop: '<path d="M6 8h12l-1 12H7L6 8Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
  pantry: '<path d="M8 3h8M7 6h10M6 6v13a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6"/><path d="M9 12h6"/>',
  me: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  left: '<path d="M15 6l-6 6 6 6"/>',
  right: '<path d="M9 6l6 6-6 6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  share: '<path d="M12 4v11M8 8l4-4 4 4M5 13v6h14v-6"/>',
  star: '<path d="m12 4 2.5 5 5.5.8-4 3.9.9 5.5L12 16.6 7.1 19.2l.9-5.5-4-3.9 5.5-.8L12 4Z"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4Z"/>',
  trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
  scan: '<path d="M4 8V5h3M17 5h3v3M20 16v3h-3M7 19H4v-3M7 9v6M10 9v6M13 9v6M16 9v6"/>',
  fork: '<path d="M7 3v8a2 2 0 0 0 2 2v8M11 3v8a2 2 0 0 1-2 2M9 3v6M17 21V3c-2 1-3 4-3 7s1 4 3 4"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  cart: '<path d="M3 4h2l2 11h11l2-8H6"/><circle cx="9" cy="19" r="1.5"/><circle cx="17" cy="19" r="1.5"/>',
};
export const icon = (name, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${ICONS[name] || ''}</svg>`;
const LOGO = '<span class="mark"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3v8a2 2 0 0 0 2 2v8M11 3v8a2 2 0 0 1-2 2M9 3v6M17 21V3c-2 1-3 4-3 7s1 4 3 4"/></svg></span>Forkcast';

// ── toasts ──────────────────────────────────────────────────────────
export function toast(msg, { action, onAction, error = false, ms = 3800 } = {}) {
  const el = h(`<div class="toast ${error ? 'err' : ''}"><span class="grow">${esc(msg)}</span>${action ? `<button class="link">${esc(action)}</button>` : ''}</div>`);
  $('#toasts').appendChild(el);
  const kill = () => el.remove();
  if (action) $('button', el).onclick = () => { kill(); onAction && onAction(); };
  setTimeout(kill, action ? Math.max(ms, 6500) : ms);
}
export const fail = (e) => toast(e.message || String(e), { error: true });

// ── sheets ──────────────────────────────────────────────────────────
const sheetStack = [];
export function openSheet({ title, body = '', foot = '', wide = false, onClose } = {}) {
  const scrim = h(`<div class="scrim"><div class="sheet ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
    <div class="sheet-head"><h2 class="ellipsis">${esc(title)}</h2><button class="btn ghost icon sm" data-close aria-label="Close">${icon('close')}</button></div>
    <div class="sheet-body"></div><div class="sheet-foot"></div></div></div>`);
  const sheet = $('.sheet', scrim);
  const bodyEl = $('.sheet-body', scrim);
  const footEl = $('.sheet-foot', scrim);
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.appendChild(body);
  if (foot) footEl.innerHTML = foot; else footEl.classList.add('hidden');
  let closed = false;
  const api_ = {
    el: sheet, body: bodyEl, foot: footEl,
    setTitle: (t) => { $('h2', sheet).textContent = t; },
    setFoot: (html) => { footEl.innerHTML = html; footEl.classList.toggle('hidden', !html); },
    close: () => {
      if (closed) return;
      closed = true;
      scrim.remove();
      sheetStack.splice(sheetStack.indexOf(api_), 1);
      document.body.style.overflow = sheetStack.length ? 'hidden' : '';
      onClose && onClose();
    },
  };
  scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) api_.close(); });
  $('[data-close]', scrim).onclick = api_.close;
  document.body.appendChild(scrim);
  document.body.style.overflow = 'hidden';
  sheetStack.push(api_);
  return api_;
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sheetStack.length) sheetStack[sheetStack.length - 1].close();
});

export function confirmSheet(title, text, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    let done = false;
    const sh = openSheet({
      title, body: `<p style="margin:0">${esc(text)}</p>`,
      foot: `<button class="btn" data-no>Cancel</button><button class="btn primary ${danger ? 'danger-bg' : ''}" data-ok>${esc(okLabel)}</button>`,
      onClose: () => { if (!done) resolve(false); },
    });
    $('[data-no]', sh.el).onclick = () => sh.close();
    $('[data-ok]', sh.el).onclick = () => { done = true; sh.close(); resolve(true); };
  });
}

export function stepper(value, { min = 0, max = 99, step = 1, name = '' } = {}) {
  return `<span class="stepper" data-min="${min}" data-max="${max}" data-step="${step}"><button type="button" data-d="-1" aria-label="Less">−</button><input type="number" inputmode="decimal" name="${esc(name)}" value="${esc(value)}" step="any"><button type="button" data-d="1" aria-label="More">+</button></span>`;
}
// steppers work by delegation so any screen can use the markup above
document.addEventListener('click', (e) => {
  const b = e.target.closest('.stepper button');
  if (!b) return;
  const st = b.closest('.stepper');
  const inp = $('input', st);
  const step = Number(st.dataset.step) || 1;
  let v = Number(inp.value) || 0;
  v = Math.round((v + Number(b.dataset.d) * step) * 100) / 100;
  v = Math.min(Number(st.dataset.max), Math.max(Number(st.dataset.min), v));
  inp.value = v;
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  inp.dispatchEvent(new Event('change', { bubbles: true }));
});

// ── shared data ─────────────────────────────────────────────────────
export async function loadFoods() {
  S.foods = await api('GET', '/api/foods');
  S.foodsById = Object.fromEntries(S.foods.map((f) => [f.id, f]));
  return S.foods;
}
export function putFood(f) {
  const i = S.foods.findIndex((x) => x.id === f.id);
  if (i >= 0) S.foods[i] = f; else S.foods.push(f);
  S.foodsById[f.id] = f;
}
export async function loadUsers() {
  S.users = await api('GET', '/api/household');
  const me = S.users.find((u) => u.id === S.me.id);
  if (me) S.me = { ...S.me, ...me };
}

// ── routing ─────────────────────────────────────────────────────────
const NAV = [
  ['plan', 'Plan'], ['recipes', 'Recipes'], ['shop', 'Shop'], ['pantry', 'Pantry'], ['me', 'Me'],
];
function route() {
  const [name, arg] = (location.hash.replace(/^#\/?/, '') || 'plan').split('/');
  return { name, arg: arg ? decodeURIComponent(arg) : null };
}
export function go(hash) {
  if (location.hash === '#' + hash) render(); else location.hash = hash;
}

function shell() {
  const root = $('#root');
  root.innerHTML = `<div class="shell">
    <nav class="sidebar"><a class="logo" href="#plan">${LOGO}</a>
      ${NAV.map(([k, l]) => `<a class="nav" data-nav="${k}" href="#${k}">${icon(k)}${l}</a>`).join('')}
      <a class="who" href="#me">${avatar(S.me, 'lg')}<span><b>${esc(S.me.name)}</b><br><span class="muted small">Goals & settings</span></span></a>
    </nav>
    <div class="content">
      <header class="topbar"><a class="logo" href="#plan">${LOGO}</a><span class="spacer"></span><a href="#me" class="phone-only">${avatar(S.me)}</a></header>
      <main class="main" id="view"></main>
    </div>
    <nav class="tabbar">${NAV.map(([k, l]) => `<a data-nav="${k}" href="#${k}">${icon(k)}${l}</a>`).join('')}</nav>
  </div>`;
}

let renderSeq = 0;
let lastRoute = null;
export async function render() {
  if (!S.me) return;
  const { name, arg } = route();
  const seq = ++renderSeq;
  const routeKey = location.hash || '#plan';
  const keepY = routeKey === lastRoute ? window.scrollY : null;
  const tab = name === 'recipe' ? 'recipes' : name === 'month' ? 'plan' : name;
  $$('[data-nav]').forEach((a) => a.classList.toggle('on', a.dataset.nav === tab));
  const view = $('#view');
  const mount = document.createElement('div');
  try {
    if (name === 'recipes') await renderRecipes(mount, arg);
    else if (name === 'recipe') await renderRecipe(mount, arg);
    else if (name === 'shop') await renderShop(mount);
    else if (name === 'pantry') await renderPantry(mount, arg);
    else if (name === 'me') await renderMe(mount);
    else await renderPlan(mount, name === 'month' ? 'month' : 'week', arg);
  } catch (e) {
    if (e.message === 'Signed out') return;
    mount.innerHTML = `<div class="empty"><h3>Couldn't load this</h3><p>${esc(e.message)}</p><button class="btn" onclick="location.reload()">Try again</button></div>`;
  }
  if (seq !== renderSeq) return; // a newer screen started loading meanwhile
  view.replaceChildren(mount);
  lastRoute = routeKey;
  // same screen redrawn (after an edit): stay put; a new screen starts at its focus point or the top
  if (keepY != null) window.scrollTo(0, keepY);
  else {
    const focus = mount.dataset.focus && $(mount.dataset.focus, mount);
    if (focus) { focus.scrollIntoView({ block: 'start' }); window.scrollBy(0, -64); } else window.scrollTo(0, 0);
  }
}
window.addEventListener('hashchange', render);
// coming back to the app (phone unlocked, tab switched) picks up the other person's changes
let lastShown = Date.now();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.me && Date.now() - lastShown > 20000 && !sheetStack.length) render();
  if (document.visibilityState === 'hidden') lastShown = Date.now();
});

// ── sign in / setup ─────────────────────────────────────────────────
function authPage(inner) {
  $('#root').innerHTML = `<div class="auth"><div class="auth-card"><div class="logo">${LOGO}</div><div class="tag">Plan the week. Count what you eat. Shop once.</div><div class="card pad">${inner}</div></div></div>`;
}

async function setupScreen() {
  authPage(`<h2 style="font-size:22px;margin-bottom:4px">Set up your household</h2>
    <p class="muted small" style="margin-top:0">You'll be the admin. You can add everyone else after.</p>
    <form id="f"><label class="field"><span>Your name</span><input class="input" name="name" autocomplete="name" required maxlength="40"></label>
    <div class="grid2"><label class="field"><span>PIN (4–8 digits)</span><input class="input pin" name="pin" type="password" inputmode="numeric" pattern="\\d{4,8}" required></label>
    <label class="field"><span>PIN again</span><input class="input pin" name="pin2" type="password" inputmode="numeric" required></label></div>
    <label class="field"><span>Daily calorie goal (optional)</span><input class="input" name="kcal" type="number" inputmode="numeric" placeholder="e.g. 2000" min="500" max="10000"></label>
    <div class="err" id="err"></div><button class="btn primary" style="width:100%">Start planning</button></form>`);
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    if (f.get('pin') !== f.get('pin2')) { $('#err').textContent = "The PINs don't match."; return; }
    try {
      const r = await api('POST', '/api/setup', { name: f.get('name'), pin: f.get('pin'), kcal_goal: f.get('kcal') || null });
      signedIn(r);
    } catch (err) { $('#err').textContent = err.message; }
  };
}

async function loginScreen() {
  const users = await api('GET', '/api/users');
  let pick = lsGet('fc_last_user');
  if (!users.some((u) => u.id === pick)) pick = users.length === 1 ? users[0].id : null;
  authPage(`<h2 style="font-size:22px;margin-bottom:12px">Who's signing in?</h2>
    <div class="people-pick">${users.map((u) => `<button type="button" data-id="${esc(u.id)}" class="${u.id === pick ? 'on' : ''}">${avatar(u, 'lg')}${esc(u.name)}</button>`).join('')}</div>
    <form id="f"><label class="field"><span>PIN</span><input class="input pin" id="pin" type="password" inputmode="numeric" autocomplete="current-password" required></label>
    <div class="err" id="err"></div><button class="btn primary" style="width:100%">Sign in</button></form>`);
  $$('.people-pick button').forEach((b) => (b.onclick = () => {
    pick = b.dataset.id;
    $$('.people-pick button').forEach((x) => x.classList.toggle('on', x === b));
    $('#pin').focus();
  }));
  if (pick) setTimeout(() => $('#pin')?.focus(), 50);
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    if (!pick) { $('#err').textContent = 'Pick your name first.'; return; }
    try {
      const r = await api('POST', '/api/login', { user_id: pick, pin: $('#pin').value });
      lsSet('fc_last_user', pick);
      signedIn(r);
    } catch (err) { $('#err').textContent = err.message; $('#pin').select(); }
  };
}

function signedIn(r) {
  S.token = r.token;
  lsSet('fc_token', r.token);
  S.me = r.user;
  boot();
}

function mustChangePin() {
  authPage(`<h2 style="font-size:22px;margin-bottom:4px">Pick your own PIN</h2>
    <p class="muted small" style="margin-top:0">You signed in with a temporary PIN. Choose one only you know.</p>
    <form id="f"><label class="field"><span>Temporary PIN</span><input class="input pin" name="cur" type="password" inputmode="numeric" required></label>
    <div class="grid2"><label class="field"><span>New PIN</span><input class="input pin" name="p1" type="password" inputmode="numeric" required></label>
    <label class="field"><span>New PIN again</span><input class="input pin" name="p2" type="password" inputmode="numeric" required></label></div>
    <div class="err" id="err"></div><button class="btn primary" style="width:100%">Save my PIN</button></form>`);
  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    if (f.get('p1') !== f.get('p2')) { $('#err').textContent = "The new PINs don't match."; return; }
    try {
      S.me = await api('PUT', '/api/me', { current_pin: f.get('cur'), new_pin: f.get('p1') });
      boot();
    } catch (err) { $('#err').textContent = err.message; }
  };
}

export async function signOut() {
  try { await api('POST', '/api/logout', {}); } catch { /* already gone */ }
  S.token = null;
  S.me = null;
  lsSet('fc_token', null);
  boot();
}

export function applyTheme() {
  const t = lsGet('fc_theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

async function boot() {
  applyTheme();
  try {
    if (!S.token) {
      const { setupNeeded } = await api('GET', '/api/setup-needed');
      return setupNeeded ? setupScreen() : loginScreen();
    }
    S.me = await api('GET', '/api/me');
    if (S.me.mustChangePin) return mustChangePin();
    await Promise.all([loadUsers(), loadFoods()]);
    shell();
    render();
  } catch (e) {
    if (e.message === 'Signed out') return;
    authPage(`<div class="empty"><h3>Can't reach Forkcast</h3><p>${esc(e.message)}</p><button class="btn" onclick="location.reload()">Try again</button></div>`);
  }
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
boot();
