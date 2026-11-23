// Pomocné funkcie bez závislosti na DOM (dajú sa testovať v Node).

export function uuid() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Normalizovaný kľúč: bez diakritiky, malé písmená, jedna medzera. Rovnaká funkcia je v Code.gs (normKey_). */
export function normalize(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Prvé písmeno veľké, zvyšok ponechá. */
export function capitalize(s) {
  const t = String(s ?? '').trim();
  return t ? t[0].toLocaleUpperCase('sk') + t.slice(1) : t;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function debounce(fn, ms) {
  let t;
  const d = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  d.cancel = () => clearTimeout(t);
  return d;
}

// Hodiny zosynchronizované so serverom (kvôli last-write-wins medzi zariadeniami).
let clockOffset = 0;
export const now = () => Date.now() + clockOffset;
export function setServerTime(serverNow) {
  if (Number.isFinite(serverNow)) clockOffset = serverNow - Date.now();
}

export function haptic(ms = 12) {
  try {
    if (navigator.vibrate) navigator.vibrate(ms);
  } catch (_) { /* nepodporované */ }
}

const UNITS = {
  ks: 'ks', kus: 'ks', kusy: 'ks', kusov: 'ks', x: 'ks',
  kg: 'kg', g: 'g', dkg: 'dkg', l: 'l', ml: 'ml', dl: 'dl',
  bal: 'bal', balenie: 'bal', balenia: 'bal', baleni: 'bal'
};
const NUM = '(\\d+(?:[.,]\\d+)?)';
const UNIT = '(ks|kusy|kusov|kus|kg|dkg|g|ml|dl|l|balenia|balenie|baleni|bal|x)';
const RE_START = new RegExp(`^${NUM}\\s*${UNIT}?\\.?\\s+(.+)$`, 'i');
const RE_END = new RegExp(`^(.+?)\\s+${NUM}\\s*${UNIT}\\.?$`, 'i');

export function formatQty(num, unit) {
  const n = String(num).replace('.', ',');
  return `${n} ${UNITS[String(unit || 'ks').toLowerCase()] || 'ks'}`;
}

/**
 * Rýchle zadanie s množstvom: „2 rožky“, „2x mlieko“, „500 g syr“, „syr 500g“.
 * Číslo na konci sa berie iba s jednotkou, aby „Pivo 12“ ostalo pivom.
 */
export function parseQuickInput(text) {
  const t = String(text ?? '').trim().replace(/\s+/g, ' ');
  let m = t.match(RE_START);
  if (m && /\D/.test(m[3])) return { name: m[3].trim(), qty: formatQty(m[1], m[2]) };
  m = t.match(RE_END);
  if (m && /\D/.test(m[1])) return { name: m[1].trim(), qty: formatQty(m[2], m[3]) };
  return { name: t, qty: '' };
}

export function relativeTime(ts, ref = Date.now()) {
  if (!ts) return 'nikdy';
  const s = Math.round((ref - ts) / 1000);
  if (s < 10) return 'práve teraz';
  if (s < 60) return `pred ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `pred ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `pred ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? 'včera' : `pred ${d} dňami`;
}

/** Slovenské skloňovanie: plural(2, ['položka','položky','položiek']). */
export function plural(n, [one, few, many]) {
  if (n === 1) return one;
  if (n >= 2 && n <= 4) return few;
  return many;
}
