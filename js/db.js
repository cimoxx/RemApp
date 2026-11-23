// Tenký promise obal nad IndexedDB.
// Úložiská: lists, items, history, prefs (dáta zo servera + lokálne zmeny),
// outbox (posledná neodoslaná verzia každého riadku), meta (kurzor synchronizácie a pod.).

const DB_NAME = 'remapp';
const DB_VERSION = 1;
let dbp = null;

export const STORES = ['lists', 'items', 'history', 'prefs', 'outbox', 'meta'];

export function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('lists')) db.createObjectStore('lists', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'id' }).createIndex('listId', 'listId');
      if (!db.objectStoreNames.contains('history')) db.createObjectStore('history', { keyPath: 'hk' });
      if (!db.objectStoreNames.contains('prefs')) db.createObjectStore('prefs', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'k' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Databázu blokuje iná otvorená karta RemApp.'));
  });
  return dbp;
}

const done = tx => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error || new Error('Transakcia zrušená'));
});

const result = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export async function getAll(store) {
  const db = await open();
  return result(db.transaction(store).objectStore(store).getAll());
}

export async function get(store, key) {
  const db = await open();
  return result(db.transaction(store).objectStore(store).get(key));
}

/** Viac operácií v jednej transakcii: ops = [{store, put}|{store, del}|{store, clear:true}]. */
export async function batch(ops) {
  if (!ops.length) return;
  const db = await open();
  const names = [...new Set(ops.map(o => o.store))];
  const tx = db.transaction(names, 'readwrite');
  for (const o of ops) {
    const s = tx.objectStore(o.store);
    if (o.clear) s.clear();
    else if (o.del !== undefined) s.delete(o.del);
    else s.put(o.put);
  }
  return done(tx);
}

export const put = (store, value) => batch([{ store, put: value }]);
export const del = (store, key) => batch([{ store, del: key }]);

export async function getMeta(key, fallback = null) {
  const r = await get('meta', key);
  return r ? r.value : fallback;
}

export const setMeta = (key, value) => put('meta', { key, value });

export async function clearAll() {
  await batch(STORES.map(store => ({ store, clear: true })));
}
