// Testy backendu: autentifikácia, súkromie zoznamov, delta synchronizácia, LWW, história.
// Spustenie: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createBackend } from './gas-harness.mjs';

const A = 'ja@example.com';
const B = 'partner@example.com';
const id = () => crypto.randomUUID();

function setup() {
  const be = createBackend();
  be.setConfig({ allowed: [A, B] });
  const ta = be.login(A);
  const tb = be.login(B);
  const sync = (token, since = 0, changes = {}) => {
    be.tick(1000);
    const r = be.call({ action: 'sync', token, since, changes });
    assert.equal(r.ok, true, r.message);
    return r;
  };
  return { be, ta, tb, sync };
}

const list = (over = {}) => ({ id: id(), name: 'Lidl', shared: true, createdAt: 1, updatedAt: 1000, ...over });
const item = (listId, over = {}) => ({ id: id(), listId, name: 'Mlieko', qty: '2 ks', note: '', category: 'mliecne', checked: false, order: 1, createdAt: 1, updatedAt: 1000, ...over });

test('bez tokenu ani GET nevracia žiadne dáta', () => {
  const { be } = setup();
  assert.equal(be.call({ action: 'sync', since: 0 }).code, 'auth');
  assert.equal(be.call({ action: 'sync', token: 'x'.repeat(64), since: 0 }).code, 'auth');
  const get = JSON.parse(be.sandbox.doGet().text);
  assert.equal(get.ok, false);
  assert.equal(Object.keys(get).sort().join(), 'code,message,ok');
});

test('prihlásenie kontroluje aud, exp, email_verified a allowlist', () => {
  const { be } = setup();
  const bad = (over, code) => assert.equal(be.call({ action: 'login', credential: be.googleToken(A, over) }).code, code);
  bad({ aud: 'iny-client' }, 'login_failed');
  bad({ exp: String(Math.floor(be.now / 1000) - 10) }, 'login_failed');
  bad({ email_verified: 'false' }, 'login_failed');
  bad({ iss: 'evil.com' }, 'login_failed');
  assert.equal(be.call({ action: 'login', credential: be.googleToken('cudzi@example.com') }).code, 'not_allowed');
  assert.equal(be.call({ action: 'login', credential: 'neplatny' }).code, 'login_failed');
});

test('session token je v properties iba ako hash a odobratie z allowlistu platí okamžite', () => {
  const { be, tb, sync } = setup();
  assert.ok(!Object.values(be.props).some(v => v.includes(tb)) && !Object.keys(be.props).some(k => k.includes(tb)));
  sync(tb);
  be.setConfig({ allowed: [A] });
  assert.equal(be.call({ action: 'sync', token: tb, since: 0 }).code, 'not_allowed');
});

test('sedenie sa pri používaní predlžuje', () => {
  const { be, ta, sync } = setup();
  be.tick(20 * 864e5);
  sync(ta);
  be.tick(20 * 864e5);
  sync(ta);
});

test('odhlásenie zneplatní token', () => {
  const { be, ta } = setup();
  assert.equal(be.call({ action: 'logout', token: ta }).ok, true);
  assert.equal(be.call({ action: 'sync', token: ta, since: 0 }).code, 'auth');
});

test('súkromný zoznam partner nedostane – ani názov, ani položky, ani históriu (surová odpoveď API)', () => {
  const { be, ta, tb, sync } = setup();
  const priv = list({ name: 'TAJNY-DARCEK', shared: false });
  sync(ta, 0, { lists: [priv], items: [item(priv.id, { name: 'Prsten-XYZ', note: 'pre-zlaticko' })] });

  be.tick();
  const raw = be.post({ action: 'sync', token: tb, since: 0 }).text;
  for (const secret of ['TAJNY-DARCEK', 'Prsten-XYZ', 'prsten-xyz', 'pre-zlaticko', priv.id]) {
    assert.ok(!raw.includes(secret), `odpoveď pre partnera obsahuje „${secret}“`);
  }
  // vlastník všetko vidí
  const own = sync(ta, 0);
  assert.equal(own.lists.length, 1);
  assert.equal(own.items.length, 1);
  assert.equal(own.history[0].owner, A);
});

test('partner nemôže čítať ani meniť súkromný zoznam ani podvrhnúť vlastníka', () => {
  const { be, ta, tb, sync } = setup();
  const priv = list({ shared: false });
  const it = item(priv.id);
  sync(ta, 0, { lists: [priv], items: [it] });

  const r = sync(tb, 0, {
    lists: [{ ...priv, name: 'hack', shared: true, updatedAt: be.now + 5000 }],
    items: [{ ...it, name: 'hack', updatedAt: be.now + 5000 }, item(priv.id, { name: 'podstrčené' })]
  });
  assert.deepEqual(r.rejected.map(x => x.reason), ['forbidden', 'forbidden', 'forbidden']);
  assert.equal(r.lists.length, 0);
  assert.equal(r.items.length, 0);
  const own = sync(ta, 0);
  assert.equal(own.lists[0].name, 'Lidl');
  assert.equal(own.lists[0].shared, false);
  assert.equal(own.items.length, 1);
  assert.equal(own.items[0].name, 'Mlieko');

  // klient nemôže nastaviť cudzieho vlastníka
  const mine = list({ owner: A, shared: false, name: 'B-ov' });
  sync(tb, 0, { lists: [mine] });
  assert.ok(!JSON.stringify(sync(ta, 0)).includes('B-ov'));
});

