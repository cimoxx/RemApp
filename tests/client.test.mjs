// Testy čistých klientských modulov (bez prehliadača).
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, parseQuickInput, plural, capitalize } from '../js/util.js';
import { guessCategory, normalizeOrder, DEFAULT_ORDER } from '../js/categories.js';
import { mergeHistory, suggest, topItems } from '../js/history.js';

const DAY = 864e5;
const NOW = 1_800_000_000_000;

test('normalize ignoruje diakritiku, veľkosť písmen a medzery', () => {
  assert.equal(normalize('  Mlieko   1,5 %  '), 'mlieko 1,5 %');
  assert.equal(normalize('ŽEMĽA Rožok Ďatelina'), 'zemla rozok datelina');
});

test('rýchle zadanie množstva', () => {
  assert.deepEqual(parseQuickInput('2 rožky'), { name: 'rožky', qty: '2 ks' });
  assert.deepEqual(parseQuickInput('2x mlieko'), { name: 'mlieko', qty: '2 ks' });
  assert.deepEqual(parseQuickInput('500 g syr'), { name: 'syr', qty: '500 g' });
  assert.deepEqual(parseQuickInput('syr 500g'), { name: 'syr', qty: '500 g' });
  assert.deepEqual(parseQuickInput('jablká 1,5 kg'), { name: 'jablká', qty: '1,5 kg' });
  assert.deepEqual(parseQuickInput('Pivo 12'), { name: 'Pivo 12', qty: '' });
  assert.deepEqual(parseQuickInput('Mlieko 1,5 %'), { name: 'Mlieko 1,5 %', qty: '' });
  assert.deepEqual(parseQuickInput('7 days'), { name: 'days', qty: '7 ks' }); // presnú zhodu s históriou rieši list.js
});

test('odhad oddelenia zo slovníka', () => {
  const cases = {
    'Mlieko 1,5 %': 'mliecne', 'Rožky': 'pecivo', 'rožok': 'pecivo', 'Chlieb': 'pecivo', 'Banány': 'ovocie',
    'Kuracie prsia': 'maso', 'Šunka': 'maso', 'Zmrzlina': 'mrazene', 'Ryža': 'trvanlive', 'Mletá paprika': 'trvanlive',
    'Paprika': 'ovocie', 'Minerálka': 'napoje', 'Pivo': 'napoje', 'Šampón': 'drogeria', 'Toaletný papier': 'drogeria',
    'Prací prášok': 'domacnost', 'Vrecká na odpad': 'domacnost', 'Vajcia': 'mliecne', 'Xyz': 'ine'
  };
  for (const [name, cat] of Object.entries(cases)) assert.equal(guessCategory(name), cat, name);
});

test('poradie oddelení doplní chýbajúce a vyhodí neznáme', () => {
  const o = normalizeOrder(['napoje', 'zle', 'napoje', 'ovocie']);
  assert.equal(o.length, DEFAULT_ORDER.length);
  assert.deepEqual(o.slice(0, 3), ['napoje', 'ovocie', 'pecivo']);
});

const hist = [
  { key: 'mlieko 1,5 %', owner: '*', displayName: 'Mlieko 1,5 %', category: 'mliecne', count: 10, lastUsedAt: NOW - 2 * DAY, updatedAt: 5 },
  { key: 'mlieko 1,5 %', owner: 'ja', displayName: 'Mlieko 1,5 %', category: 'mliecne', lastNote: 'bez laktózy', count: 2, lastUsedAt: NOW - DAY, updatedAt: 9 },
  { key: 'mlynceky', owner: '*', displayName: 'Mlynčeky', count: 1, lastUsedAt: NOW - 60 * DAY, updatedAt: 1 },
  { key: 'kokosove mlieko', owner: '*', displayName: 'Kokosové mlieko', count: 30, lastUsedAt: NOW - 3 * DAY, updatedAt: 1 },
  { key: 'zmazane mlieko', owner: '*', displayName: 'X', count: 99, deleted: true, updatedAt: 1 }
];

test('história sa zlúči podľa kľúča a berie údaje z novšieho záznamu', () => {
  const m = mergeHistory(hist);
  assert.equal(m.size, 3);
  const mlieko = m.get('mlieko 1,5 %');
  assert.equal(mlieko.count, 12);
  assert.equal(mlieko.lastNote, 'bez laktózy');
});

test('návrhy: „mli“ ponúkne Mlieko 1,5 % a ignoruje diakritiku', () => {
  const m = mergeHistory(hist);
  const s = suggest('mli', m, { ref: NOW }).map(h => h.displayName);
  assert.equal(s[0], 'Mlieko 1,5 %');
  assert.ok(s.includes('Kokosové mlieko'), 'slovo v strede názvu');
  assert.deepEqual(suggest('MLYN', m, { ref: NOW }).map(h => h.displayName), ['Mlynčeky']);
  assert.deepEqual(suggest('mli', m, { ref: NOW, exclude: new Set(['mlieko 1,5 %']) })[0].displayName, 'Kokosové mlieko');
});

test('čipy: najčastejšie a nedávne položky, bez tých v zozname', () => {
  const m = mergeHistory(hist);
  const t = topItems(m, { ref: NOW, exclude: new Set(['kokosove mlieko']) }).map(h => h.key);
  assert.deepEqual(t, ['mlieko 1,5 %', 'mlynceky']);
});

test('skloňovanie a veľké písmeno', () => {
  assert.equal(plural(1, ['položka', 'položky', 'položiek']), 'položka');
  assert.equal(plural(3, ['položka', 'položky', 'položiek']), 'položky');
  assert.equal(plural(7, ['položka', 'položky', 'položiek']), 'položiek');
  assert.equal(capitalize('čaj'), 'Čaj');
});
