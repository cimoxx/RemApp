// História nakupovaných položiek: zlúčenie spoločnej a vlastnej histórie, návrhy a rýchle čipy.
import { normalize } from './util.js';

const DAY = 864e5;

/**
 * Zlúči riadky histórie podľa kľúča. Spoločná („*“) aj vlastná história toho istého názvu sa
 * spočítajú; meno, množstvo, poznámka a oddelenie sa vezmú z naposledy upraveného záznamu.
 */
export function mergeHistory(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!r || r.deleted || !r.key) continue;
    const cur = map.get(r.key);
    if (!cur) {
      map.set(r.key, { ...r, count: Number(r.count) || 0, sources: [r] });
      continue;
    }
    const newer = (r.updatedAt || 0) > (cur.updatedAt || 0);
    const merged = {
      ...(newer ? r : cur),
      count: cur.count + (Number(r.count) || 0),
      lastUsedAt: Math.max(cur.lastUsedAt || 0, r.lastUsedAt || 0),
      updatedAt: Math.max(cur.updatedAt || 0, r.updatedAt || 0),
      sources: [...cur.sources, r]
    };
    map.set(r.key, merged);
  }
  return map;
}

/** Skóre = frekvencia tlmená časom od posledného nákupu + bonus za nedávny nákup. */
export function score(h, ref = Date.now()) {
  const days = Math.max(0, (ref - (h.lastUsedAt || 0)) / DAY);
  return (h.count || 0) * Math.pow(0.5, days / 30) + 2 * Math.pow(0.5, days / 5);
}

/**
 * Návrhy pri písaní. Ignoruje diakritiku aj veľkosť písmen.
 * Poradie: začína dotazom > niektoré slovo začína dotazom > obsahuje dotaz; v rámci skupiny skóre.
 */
export function suggest(query, merged, { exclude = new Set(), limit = 5, ref = Date.now() } = {}) {
  const q = normalize(query);
  if (!q) return [];
  const out = [];
  for (const h of merged.values()) {
    if (exclude.has(h.key)) continue;
    let tier;
    if (h.key.startsWith(q)) tier = 0;
    else if (h.key.split(/[\s\-/]+/).some(w => w.startsWith(q))) tier = 1;
    else if (q.length >= 3 && h.key.includes(q)) tier = 2;
    else continue;
    out.push({ h, tier, s: score(h, ref) });
  }
  out.sort((a, b) => a.tier - b.tier || b.s - a.s || a.h.key.localeCompare(b.h.key));
  return out.slice(0, limit).map(x => x.h);
}

/** Najčastejšie položky na rýchle pridanie (bez tých, ktoré už v zozname čakajú). */
export function topItems(merged, { exclude = new Set(), limit = 12, ref = Date.now() } = {}) {
  return [...merged.values()]
    .filter(h => !exclude.has(h.key))
    .map(h => ({ h, s: score(h, ref) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map(x => x.h);
}
