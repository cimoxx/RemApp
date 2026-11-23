/**
 * RemApp – backend (Google Apps Script web app nad Google Sheets).
 *
 * Nasadenie: Deploy → New deployment → Web app, Execute as: Me, Who has access: Anyone.
 * „Anyone“ je v poriadku, lebo KAŽDÁ akcia okrem prihlásenia vyžaduje platný session token
 * a email na allowliste. Bez tokenu endpoint nevráti žiadne dáta.
 *
 * Script Properties (Project Settings → Script Properties):
 *   CLIENT_ID       – OAuth Client ID (…apps.googleusercontent.com)
 *   ALLOWED_EMAILS  – povolené účty, oddelené čiarkou: ja@gmail.com, partner@gmail.com
 *   SPREADSHEET_ID  – voliteľné; ak je script viazaný na Sheet, netreba
 *
 * Prihlásenie: klient pošle Google ID token (JWT z Google Identity Services). Server ho overí
 * cez tokeninfo (podpis + exp), skontroluje aud == CLIENT_ID, iss, email_verified a allowlist
 * a vydá vlastný session token (platí SESSION_DAYS). V Script Properties je uložený iba jeho
 * SHA-256 hash. Allowlist sa kontroluje pri KAŽDOM requeste, takže odobratý email stratí
 * prístup okamžite. UrlFetch (tokeninfo) sa volá iba pri prihlásení.
 */

const BACKEND_VERSION = '1.0.0';
const SESSION_DAYS = 30;
const TOMBSTONE_DAYS = 30;
const MAX_CHANGES = 500;
const LOCK_WAIT_MS = 20000;
const CLOCK_SKEW_MS = 60 * 1000;

const SCHEMA = {
  Lists: ['id', 'name', 'owner', 'shared', 'createdAt', 'updatedAt', 'updatedBy', 'deleted', 'sharedChangedAt', 'serverAt'],
  Items: ['id', 'listId', 'name', 'qty', 'note', 'category', 'checked', 'checkedAt', 'order', 'createdAt', 'updatedAt', 'updatedBy', 'deleted', 'serverAt'],
  History: ['key', 'owner', 'displayName', 'category', 'lastQty', 'lastNote', 'count', 'lastUsedAt', 'updatedAt', 'deleted', 'serverAt'],
  Prefs: ['owner', 'key', 'value', 'updatedAt', 'serverAt']
};
const KEY_OF = {
  Lists: r => r.id,
  Items: r => r.id,
  History: r => r.owner + '|' + r.key,
  Prefs: r => r.owner + '|' + r.key
};
const BOOL_COLS = { shared: 1, deleted: 1, checked: 1 };
const NUM_COLS = { createdAt: 1, updatedAt: 1, sharedChangedAt: 1, serverAt: 1, checkedAt: 1, order: 1, count: 1, lastUsedAt: 1 };
const CATEGORIES = ['ovocie', 'pecivo', 'mliecne', 'maso', 'mrazene', 'trvanlive', 'napoje', 'drogeria', 'domacnost', 'ine'];
const PREF_KEYS = { categoryOrder: 1, listOrder: 1 };
const SHARED_OWNER = '*';

/* ------------------------------------------------------------------ HTTP */