test('zdieľaný zoznam: partner môže upravovať aj mazať, ale nie prepnúť zdieľanie', () => {
  const { be, ta, tb, sync } = setup();
  const l = list({ shared: true });
  const it = item(l.id);
  const a0 = sync(ta, 0, { lists: [l], items: [it] });

  const b0 = sync(tb, 0);
  assert.equal(b0.lists.length, 1);
  assert.equal(b0.lists[0].owner, A);
  sync(tb, b0.serverTime, {
    lists: [{ ...l, name: 'Lidl Petržalka', shared: false, updatedAt: be.now }],
    items: [{ ...it, checked: true, updatedAt: be.now }]
  });
  const a1 = sync(ta, a0.serverTime);
  assert.equal(a1.lists[0].name, 'Lidl Petržalka');
  assert.equal(a1.lists[0].shared, true, 'partner nesmie vypnúť zdieľanie');
  assert.equal(a1.items[0].checked, true);
  assert.equal(a1.items[0].updatedBy, B);
});

test('prepnutie na súkromný: partner dostane iba revoked id, po opätovnom zdieľaní všetky položky', () => {
  const { be, ta, tb, sync } = setup();
  const l = list({ shared: true, name: 'Chata' });
  const it = item(l.id, { name: 'Drevo' });
  sync(ta, 0, { lists: [l], items: [it] });
  const b0 = sync(tb, 0);
  assert.equal(b0.items.length, 1);

  const a1 = sync(ta, 0, { lists: [{ ...l, shared: false, updatedAt: be.now }] });
  // vlastník medzitým pridá do súkromného zoznamu položku
  sync(ta, a1.serverTime, { items: [item(l.id, { name: 'Prekvapenie' })] });

  const b1raw = be.post({ action: 'sync', token: tb, since: b0.serverTime }).text;
  const b1 = JSON.parse(b1raw);
  assert.deepEqual(b1.revoked, [l.id]);
  assert.equal(b1.lists.length, 0);
  assert.equal(b1.items.length, 0);
  assert.ok(!b1raw.includes('Chata') && !b1raw.includes('Prekvapenie') && !b1raw.includes('Drevo'));

  // znova zdieľať: partner dostane zoznam a VŠETKY jeho položky, aj staršie ako jeho kurzor
  be.tick();
  sync(ta, 0, { lists: [{ ...l, shared: true, updatedAt: be.now }] });
  const b2 = sync(tb, b1.serverTime);
  assert.equal(b2.lists.length, 1);
  assert.deepEqual(b2.items.map(i => i.name).sort(), ['Drevo', 'Prekvapenie']);
});

test('história: súkromný zoznam => iba vlastník, zdieľaný => „*“; počítadlo a posledné údaje drží server', () => {
  const { be, ta, tb, sync } = setup();
  const priv = list({ shared: false });
  const shared = list({ shared: true });
  sync(ta, 0, {
    lists: [priv, shared],
    items: [item(priv.id, { name: 'Tehotenský test' }), item(shared.id, { name: 'Mlieko 1,5 %', qty: '2 ks', note: 'bez laktózy' })]
  });
  sync(tb, 0, { items: [item(shared.id, { name: 'mlieko 1,5 %', qty: '1 l', note: '' })] });

  const hb = sync(tb, 0).history;
  assert.equal(hb.length, 1);
  assert.equal(hb[0].owner, '*');
  assert.equal(hb[0].key, 'mlieko 1,5 %');
  assert.equal(hb[0].count, 2);
  assert.equal(hb[0].lastQty, '1 l');
  const ha = sync(ta, 0).history;
  assert.equal(ha.length, 2);
  assert.ok(ha.some(h => h.owner === A && h.key === 'tehotensky test'));
});

test('zmazanie z histórie sa prenesie a nové pridanie históriu obnoví', () => {
  const { be, ta, tb, sync } = setup();
  const l = list();
  sync(ta, 0, { lists: [l], items: [item(l.id, { name: 'Rožky' })] });
  const b0 = sync(tb, 0);
  sync(ta, 0, { history: [{ key: 'rozky', owner: '*', deleted: true }] });
  const b1 = sync(tb, b0.serverTime);
  assert.equal(b1.history[0].deleted, true);
  sync(tb, 0, { items: [item(l.id, { name: 'rožky' })] });
  const h = sync(ta, 0).history.find(x => x.key === 'rozky');
  assert.equal(h.count, 1);
});

