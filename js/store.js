// Stav aplikácie v pamäti + IndexedDB. Každá lokálna zmena sa hneď prejaví v UI,
// uloží do IndexedDB a do outboxu, odkiaľ ju odošle sync.js.
import * as db from './db.js';
import { uuid, now, normalize, capitalize } from './util.js';
import { guessCategory, normalizeOrder } from './categories.js';
import { mergeHistory } from './history.js';

export const SHARED = '*';

export const state = {
  me: '',
  lists: new Map(),
  items: new Map(),
  history: new Map(), // kľúč hk = owner|key
  prefs: new Map()
};

const listeners = new Set();
let emitQueued = false;
let mergedCache = null;
let onLocalChange = () => {};

export const setLocalChangeHandler = fn => { onLocalChange = fn; };
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  mergedCache = null;
  if (emitQueued) return;
  emitQueued = true;
  queueMicrotask(() => {
    emitQueued = false;
    for (const fn of listeners) fn();
  });
}

const KEY = {
  lists: r => r.id,
  items: r => r.id,
  history: r => r.hk,
  prefs: r => r.key
};

export async function load() {
  const [lists, items, history, prefs] = await Promise.all(['lists', 'items', 'history', 'prefs'].map(db.getAll));
  state.lists = new Map(lists.map(r => [r.id, r]));
  state.items = new Map(items.map(r => [r.id, r]));
  state.history = new Map(history.map(r => [r.hk, r]));
  state.prefs = new Map(prefs.map(r => [r.key, r]));
  emit();
}

export function reset() {
  for (const k of ['lists', 'items', 'history', 'prefs']) state[k] = new Map();
  emit();
}

/** Lokálna zmena: pamäť → UI → IndexedDB + outbox → odoslanie. */
async function commit(kind, row, extraOps = []) {
  const key = KEY[kind](row);
  state[kind].set(key, row);
  emit();
  await db.batch([
    { store: kind, put: row },
    { store: 'outbox', put: { k: `${kind}:${key}`, kind, row: outboxRow(kind, row) } },
    ...extraOps
  ]);
  onLocalChange();
}

function outboxRow(kind, row) {
  if (kind === 'history') return { key: row.key, owner: row.owner, deleted: true, updatedAt: row.updatedAt };
  if (kind === 'prefs') return { key: row.key, value: row.value, updatedAt: row.updatedAt };
  const { hk, ...rest } = row;
  return rest;
}

/* ---------------------------------------------------------------- PREFS */

export function getPref(key, fallback = null) {
  const r = state.prefs.get(key);
  if (!r) return fallback;
  try {
    return JSON.parse(r.value);
  } catch (_) {
    return fallback;
  }
}

export const setPref = (key, value) => commit('prefs', { key, value: JSON.stringify(value), updatedAt: now() });

export const categoryOrder = () => normalizeOrder(getPref('categoryOrder'));

/* ---------------------------------------------------------------- LISTS */

export function sortedLists() {
  const order = getPref('listOrder', []);
  const pos = new Map(order.map((id, i) => [id, i]));
  return [...state.lists.values()]
    .filter(l => !l.deleted)
    .sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9) || a.createdAt - b.createdAt);
}

export const getList = id => {
  const l = state.lists.get(id);
  return l && !l.deleted ? l : null;
};

export const isOwner = list => !!list && list.owner === state.me;

export async function createList(name, shared) {
  const t = now();
  const row = {
    id: uuid(),
    name: capitalize(name).slice(0, 60) || 'Nový zoznam',
    owner: state.me,
    shared: !!shared,
    createdAt: t,
    updatedAt: t,
    updatedBy: state.me,
    deleted: false,
    sharedChangedAt: 0
  };
  await commit('lists', row);
  return row;
}

export async function updateList(id, patch) {
  const l = state.lists.get(id);
  if (!l) return;
  const next = { ...l, ...patch, updatedAt: now(), updatedBy: state.me };
  if (!isOwner(l)) next.shared = l.shared; // zdieľanie mení iba vlastník (server to vynúti tiež)
  if ('name' in patch) next.name = capitalize(patch.name).slice(0, 60) || l.name;
  await commit('lists', next);
}

