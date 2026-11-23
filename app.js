// RemApp – vstupný bod: prihlásenie, router, synchronizácia, service worker.
import './js/version.js';
import { isConfigured } from './js/config.js';
import * as db from './js/db.js';
import * as store from './js/store.js';
import * as sync from './js/sync.js';
import * as auth from './js/auth.js';
import { closeAllSheets, toast } from './js/ui.js';
import { mountHome } from './js/views/home.js';
import { mountList } from './js/views/list.js';
import { mountSettings } from './js/views/settings.js';

const html = document.documentElement;
const viewEl = document.getElementById('view');
const authStatus = document.getElementById('auth-status');

let current = null;
let currentRoute = '';
let session = null;
const navStack = [];

/* ------------------------------------------------------------ SYNC PILL */

const PILL = {
  idle: ['…', 'Čakám na synchronizáciu'],
  ok: ['OK', 'Synchronizované'],
  syncing: ['Sync', 'Synchronizujem'],
  pending: ['Čaká', 'Neodoslané zmeny'],
  offline: ['Offline', 'Si offline – zmeny sa odošlú po pripojení'],
  error: ['Chyba', 'Chyba synchronizácie']
};

const syncPill = document.createElement('button');
syncPill.type = 'button';
syncPill.className = 'sync-pill';
syncPill.innerHTML = '<span class="dot" aria-hidden="true"></span><span class="sync-text"></span>';
syncPill.addEventListener('click', () => {
  const s = sync.getStatus();
  if (s.message) toast(s.message, { type: s.state === 'error' ? 'error' : 'info' });
  sync.syncNow();
});

let lastState = '';
sync.onStatus(s => {
  const [short, long] = PILL[s.state] || PILL.idle;
  syncPill.dataset.state = s.state;
  syncPill.querySelector('.sync-text').textContent = s.state === 'pending' && s.pending ? `${short} ${s.pending}` : short;
  syncPill.setAttribute('aria-label', `${long}${s.message ? ': ' + s.message : ''}`);
  syncPill.title = s.message || long;
  if (s.state === 'error' && lastState !== 'error' && s.message) toast(s.message, { type: 'error' });
  lastState = s.state;
  if (currentRoute === 'home' && current) current.update();
});

const isLoading = () => {
  const s = sync.getStatus();
  return !s.lastOkAt && s.state !== 'error' && s.state !== 'offline';
};

/* ------------------------------------------------------------ ROUTER */

function navigate(hash, { replace = false } = {}) {
  if (replace) {
    navStack[navStack.length - 1] = hash;
    location.replace(hash);
  } else {
    location.hash = hash;
  }
}

function back() {
  if (navStack.length > 1) history.back();
  else navigate('#/', { replace: true });
}

function onHashChange() {
  const h = location.hash || '#/';
  if (navStack.length > 1 && navStack[navStack.length - 2] === h) navStack.pop();
  else if (navStack[navStack.length - 1] !== h) navStack.push(h);
  route();
}

function route() {
  if (!session) return;
  closeAllSheets();
  const hash = location.hash || '#/';
  current && current.destroy();
  viewEl.innerHTML = '';
  const ctx = { navigate, back, syncPill, isLoading, session, logout };
  const m = hash.match(/^#\/list\/([A-Za-z0-9-]+)$/);
  if (m && store.getList(m[1])) {
    currentRoute = 'list';
    current = mountList(viewEl, ctx, m[1]);
  } else if (hash === '#/settings') {
    currentRoute = 'settings';
    current = mountSettings(viewEl, ctx);
  } else {
    if (m) toast('Tento zoznam sa nenašiel.', { type: 'error' });
    if (hash !== '#/') history.replaceState(null, '', '#/');
    currentRoute = 'home';
    current = mountHome(viewEl, ctx);
  }
  viewEl.focus({ preventScroll: true });
}

store.subscribe(() => current && current.update());
window.addEventListener('hashchange', onHashChange);

/* ------------------------------------------------------------ AUTH */

function setAuthStatus(text, tone = 'info') {
  authStatus.textContent = text || '';
  authStatus.dataset.tone = tone;
}

function showAuth(message) {
  session = null;
  sync.stop();
  closeAllSheets();
  html.classList.add('locked');
  setAuthStatus(message || '', message ? 'warn' : 'info');
  if (!isConfigured()) {
    setAuthStatus('Aplikácia ešte nie je nastavená: doplň API_URL a GOOGLE_CLIENT_ID v súbore js/config.js (README, krok 5).', 'error');
    return;
  }
  auth.showSignIn(document.getElementById('auth-google-btn'), {
    onLogin: s => startApp(s),
    onStatus: setAuthStatus
  });
}

async function startApp(s) {
  // Na zariadení boli dáta iného účtu => zmazať, nech sa nemiešajú.
  const owner = await db.getMeta('owner');
  if (owner && owner !== s.email) await db.clearAll();
  await db.setMeta('owner', s.email);

  session = s;
  store.state.me = s.email;
  await store.load();
  html.classList.remove('locked');
  if (!navStack.length) navStack.push(location.hash || '#/');
  route();
  sync.start({ onAuthError: err => showAuth(err.message) });
}

async function logout() {
  sync.stop();
  await auth.signOut();
  await db.clearAll();
  store.reset();
  current && current.destroy();
  current = null;
  viewEl.innerHTML = '';
  history.replaceState(null, '', '#/');
  navStack.length = 0;
  showAuth('Odhlásenie prebehlo. Údaje z tohto zariadenia sú vymazané.');
}

/* ------------------------------------------------------------ SERVICE WORKER */

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  let reloading = false;
  let updateRequested = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!updateRequested || reloading) return;
    reloading = true;
    location.reload();
  });
  const banner = document.getElementById('update-banner');
  const offer = worker => {
    banner.hidden = false;
    banner.querySelector('button').onclick = () => {
      updateRequested = true;
      worker.postMessage('SKIP_WAITING');
    };
  };
  navigator.serviceWorker.register('./sw.js').then(reg => {
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w && w.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
      });
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch(err => console.warn('Service worker sa nepodarilo zaregistrovať', err));
}

/* ------------------------------------------------------------ BOOT */

async function boot() {
  registerServiceWorker();
  document.getElementById('app-version').textContent = `v${self.APP_VERSION}`;
  try {
    await db.open();
  } catch (err) {
    html.classList.add('locked');
    setAuthStatus(`Úložisko prehliadača nie je dostupné (${err.message}). Skús zavrieť ostatné karty alebo vypnúť súkromný režim.`, 'error');
    return;
  }
  const s = isConfigured() ? auth.getSession() : null;
  if (s) await startApp(s);
  else showAuth();
}

boot();
