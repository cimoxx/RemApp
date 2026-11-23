// End-to-end test v prehliadači: dvaja používatelia, skutočný Code.gs v harness ako backend,
// Google prihlásenie nahradené stubom. Overuje UI aj to, že súkromné dáta nikdy neprídu partnerovi.
//
// Spustenie (vyžaduje Playwright s Chromiom):  node tests/e2e/two-users.mjs [adresár-na-screenshoty]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createBackend } from '../gas-harness.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHOTS = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'remapp-e2e'));
const API_URL = 'https://script.google.com/macros/s/E2E/exec';
const A = 'ja@example.com';
const B = 'partner@example.com';
fs.mkdirSync(SHOTS, { recursive: true });

// --- kópia appky s testovacou konfiguráciou + statický server
const SITE = fs.mkdtempSync(path.join(os.tmpdir(), 'remapp-site-'));
fs.cpSync(ROOT, SITE, { recursive: true, filter: src => !/[\\/](\.git|tests|tools)([\\/]|$)/.test(src.slice(ROOT.length)) });
fs.writeFileSync(path.join(SITE, 'js/config.js'), fs.readFileSync(path.join(ROOT, 'js/config.js'), 'utf8')
  .replace('PASTE_APPS_SCRIPT_WEB_APP_URL', API_URL)
  .replace('PASTE_CLIENT_ID.apps.googleusercontent.com', 'e2e-client.apps.googleusercontent.com'));

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const p = path.join(SITE, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const file = fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p, 'index.html') : p;
  if (!file.startsWith(SITE) || !fs.existsSync(file)) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://localhost:${server.address().port}/`;

const GIS_STUB = `
  window.google = { accounts: { id: {
    initialize(cfg) { window.__gis = cfg; },
    renderButton(el) {
      const b = document.createElement('button');
      b.id = 'fake-google'; b.textContent = 'Prihlásiť sa cez Google';
      b.onclick = () => window.__gis.callback({ credential: window.__TEST_CREDENTIAL });
      el.appendChild(b);
    },
    prompt() {}, disableAutoSelect() {}
  } } };`;

const be = createBackend({ realTime: true });
be.setConfig({ clientId: 'e2e-client.apps.googleusercontent.com', allowed: [A, B] });

const errors = [];
const browser = await chromium.launch();
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function user(email, { dark = false } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    hasTouch: true,
    colorScheme: dark ? 'dark' : 'light',
    locale: 'sk-SK'
  });
  const bodies = [];
  await ctx.route('https://accounts.google.com/gsi/client', r => r.fulfill({ contentType: 'text/javascript', body: GIS_STUB }));
  await ctx.route(API_URL, r => {
    const out = be.post(r.request().postData());
    bodies.push(out.text);
    return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: out.text });
  });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await ctx.addInitScript(cred => { window.__TEST_CREDENTIAL = cred; }, be.googleToken(email));
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${email}: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/fonts|ERR_FAILED/.test(m.text())) errors.push(`${email}: ${m.text()}`); });
  await page.goto(BASE);
  await page.click('#fake-google');
  await page.waitForSelector('.brand-name');
  return { ctx, page, bodies, email };
}

async function synced(page) {
  await sleep(700); // debounce odoslania
  for (let i = 0; i < 3; i++) {
    const resp = page.waitForResponse(API_URL, { timeout: 15000 });
    await page.click('.sync-pill');
    await resp;
    await page.waitForFunction(() => document.querySelector('.sync-pill')?.dataset.state !== 'syncing', null, { timeout: 15000 });
    if (await page.getAttribute('.sync-pill', 'data-state') === 'ok') return;
  }
  throw new Error('synchronizácia neskončila stavom OK');
}

async function addItems(page, names) {
  for (const n of names) {
    await page.fill('#add-input', n);
    await page.press('#add-input', 'Enter');
    await page.waitForFunction(() => document.querySelector('#add-input').value === '');
  }
}

const rowNames = page => page.$$eval('.item-row:not(.is-checked) .item-name', els => els.map(e => e.textContent));
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
const step = msg => console.log('✓', msg);