test('last-write-wins na úrovni položky a vynútené vrátenie aktuálneho stavu pri starej zmene', () => {
  const { be, ta, tb, sync } = setup();
  const l = list();
  const it = item(l.id, { updatedAt: 1000 });
  sync(ta, 0, { lists: [l], items: [it] });
  const b0 = sync(tb, 0);
  // A zmení neskôr, B pošle staršiu offline zmenu
  sync(ta, 0, { items: [{ ...it, qty: '5 ks', updatedAt: 3000 }] });
  const b1 = sync(tb, be.now + 10, { items: [{ ...it, qty: '9 ks', updatedAt: 2000 }] });
  assert.equal(b1.rejected[0].reason, 'stale');
  assert.equal(b1.items[0].qty, '5 ks', 'server musí vrátiť víťaznú verziu');
  assert.ok(b0);
});

test('offline zmena s neskorším odoslaním sa nestratí (kurzor je čas servera)', () => {
  const { be, ta, tb, sync } = setup();
  const l = list();
  sync(ta, 0, { lists: [l] });
  const b0 = sync(tb, 0);
  // A vytvorí položku „v minulosti“ (offline), odošle ju až teraz
  sync(ta, 0, { items: [item(l.id, { name: 'Offline', updatedAt: 5 })] });
  const b1 = sync(tb, b0.serverTime);
  assert.equal(b1.items[0].name, 'Offline');
});

test('soft delete sa prenesie a zmazanie zoznamu zmaže aj položky', () => {
  const { be, ta, tb, sync } = setup();
  const l = list();
  const it = item(l.id);
  sync(ta, 0, { lists: [l], items: [it] });
  const b0 = sync(tb, 0);
  sync(ta, 0, { lists: [{ ...l, deleted: true, updatedAt: be.now }] });
  const b1 = sync(tb, b0.serverTime);
  assert.equal(b1.lists[0].deleted, true);
  assert.equal(b1.items[0].deleted, true);
  // úplná synchronizácia už zmazané riadky neposiela
  const full = sync(tb, 0);
  assert.equal(full.lists.length + full.items.length, 0);
});

test('rýchla cesta: bez zápisov server nečíta hárky a kurzor neposúva', () => {
  const { be, ta, sync } = setup();
  const r0 = sync(ta, 0, { lists: [list()] });
  be.tick(5000);
  const r1 = be.call({ action: 'sync', token: ta, since: r0.serverTime + 1 });
  assert.equal(r1.serverTime, r0.serverTime + 1);
  assert.equal(r1.lists.length, 0);
});

test('čistenie tombstonov po 30 dňoch a vynútená úplná synchronizácia starých klientov', () => {
  const { be, ta, tb, sync } = setup();
  const l = list();
  const keep = list({ name: 'Ostáva' });
  sync(ta, 0, { lists: [l, keep], items: [item(l.id)] });
  const b0 = sync(tb, 0);
  sync(ta, 0, { lists: [{ ...l, deleted: true, updatedAt: be.now }] });
  be.tick(31 * 864e5);
  be.sandbox.purge();
  assert.equal(be.sheets.Lists.data.length, 2, 'hlavička + 1 živý zoznam');
  assert.equal(be.sheets.Items.data.length, 1, 'iba hlavička');
  // po 31 dňoch nečinnosti sedenie vypršalo
  assert.equal(be.call({ action: 'sync', token: tb, since: b0.serverTime }).code, 'auth');
  const b1 = sync(be.login(B), b0.serverTime);
  assert.equal(b1.full, true);
  assert.deepEqual(b1.lists.map(x => x.name), ['Ostáva']);
});

test('vzorce a čísla sa uložia ako text a hodiny klienta v budúcnosti sa orežú', () => {
  const { be, ta, sync } = setup();
  const l = list({ name: '=IMPORTXML("http://x")' });
  sync(ta, 0, { lists: [l], items: [item(l.id, { qty: '1,5', updatedAt: Date.now() + 10 * 864e5 })] });
  const r = sync(ta, 0);
  assert.equal(r.lists[0].name, '=IMPORTXML("http://x")');
  assert.equal(r.items[0].qty, '1,5');
  assert.ok(r.items[0].updatedAt <= be.now + 60_000);
});

test('preferencie sú súkromné pre každého používateľa', () => {
  const { ta, tb, sync } = setup();
  sync(ta, 0, { prefs: [{ key: 'categoryOrder', value: '["napoje"]', updatedAt: 10 }, { key: 'hack', value: 'x', updatedAt: 10 }] });
  assert.equal(sync(tb, 0).prefs.length, 0);
  assert.deepEqual(sync(ta, 0).prefs.map(p => p.key), ['categoryOrder']);
});