export async function deleteList(id) {
  const l = state.lists.get(id);
  if (!l) return;
  // Položky zmaže server kaskádovo; lokálne ich len skryjeme.
  const ops = [];
  for (const it of state.items.values()) {
    if (it.listId === id && !it.deleted) {
      const d = { ...it, deleted: true };
      state.items.set(it.id, d);
      ops.push({ store: 'items', put: d });
    }
  }
  await commit('lists', { ...l, deleted: true, updatedAt: now(), updatedBy: state.me }, ops);
}

export async function moveList(id, dir) {
  const ids = sortedLists().map(l => l.id);
  const i = ids.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  await setPref('listOrder', ids);
}

/* ---------------------------------------------------------------- ITEMS */

export function itemsOf(listId) {
  const out = [];
  for (const it of state.items.values()) if (it.listId === listId && !it.deleted) out.push(it);
  return out;
}

export const pendingCount = listId => itemsOf(listId).filter(i => !i.checked).length;

export function mergedHistory() {
  if (!mergedCache) mergedCache = mergeHistory(state.history.values());
  return mergedCache;
}

/**
 * Pridá položku. Ak už v zozname čaká, nič nepridá; ak je v košíku, vráti ju späť.
 * Oddelenie, množstvo a poznámku doplní z histórie, inak oddelenie odhadne zo slovníka.
 */
export async function addItem(listId, input) {
  const list = getList(listId);
  const name = capitalize(String(input.name || '').trim()).slice(0, 80);
  if (!list || !name) return { status: 'invalid' };
  const key = normalize(name);
  const h = mergedHistory().get(key);

  const existing = itemsOf(listId).find(i => normalize(i.name) === key);
  if (existing && !existing.checked) return { status: 'exists', item: existing };
  if (existing) {
    const patch = { checked: false, checkedAt: 0, order: now() };
    if (input.qty) patch.qty = input.qty;
    await updateItem(existing.id, patch);
    return { status: 'restored', item: state.items.get(existing.id) };
  }

  const t = now();
  const row = {
    id: uuid(),
    listId,
    name: h && normalize(h.displayName) === key ? h.displayName : name,
    qty: input.qty || (h ? h.lastQty : '') || '',
    note: input.note ?? (h ? h.lastNote : '') ?? '',
    category: input.category || (h && h.category) || guessCategory(name),
    checked: false,
    checkedAt: 0,
    order: t,
    createdAt: t,
    updatedAt: t,
    updatedBy: state.me,
    deleted: false
  };
  await commit('items', row, localHistory(list, row, true));
  return { status: 'added', item: row };
}

export async function updateItem(id, patch) {
  const it = state.items.get(id);
  if (!it) return;
  const next = { ...it, ...patch, updatedAt: now(), updatedBy: state.me };
  if ('name' in patch) next.name = capitalize(String(patch.name).trim()).slice(0, 80) || it.name;
  if ('checked' in patch) next.checkedAt = patch.checked ? (it.checked ? it.checkedAt : now()) : 0;
  const metaChanged = ['name', 'qty', 'note', 'category'].some(k => next[k] !== it[k]);
  const list = state.lists.get(it.listId);
  await commit('items', next, metaChanged && list ? localHistory(list, next, false) : []);
}

export const toggleItem = id => {
  const it = state.items.get(id);
  return it ? updateItem(id, { checked: !it.checked }) : undefined;
};

/** Zmaže položku a vráti funkciu na vrátenie zmeny. */
export async function deleteItem(id) {
  await updateItem(id, { deleted: true });
  return () => updateItem(id, { deleted: false });
}

export async function clearChecked(listId) {
  const ids = itemsOf(listId).filter(i => i.checked).map(i => i.id);
  for (const id of ids) await updateItem(id, { deleted: true });
  return async () => {
    for (const id of ids) await updateItem(id, { deleted: false });
  };
}