function doGet() {
  // Žiadne dáta ani verzia bez prihlásenia.
  return json_({ ok: false, code: 'use_post', message: 'RemApp API prijíma iba POST požiadavky.' });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, code: 'bad_request', message: 'Neplatná požiadavka.' });
  }
  try {
    const action = String(req.action || '');
    if (action === 'login') return json_(login_(req.credential));
    const email = authenticate_(req.token);
    if (action === 'sync') return json_(sync_(email, req));
    if (action === 'logout') {
      logout_(req.token);
      return json_({ ok: true });
    }
    return json_({ ok: false, code: 'unknown_action', message: 'Neznáma akcia.' });
  } catch (err) {
    if (err && err.code) return json_({ ok: false, code: err.code, message: err.message });
    console.error(err && err.stack || err);
    return json_({ ok: false, code: 'server_error', message: 'Chyba servera: ' + (err && err.message || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/* ------------------------------------------------------------------ AUTH */

function allowedEmails_(props) {
  return String(props.ALLOWED_EMAILS || '')
    .split(/[\s,;]+/)
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

function login_(credential) {
  if (!credential || typeof credential !== 'string' || credential.length > 4096) {
    throw fail_('login_failed', 'Chýba prihlasovací token od Google.');
  }
  const store = PropertiesService.getScriptProperties();
  const props = store.getProperties();
  const clientId = String(props.CLIENT_ID || '').trim();
  if (!clientId) throw fail_('not_configured', 'Na serveri chýba CLIENT_ID v Script Properties.');
  if (!allowedEmails_(props).length) throw fail_('not_configured', 'Na serveri chýba ALLOWED_EMAILS v Script Properties.');

  const info = verifyIdToken_(credential);

  if (info.aud !== clientId) throw fail_('login_failed', 'Prihlasovací token nepatrí tejto aplikácii.');
  if (info.iss !== 'accounts.google.com' && info.iss !== 'https://accounts.google.com') {
    throw fail_('login_failed', 'Neplatný vydavateľ tokenu.');
  }
  if (!(Number(info.exp) * 1000 > Date.now())) throw fail_('login_failed', 'Platnosť prihlásenia vypršala. Skús to znova.');
  if (String(info.email_verified) !== 'true') throw fail_('login_failed', 'Email Google účtu nie je overený.');

  const email = String(info.email || '').toLowerCase();
  if (allowedEmails_(props).indexOf(email) < 0) {
    throw fail_('not_allowed', 'Účet ' + email + ' nemá prístup k RemApp.');
  }

  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  const exp = Date.now() + SESSION_DAYS * 864e5;
  store.setProperty(sessionKey_(token), JSON.stringify({ email: email, exp: exp }));
  return { ok: true, token: token, email: email, name: info.name || '', picture: info.picture || '', expiresAt: exp };
}

/**
 * Overí Google ID token cez tokeninfo (podpis + exp overí Google). Výsledok sa na pár minút
 * nacachuje v CacheService, aby opakované prihlásenie s tým istým tokenom nemíňalo UrlFetch kvótu.
 */
function verifyIdToken_(credential) {
  const cache = CacheService.getScriptCache();
  const cacheKey = 'idt_' + sha256_(credential);
  const cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);
  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential), {
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw fail_('login_failed', 'Google prihlásenie sa nepodarilo overiť. Skús to znova.');
  const info = JSON.parse(res.getContentText());
  const ttl = Math.min(300, Math.floor((Number(info.exp) * 1000 - Date.now()) / 1000));
  if (ttl > 0) cache.put(cacheKey, JSON.stringify(info), ttl);
  return info;
}

function sha256_(text) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text), Utilities.Charset.UTF_8);
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

function sessionKey_(token) {
  return 'sess_' + sha256_(token);
}

/** Vráti email prihláseného používateľa alebo vyhodí chybu `auth` / `not_allowed`. */
function authenticate_(token) {
  if (!token || typeof token !== 'string' || token.length > 128) throw fail_('auth', 'Prihlás sa, prosím.');
  const key = sessionKey_(token);
  const store = PropertiesService.getScriptProperties();
  // Jedno čítanie všetkých vlastností: sedenie aj allowlist sú vždy aktuálne
  // (odhlásenie alebo odobratie emailu platí okamžite, bez čakania na cache).
  const props = store.getProperties();
  const rec = props[key];
  if (!rec) throw fail_('auth', 'Prihlásenie vypršalo. Prihlás sa znova.');
  const s = JSON.parse(rec);
  if (!(s.exp > Date.now())) {
    store.deleteProperty(key);
    throw fail_('auth', 'Prihlásenie vypršalo. Prihlás sa znova.');
  }
  if (allowedEmails_(props).indexOf(s.email) < 0) throw fail_('not_allowed', 'Účet ' + s.email + ' už nemá prístup k RemApp.');
  // Kĺzavá platnosť: pri používaní sa sedenie predĺži, takže sa netreba každý mesiac prihlasovať.
  if (s.exp - Date.now() < SESSION_DAYS * 864e5 / 2) {
    store.setProperty(key, JSON.stringify({ email: s.email, exp: Date.now() + SESSION_DAYS * 864e5 }));
  }
  return s.email;
}

function logout_(token) {
  PropertiesService.getScriptProperties().deleteProperty(sessionKey_(token));
}

/* ------------------------------------------------------------------ SHEETS */

function spreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(ss, name) {
  const headers = SCHEMA[name];
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
    // Obyčajný text: „1,5“ ani „2“ sa nesmú prepísať na čísla, „=…“ na vzorec.
    sh.getRange(1, 1, sh.getMaxRows(), headers.length).setNumberFormat('@');
  }
  return sh;
}

function toCell_(col, v) {
  if (BOOL_COLS[col]) return v ? true : false;
  if (NUM_COLS[col]) return Number(v) || 0;
  const s = v == null ? '' : String(v);
  // Ochrana proti vloženiu vzorca do tabuľky.
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function fromCell_(col, v) {
  if (BOOL_COLS[col]) return v === true || v === 'TRUE' || v === 'true';
  if (NUM_COLS[col]) return Number(v) || 0;
  const s = v == null ? '' : String(v);
  return /^'[=+\-@]/.test(s) ? s.slice(1) : s;
}

function loadTable_(ss, name) {
  const headers = SCHEMA[name];
  const sh = sheet_(ss, name);
  const n = sh.getLastRow() - 1;
  const values = n > 0 ? sh.getRange(2, 1, n, headers.length).getValues() : [];
  const rows = values.map(r => {
    const o = {};
    headers.forEach((h, i) => { o[h] = fromCell_(h, r[i]); });
    return o;
  });
  const index = {};
  rows.forEach((r, i) => { index[KEY_OF[name](r)] = i; });
  return { name: name, sh: sh, rows: rows, index: index, origLen: rows.length, dirty: {} };
}

function tget_(t, key) {
  const i = t.index[key];
  return i === undefined ? null : t.rows[i];
}

function tput_(t, row) {
  const key = KEY_OF[t.name](row);
  let i = t.index[key];
  if (i === undefined) {
    i = t.rows.length;
    t.rows.push(row);
    t.index[key] = i;
  } else {
    t.rows[i] = row;
  }
  t.dirty[i] = true;
}

function rowValues_(name, r) {
  return SCHEMA[name].map(h => toCell_(h, r[h]));
}

function saveTable_(t) {
  const headers = SCHEMA[t.name];
  const idx = Object.keys(t.dirty).map(Number);
  if (!idx.length) return;
  const updates = idx.filter(i => i < t.origLen);
  if (updates.length > 25) {
    // Veľa zmien: jeden zápis celej oblasti je rýchlejší než veľa malých.
    if (t.origLen) t.sh.getRange(2, 1, t.origLen, headers.length).setValues(t.rows.slice(0, t.origLen).map(r => rowValues_(t.name, r)));
  } else {
    updates.forEach(i => t.sh.getRange(i + 2, 1, 1, headers.length).setValues([rowValues_(t.name, t.rows[i])]));
  }
  if (t.rows.length > t.origLen) {
    const added = t.rows.slice(t.origLen).map(r => rowValues_(t.name, r));
    const range = t.sh.getRange(t.origLen + 2, 1, added.length, headers.length);
    range.setNumberFormat('@');
    range.setValues(added);
  }
}

function loadAll_() {
  const ss = spreadsheet_();
  return {
    Lists: loadTable_(ss, 'Lists'),
    Items: loadTable_(ss, 'Items'),
    History: loadTable_(ss, 'History'),
    Prefs: loadTable_(ss, 'Prefs')
  };
}

/* ------------------------------------------------------------------ HELPERS */

function normKey_(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function str_(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}

function cleanId_(v) {
  const s = String(v || '');
  return /^[A-Za-z0-9-]{8,64}$/.test(s) ? s : '';
}

function ts_(v) {
  const n = Number(v);
  return isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Hodiny klienta nesmú byť ďaleko v budúcnosti, inak by jeho zápisy vyhrávali navždy. */
function clampTs_(v, now) {
  return Math.min(ts_(v) || now, now + CLOCK_SKEW_MS);
}

function category_(v) {
  return CATEGORIES.indexOf(v) >= 0 ? v : 'ine';
}

function canSeeList_(list, email) {
  return !!list && (list.owner === email || list.shared === true);
}

/* ------------------------------------------------------------------ SYNC */

/**
 * Jedna požiadavka = odoslanie zmien klienta + stiahnutie delty od `since`.
 * Kurzor je čas servera (`serverAt`), nie čas klienta, aby sa nestratili zmeny
 * odoslané neskôr z offline režimu. Konflikty rieši last-write-wins podľa `updatedAt`.
 */
function sync_(email, req) {
  const since = Math.max(0, ts_(req.since));
  const changes = req.changes && typeof req.changes === 'object' ? req.changes : {};
  const arr = k => (Array.isArray(changes[k]) ? changes[k].slice(0, MAX_CHANGES) : []);
  const lists = arr('lists'), items = arr('items'), history = arr('history'), prefs = arr('prefs');
  const hasChanges = lists.length + items.length + history.length + prefs.length > 0;

  const store = PropertiesService.getScriptProperties();
  const props = store.getProperties();
  const purgedBefore = ts_(props.PURGED_BEFORE);
  const full = since === 0 || since < purgedBefore;

  // Rýchla cesta bez čítania tabuliek: od `since` sa nič nezapísalo.
  // Kurzor vrátime nezmenený, takže prípadný súbežný zápis sa nestratí.
  if (!hasChanges && !full && ts_(props.LAST_WRITE_AT) < since) {
    return { ok: true, serverTime: since, now: Date.now(), full: false, lists: [], items: [], history: [], prefs: [], revoked: [], rejected: [] };
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) throw fail_('busy', 'Server je práve zaneprázdnený. Skúsim to znova.');
  try {
    const now = Date.now();
    const db = loadAll_();
    const ctx = { email: email, now: now, rejected: [], force: { lists: {}, items: {}, revoke: {} } };

    applyLists_(db, ctx, lists);
    applyItems_(db, ctx, items);
    applyHistory_(db, ctx, history);
    applyPrefs_(db, ctx, prefs);

    let wrote = false;
    Object.keys(db).forEach(k => {
      if (Object.keys(db[k].dirty).length) {
        saveTable_(db[k]);
        wrote = true;
      }
    });
    if (wrote) store.setProperty('LAST_WRITE_AT', String(now));

    const delta = buildDelta_(db, email, full ? 0 : since, ctx.force);
    delta.ok = true;
    delta.serverTime = now;
    delta.now = now;
    delta.full = full;
    delta.rejected = ctx.rejected;
    return delta;
  } finally {
    lock.releaseLock();
  }
}

function applyLists_(db, ctx, changes) {
  const email = ctx.email, now = ctx.now;
  changes.forEach(c => {
    const id = cleanId_(c && c.id);
    if (!id) return;
    const ex = tget_(db.Lists, id);
    const upd = clampTs_(c.updatedAt, now);

    if (!ex) {
      if (c.deleted) return;
      tput_(db.Lists, {
        id: id,
        name: str_(c.name, 60) || 'Zoznam',
        owner: email, // vlastníka určuje server, nie klient
        shared: c.shared === true,
        createdAt: ts_(c.createdAt) || now,
        updatedAt: upd,
        updatedBy: email,
        deleted: false,
        sharedChangedAt: 0,
        serverAt: now
      });
      return;
    }
    if (!canSeeList_(ex, email)) {
      ctx.rejected.push({ kind: 'lists', id: id, reason: 'forbidden' });
      ctx.force.revoke[id] = true;
      return;
    }
    if (upd <= ex.updatedAt) {
      ctx.rejected.push({ kind: 'lists', id: id, reason: 'stale' });
      ctx.force.lists[id] = true;
      return;
    }
    const next = Object.assign({}, ex, {
      name: str_(c.name, 60) || ex.name,
      updatedAt: upd,
      updatedBy: email,
      deleted: c.deleted === true,
      serverAt: now
    });
    // Zdieľanie môže meniť iba vlastník.
    if (ex.owner === email && typeof c.shared === 'boolean' && c.shared !== ex.shared) {
      next.shared = c.shared;
      next.sharedChangedAt = now;
    }
    tput_(db.Lists, next);

    if (next.deleted && !ex.deleted) {
      // Zmazaný zoznam => zmazať aj položky (aby ich neskôr vyčistilo čistenie tombstonov).
      db.Items.rows.forEach(it => {
        if (it.listId === id && !it.deleted) {
          tput_(db.Items, Object.assign({}, it, { deleted: true, updatedAt: Math.max(it.updatedAt, upd), updatedBy: email, serverAt: now }));
        }
      });
    }
  });
}

function applyItems_(db, ctx, changes) {
  const email = ctx.email, now = ctx.now;
  changes.forEach(c => {
    const id = cleanId_(c && c.id);
    if (!id) return;
    const ex = tget_(db.Items, id);
    const listId = ex ? ex.listId : cleanId_(c.listId);
    const list = tget_(db.Lists, listId);

    if (!canSeeList_(list, email)) {
      ctx.rejected.push({ kind: 'items', id: id, reason: 'forbidden' });
      if (list) ctx.force.revoke[listId] = true;
      return;
    }
    if (!ex && (list.deleted || c.deleted)) return;

    const upd = clampTs_(c.updatedAt, now);
    if (ex && upd <= ex.updatedAt) {
      ctx.rejected.push({ kind: 'items', id: id, reason: 'stale' });
      ctx.force.items[id] = true;
      return;
    }
    const name = str_(c.name, 80) || (ex && ex.name) || '';
    if (!name) return;
    const checked = c.checked === true;
    const next = {
      id: id,
      listId: listId,
      name: name,
      qty: str_(c.qty, 24),
      note: str_(c.note, 140),
      category: category_(c.category),
      checked: checked,
      checkedAt: checked ? (ex && ex.checked ? ex.checkedAt : (ts_(c.checkedAt) || now)) : 0,
      order: Number(c.order) || (ex ? ex.order : now),
      createdAt: ex ? ex.createdAt : (ts_(c.createdAt) || now),
      updatedAt: upd,
      updatedBy: email,
      deleted: c.deleted === true,
      serverAt: now
    };
    tput_(db.Items, next);

    if (!next.deleted) {
      const isNew = !ex;
      const metaChanged = ex && (ex.name !== next.name || ex.qty !== next.qty || ex.note !== next.note || ex.category !== next.category);
      if (isNew || metaChanged) recordHistory_(db, ctx, list, next, isNew);
    }
  });
}

/**
 * Históriu udržiava server: počítadlo by sa cez last-write-wins zlúčiť nedalo a server
 * zároveň zaručí, že položka zo súkromného zoznamu sa zapíše iba pod email vlastníka.
 */
function recordHistory_(db, ctx, list, item, isNew) {
  const key = normKey_(item.name);
  if (!key) return;
  const owner = list.shared ? SHARED_OWNER : list.owner;
  const ex = tget_(db.History, owner + '|' + key);
  if (!isNew && (!ex || ex.deleted)) return; // úprava nezmazanej položky nevracia zabudnutú históriu
  const alive = ex && !ex.deleted;
  tput_(db.History, {
    key: key,
    owner: owner,
    displayName: item.name,
    category: item.category,
    lastQty: item.qty,
    lastNote: item.note,
    count: (alive ? ex.count : 0) + (isNew ? 1 : 0),
    lastUsedAt: isNew ? ctx.now : (ex ? ex.lastUsedAt : ctx.now),
    updatedAt: ctx.now,
    deleted: false,
    serverAt: ctx.now
  });
}

/** Od klienta sa prijíma iba zmazanie záznamu histórie (z nastavení). */
function applyHistory_(db, ctx, changes) {
  changes.forEach(c => {
    if (!c || c.deleted !== true) return;
    const key = normKey_(c.key);
    const owner = c.owner === SHARED_OWNER ? SHARED_OWNER : ctx.email;
    const ex = tget_(db.History, owner + '|' + key);
    if (!ex || ex.deleted) return;
    tput_(db.History, Object.assign({}, ex, { deleted: true, count: 0, updatedAt: ctx.now, serverAt: ctx.now }));
  });
}

function applyPrefs_(db, ctx, changes) {
  changes.forEach(c => {
    const key = String(c && c.key || '');
    if (!PREF_KEYS[key]) return;
    const upd = clampTs_(c.updatedAt, ctx.now);
    const ex = tget_(db.Prefs, ctx.email + '|' + key);
    if (ex && upd <= ex.updatedAt) return;
    tput_(db.Prefs, { owner: ctx.email, key: key, value: str_(c.value, 5000), updatedAt: upd, serverAt: ctx.now });
  });
}

/**
 * Filtrovanie podľa oprávnení robí VÝHRADNE server. Partner nedostane zo súkromného zoznamu
 * nič – ani názov, ani položky, ani históriu. Keď vlastník zoznam prestane zdieľať, partner
 * dostane iba jeho id v `revoked`, aby si ho zmazal z lokálnej pamäte.
 */
function buildDelta_(db, email, since, force) {
  const full = since === 0;
  const out = { lists: [], items: [], history: [], prefs: [], revoked: [] };
  const visible = {};
  const becameShared = {};

  db.Lists.rows.forEach(l => {
    if (canSeeList_(l, email)) {
      visible[l.id] = true;
      if (full ? !l.deleted : (l.serverAt >= since || force.lists[l.id])) out.lists.push(publicRow_('Lists', l));
      if (!full && l.owner !== email && l.sharedChangedAt >= since) becameShared[l.id] = true;
    } else if (!full && (l.sharedChangedAt >= since || force.revoke[l.id])) {
      out.revoked.push(l.id);
    }
  });

  db.Items.rows.forEach(it => {
    if (!visible[it.listId]) return;
    const send = full ? !it.deleted : (it.serverAt >= since || becameShared[it.listId] || force.items[it.id]);
    if (send) out.items.push(publicRow_('Items', it));
  });

  db.History.rows.forEach(h => {
    if (h.owner !== SHARED_OWNER && h.owner !== email) return;
    if (full ? !h.deleted : h.serverAt >= since) out.history.push(publicRow_('History', h));
  });

  db.Prefs.rows.forEach(p => {
    if (p.owner !== email) return;
    if (full || p.serverAt >= since) out.prefs.push({ key: p.key, value: p.value, updatedAt: p.updatedAt });
  });
  return out;
}

function publicRow_(name, r) {
  const o = {};
  SCHEMA[name].forEach(h => { if (h !== 'serverAt') o[h] = r[h]; });
  return o;
}

/* ------------------------------------------------------------------ ÚDRŽBA */

/** Spusti raz ručne z editora: vytvorí hárky a týždenný trigger na čistenie. */
function setup() {
  const ss = spreadsheet_();
  Object.keys(SCHEMA).forEach(name => sheet_(ss, name));
  const has = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'purge');
  if (!has) ScriptApp.newTrigger('purge').timeBased().everyWeeks(1).onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(3).create();
  const props = PropertiesService.getScriptProperties().getProperties();
  console.log('Hárky sú pripravené. CLIENT_ID: ' + (props.CLIENT_ID ? 'OK' : 'CHÝBA') + ', ALLOWED_EMAILS: ' + (allowedEmails_(props).join(', ') || 'CHÝBA'));
}

/** Zmaže tombstony staršie ako TOMBSTONE_DAYS a expirované sedenia. Spúšťa sa triggerom. */
function purge() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) return;
  try {
    const now = Date.now();
    const cutoff = now - TOMBSTONE_DAYS * 864e5;
    const db = loadAll_();
    const liveLists = {};
    db.Lists.rows.forEach(l => { if (!(l.deleted && l.serverAt < cutoff)) liveLists[l.id] = true; });
    const keep = {
      Lists: r => liveLists[r.id],
      Items: r => liveLists[r.listId] && !(r.deleted && r.serverAt < cutoff),
      History: r => !(r.deleted && r.serverAt < cutoff),
      Prefs: () => true
    };
    Object.keys(keep).forEach(name => {
      const t = db[name];
      const kept = t.rows.filter(keep[name]);
      if (kept.length === t.rows.length) return;
      const width = SCHEMA[name].length;
      if (t.origLen) t.sh.getRange(2, 1, t.origLen, width).clearContent();
      if (kept.length) t.sh.getRange(2, 1, kept.length, width).setValues(kept.map(r => rowValues_(name, r)));
    });
    const store = PropertiesService.getScriptProperties();
    // Klienti so starším kurzorom mohli prísť o tombstony => pri ďalšej synchronizácii dostanú všetko.
    store.setProperty('PURGED_BEFORE', String(cutoff));
    store.setProperty('LAST_WRITE_AT', String(now));
    const props = store.getProperties();
    Object.keys(props).forEach(k => {
      if (k.indexOf('sess_') !== 0) return;
      try {
        if (!(JSON.parse(props[k]).exp > now)) store.deleteProperty(k);
      } catch (_) {
        store.deleteProperty(k);
      }
    });
  } finally {
    lock.releaseLock();
  }
}

/** Ručné odhlásenie všetkých zariadení (napr. pri strate telefónu). */
function revokeAllSessions() {
  const store = PropertiesService.getScriptProperties();
  Object.keys(store.getProperties()).forEach(k => { if (k.indexOf('sess_') === 0) store.deleteProperty(k); });
}
