// Synchronizácia: odoslanie outboxu + stiahnutie delty v jednej požiadavke.
// Lokálna zmena => odoslanie po 500 ms. Kým je appka viditeľná, polling každých 10 s.
// Na pozadí sa polling zastaví, po návrate sa hneď synchronizuje.
import * as db from './db.js';
import * as store from './store.js';
import { call } from './api.js';
import { getToken } from './auth.js';
import { setServerTime, debounce } from './util.js';
import { POLL_MS, PUSH_DEBOUNCE_MS } from './config.js';

const MAX_PER_REQUEST = 200;

const status = { state: 'idle', message: '', pending: 0, lastOkAt: 0 };
const listeners = new Set();
let inflight = null;
let again = false;
let pollTimer = null;
let running = false;
let onAuthError = () => {};

export const getStatus = () => ({ ...status });
export function onStatus(fn) {
  listeners.add(fn);
  fn(getStatus());
  return () => listeners.delete(fn);
}

function setStatus(patch) {
  Object.assign(status, patch);
  for (const fn of listeners) fn(getStatus());
}

async function refreshPending() {
  const n = (await db.getAll('outbox')).length;
  setStatus({ pending: n });
  return n;
}

export const schedulePush = debounce(() => syncNow(), PUSH_DEBOUNCE_MS);

export function syncNow() {
  if (!running) return Promise.resolve();
  if (inflight) {
    again = true;
    return inflight;
  }
  inflight = run().finally(() => {
    inflight = null;
    if (again) {
      again = false;
      syncNow();
    }
  });
  return inflight;
}

async function run() {
  const pending = await refreshPending();
  if (!navigator.onLine) {
    setStatus({ state: 'offline', message: pending ? 'Zmeny sa odošlú po pripojení.' : '' });
    return;
  }
  const token = getToken();
  if (!token) return;
  setStatus({ state: 'syncing', message: '' });

  const outbox = (await db.getAll('outbox')).slice(0, MAX_PER_REQUEST);
  const changes = {};
  for (const e of outbox) (changes[e.kind] ||= []).push(e.row);
  const since = await db.getMeta('lastSyncAt', 0);

  try {
    const resp = await call('sync', { since, changes }, token);
    setServerTime(resp.now);

    // Odstrániť z outboxu to, čo sa odoslalo a medzitým sa lokálne nezmenilo.
    const sentOps = [];
    for (const e of outbox) {
      const cur = await db.get('outbox', e.k);
      if (cur && cur.row.updatedAt === e.row.updatedAt) sentOps.push({ store: 'outbox', del: e.k });
    }
    await db.batch(sentOps);
    await store.applyServer(resp);
    await db.setMeta('lastSyncAt', resp.serverTime);

    const left = await refreshPending();
    setStatus({ state: left ? 'pending' : 'ok', message: '', lastOkAt: Date.now() });
    if (left && outbox.length === MAX_PER_REQUEST) again = true;
  } catch (err) {
    if (err.code === 'auth' || err.code === 'not_allowed') {
      setStatus({ state: 'error', message: err.message });
      stop();
      onAuthError(err);
      return;
    }
    if (err.code === 'offline') setStatus({ state: 'offline', message: err.message });
    else setStatus({ state: 'error', message: err.message || 'Synchronizácia zlyhala.' });
  }
}

function tick() {
  clearTimeout(pollTimer);
  if (!running || document.visibilityState !== 'visible') return;
  syncNow().finally(() => {
    clearTimeout(pollTimer);
    if (running && document.visibilityState === 'visible') pollTimer = setTimeout(tick, POLL_MS);
  });
}

function onVisibility() {
  if (document.visibilityState === 'visible') tick();
  else clearTimeout(pollTimer);
}

function onOnline() {
  tick();
}

function onOffline() {
  setStatus({ state: 'offline', message: 'Zmeny sa odošlú po pripojení.' });
}

export function start({ onAuthError: handler } = {}) {
  if (handler) onAuthError = handler;
  if (running) return;
  running = true;
  store.setLocalChangeHandler(() => {
    refreshPending();
    schedulePush();
  });
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  tick();
}

export function stop() {
  running = false;
  clearTimeout(pollTimer);
  schedulePush.cancel();
  document.removeEventListener('visibilitychange', onVisibility);
  window.removeEventListener('online', onOnline);
  window.removeEventListener('offline', onOffline);
}

/** Zahodí kurzor a pri ďalšej synchronizácii stiahne všetko odznova. */
export async function resyncAll() {
  await db.setMeta('lastSyncAt', 0);
  return syncNow();
}