/* ---------------------------------------------------------------- HISTORY */

/**
 * Okamžitá lokálna kópia toho, čo urobí server (recordHistory_ v Code.gs), aby návrhy
 * fungovali aj offline. Pri ďalšej synchronizácii ju prepíše verzia zo servera.
 */
function localHistory(list, item, isNew) {
  const key = normalize(item.name);
  const owner = list.shared ? SHARED : list.owner;
  const hk = `${owner}|${key}`;
  const ex = state.history.get(hk);
  if (!isNew && (!ex || ex.deleted)) return [];
  const alive = ex && !ex.deleted;
  const t = now();
  const row = {
    hk, key, owner,
    displayName: item.name,
    category: item.category,
    lastQty: item.qty,
    lastNote: item.note,
    count: (alive ? ex.count : 0) + (isNew ? 1 : 0),
    lastUsedAt: isNew ? t : (ex ? ex.lastUsedAt : t),
    updatedAt: t,
    deleted: false
  };
  state.history.set(hk, row);
  return [{ store: 'history', put: row }];
}

/** Zmaže položku z histórie (spoločnú aj vlastnú s rovnakým názvom). */
export async function deleteHistory(key) {
  for (const r of [...state.history.values()]) {
    if (r.key === key && !r.deleted && (r.owner === SHARED || r.owner === state.me)) {
      await commit('history', { ...r, deleted: true, count: 0, updatedAt: now() });
    }
  }
}

/* ---------------------------------------------------------------- SERVER */

/**
 * Zlúči odpoveď servera. Lokálna neodoslaná zmena, ktorá je novšia než verzia zo servera,
 * má prednosť (odošle sa pri ďalšej synchronizácii).
 */
export async function applyServer(resp) {
  const ops = [];
  const outbox = new Map((await db.getAll('outbox')).map(e => [e.k, e]));

  if (resp.full) {
    for (const kind of ['lists', 'items', 'history', 'prefs']) {
      state[kind].clear();
      ops.push({ store: kind, clear: true });
    }
  }

  for (const listId of resp.revoked || []) {
    // Zoznam prestal byť zdieľaný: odstrániť ho aj s položkami a neodoslanými zmenami.
    state.lists.delete(listId);
    ops.push({ store: 'lists', del: listId }, { store: 'outbox', del: `lists:${listId}` });
    outbox.delete(`lists:${listId}`);
    for (const it of [...state.items.values()]) {
      if (it.listId !== listId) continue;
      state.items.delete(it.id);
      ops.push({ store: 'items', del: it.id }, { store: 'outbox', del: `items:${it.id}` });
      outbox.delete(`items:${it.id}`);
    }
  }

  const take = (kind, row) => {
    const key = KEY[kind](row);
    const pending = outbox.get(`${kind}:${key}`);
    if (pending && (kind === 'history' || (pending.row.updatedAt || 0) > (row.updatedAt || 0))) return;
    state[kind].set(key, row);
    ops.push({ store: kind, put: row });
  };
  for (const r of resp.lists || []) take('lists', r);
  for (const r of resp.items || []) take('items', r);
  for (const r of resp.history || []) take('history', { ...r, hk: `${r.owner}|${r.key}` });
  for (const r of resp.prefs || []) take('prefs', r);

  // Neodoslané lokálne zmeny musia ostať viditeľné aj po úplnej synchronizácii.
  for (const e of outbox.values()) {
    if (e.kind !== 'lists' && e.kind !== 'items' && e.kind !== 'prefs') continue;
    const key = KEY[e.kind](e.row);
    const cur = state[e.kind].get(key);
    if (!cur || (cur.updatedAt || 0) < (e.row.updatedAt || 0)) {
      state[e.kind].set(key, e.row);
      ops.push({ store: e.kind, put: e.row });
    }
  }

  await db.batch(ops);
  emit();
}