try {
  // ---------------------------------------------------------------- A
  const a = await user(A);
  await page_ok(a.page);
  await synced(a.page);
  await shot(a.page, '01-home-empty');
  step('A: prihlásenie a prázdny stav');

  await a.page.click('[data-act=new]');
  await a.page.fill('[name=name]', 'Lidl');
  assert.equal(await a.page.isChecked('[name=shared]'), true);
  await a.page.click('text=Vytvoriť zoznam');
  await a.page.waitForSelector('#add-input');
  const t0 = Date.now();
  await addItems(a.page, ['mlieko', '2 rožky', 'banány', 'šampón', 'kuracie prsia']);
  step(`A: 5 položiek pridaných Enterom (${Date.now() - t0} ms spolu)`);
  assert.deepEqual(await a.page.$$eval('.group-title', els => els.map(e => e.textContent.replace(/\d+$/, '').trim())),
    ['🥕 Ovocie a zelenina', '🥖 Pečivo', '🥛 Mliečne', '🥩 Mäso a údeniny', '🧴 Drogéria']);
  assert.equal(await a.page.textContent('.item-row:has-text("Rožky") .item-qty'), '2 ks');
  step('A: položky sú zoskupené podľa oddelení, množstvo z „2 rožky“');

  await a.page.tap('.item-row:has-text("Mlieko") .item-name');
  await a.page.waitForSelector('.item-row.is-checked:has-text("Mlieko")');
  step('A: ťuk odškrtol Mlieko → „V košíku“');

  const box = await a.page.locator('.item-row:has-text("Banány") .item-content').boundingBox();
  await a.page.mouse.move(box.x + box.width - 60, box.y + box.height / 2);
  await a.page.mouse.down();
  for (let i = 1; i <= 10; i++) await a.page.mouse.move(box.x + box.width - 60 - i * 25, box.y + box.height / 2);
  await a.page.mouse.up();
  await a.page.waitForSelector('.toast-action');
  assert.ok(!(await rowNames(a.page)).includes('Banány'));
  await a.page.click('.toast-action');
  await a.page.waitForSelector('.item-row:has-text("Banány")');
  step('A: swipe vľavo zmazal Banány, „Späť“ ich vrátil');

  await a.page.click('.item-row:has-text("Rožky") [data-act=edit]');
  await a.page.fill('[name=note]', 'celozrnné');
  await sleep(350);
  await shot(a.page, '04-item-editor');
  await a.page.click('.sheet button[type=submit]');
  await a.page.waitForSelector('.item-row:has-text("Rožky") .item-note');
  step('A: úprava položky (poznámka)');

  const longBox = await a.page.locator('.item-row:has-text("Šampón") .item-content').boundingBox();
  await a.page.mouse.move(longBox.x + 80, longBox.y + 20);
  await a.page.mouse.down();
  await sleep(650);
  await a.page.mouse.up();
  await a.page.waitForSelector('.sheet [name=qty]');
  await a.page.click('.sheet [data-qty="2 ks"]');
  await a.page.click('.sheet button[type=submit]');
  await a.page.waitForSelector('.item-row:has-text("Šampón") .item-qty');
  step('A: dlhé podržanie otvorilo úpravu');

  await synced(a.page);
  await shot(a.page, '02-list-light');

  await a.page.click('[data-act=back]');
  await a.page.click('[data-act=new]');
  await a.page.fill('[name=name]', 'Darček');
  await a.page.click('.sheet .switch');
  await a.page.click('text=Vytvoriť zoznam');
  await addItems(a.page, ['Prsteň zlatý']);
  await synced(a.page);
  await a.page.click('[data-act=back]');
  await a.page.waitForSelector('.list-card:has-text("Darček") .is-private');
  await shot(a.page, '03-home-lists');
  step('A: súkromný zoznam „Darček“ s položkou');

  // ---------------------------------------------------------------- B
  const b = await user(B, { dark: true });
  await synced(b.page);
  const bLists = await b.page.$$eval('.list-name', els => els.map(e => e.textContent));
  assert.deepEqual(bLists, ['Lidl']);
  for (const body of b.bodies) {
    for (const secret of ['Darček', 'Dar\\u010dek', 'Prste', 'prste']) assert.ok(!body.includes(secret), `B dostal „${secret}“ v odpovedi API`);
  }
  step(`B: vidí iba „Lidl“; ${b.bodies.length} odpovedí API neobsahuje nič zo súkromného zoznamu`);

  await b.page.click('.list-card:has-text("Lidl") [data-act=open]');
  await b.page.waitForSelector('.item-row:has-text("Rožky")');
  assert.equal(await b.page.textContent('.item-row:has-text("Rožky") .item-note'), 'celozrnné');
  await b.page.fill('#add-input', 'prs');
  await sleep(100);
  assert.equal(await b.page.isHidden('#suggest'), true, 'B nesmie dostať návrh zo súkromnej histórie');
  await b.page.fill('#add-input', 'kur');
  await sleep(100);
  assert.equal(await b.page.isHidden('#suggest'), true, 'položka, ktorá už v zozname čaká, sa nenavrhuje');
  await b.page.fill('#add-input', 'MLI');
  await b.page.waitForSelector('.suggest-row:has-text("Mlieko")');
  await b.page.fill('#add-input', '');
  await b.page.waitForSelector('.chip:has-text("Mlieko")');
  await b.page.tap('.chip:has-text("Mlieko")');
  await b.page.waitForSelector('.item-row:not(.is-checked):has-text("Mlieko")');
  step('B: návrhy zo spoločnej histórie, nie zo súkromnej; čip vrátil Mlieko z košíka');
  await addItems(b.page, ['jogurt']);
  await synced(b.page);
  await shot(b.page, '05-list-dark-partner');

  await b.page.click('[data-act=settings]');
  assert.equal(await b.page.$('.sheet .switch'), null, 'partner nesmie vidieť prepínač zdieľania');
  await b.page.click('.sheet-close');
  step('B: v nastaveniach zoznamu nie je prepínač zdieľania');

  // ---------------------------------------------------------------- zdieľanie off/on
  await synced(a.page);
  await a.page.click('.list-card:has-text("Lidl") [data-act=open]');
  await a.page.waitForSelector('.item-row:has-text("Jogurt")');
  step('A: vidí jogurt od B');
  const before = b.bodies.length;
  await a.page.click('[data-act=settings]');
  await a.page.click('.sheet .switch');
  await a.page.click('.sheet button[type=submit]');
  await synced(a.page);

  await synced(b.page);
  await b.page.waitForSelector('.brand-name'); // partner bol z obrazovky zoznamu presmerovaný domov
  assert.equal(await b.page.$$eval('.list-name', els => els.length), 0);
  const revokeBody = b.bodies.slice(before).find(x => x.includes('"revoked":["'));
  assert.ok(revokeBody, 'B musí dostať revoked');
  assert.ok(!revokeBody.includes('Lidl') && !revokeBody.includes('Jogurt'));
  assert.equal(await b.page.evaluate(() => new Promise(res => {
    const r = indexedDB.open('remapp');
    r.onsuccess = () => { const q = r.result.transaction('items').objectStore('items').getAll(); q.onsuccess = () => res(q.result.length); };
  })), 0, 'po zrušení zdieľania nesmú ostať položky ani v IndexedDB partnera');
  step('B: po vypnutí zdieľania zoznam zmizol aj z IndexedDB, odpoveď obsahovala iba id');

  await a.page.click('[data-act=settings]');
  await a.page.click('.sheet .switch');
  await a.page.click('.sheet button[type=submit]');
  await synced(a.page);
  await synced(b.page);
  await b.page.click('.list-card:has-text("Lidl") [data-act=open]');
  await b.page.waitForSelector('.item-row');
  assert.deepEqual((await rowNames(b.page)).sort(), ['Banány', 'Jogurt', 'Kuracie prsia', 'Mlieko', 'Rožky', 'Šampón']);
  step('B: po opätovnom zdieľaní má zoznam so všetkými položkami');

  // ---------------------------------------------------------------- offline
  await a.ctx.setOffline(true);
  await addItems(a.page, ['offline položka']);
  await a.page.waitForFunction(() => ['offline', 'pending'].includes(document.querySelector('.sync-pill').dataset.state));
  await a.page.reload();
  await a.page.waitForSelector('.item-row:has-text("Offline položka")');
  step('A: offline pridanie + reload z cache service workera');
  await a.ctx.setOffline(false);
  await synced(a.page);
  await synced(b.page);
  await b.page.waitForSelector('.item-row:has-text("Offline položka")');
  step('B: dostal položku pridanú offline');

  // ---------------------------------------------------------------- nastavenia
  await a.page.goto(BASE + '#/settings');
  await a.page.waitForSelector('.hist-row');
  await shot(a.page, '06-settings');
  const histA = await a.page.$$eval('.hist-name', els => els.map(e => e.textContent));
  assert.ok(histA.includes('Prsteň zlatý'));
  await a.page.click('.hist-row:has-text("Banány") [data-del]');
  await synced(a.page);
  await b.page.goto(BASE + '#/settings');
  await synced(b.page);
  const histB = await b.page.$$eval('.hist-name', els => els.map(e => e.textContent));
  assert.ok(!histB.includes('Banány') && !histB.includes('Prsteň zlatý'));
  step('Nastavenia: zmazanie z histórie sa prenieslo, súkromná história B nevidí');

  assert.deepEqual(errors, []);
  console.log(`\nVšetko OK. Screenshoty: ${SHOTS}`);
} catch (err) {
  console.error('\n✗', err.message);
  if (errors.length) console.error('Chyby v konzole:', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
  fs.rmSync(SITE, { recursive: true, force: true });
}

async function page_ok(page) {
  assert.equal(await page.isVisible('#auth-screen'), false);
}
