// Volania Apps Script backendu. POST s Content-Type text/plain = „jednoduchá“ požiadavka bez CORS preflightu.
import { API_URL, REQUEST_TIMEOUT_MS } from './config.js';

export class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export async function call(action, payload = {}, token = '') {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, token: token || undefined, ...payload }),
      redirect: 'follow',
      cache: 'no-store',
      signal: ctrl.signal
    });
  } catch (err) {
    if (!navigator.onLine) throw new ApiError('offline', 'Si offline. Zmeny sa odošlú po pripojení.');
    if (err.name === 'AbortError') throw new ApiError('network', 'Server neodpovedal včas.');
    throw new ApiError('network', 'Server je nedostupný.');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new ApiError('http', `Server vrátil chybu ${res.status}.`);
  let data;
  try {
    data = await res.json();
  } catch (_) {
    throw new ApiError('bad_response', 'Server vrátil neplatnú odpoveď. Skontroluj nasadenie Apps Scriptu (README, krok 3).');
  }
  if (!data || data.ok !== true) {
    throw new ApiError((data && data.code) || 'error', (data && data.message) || 'Neznáma chyba servera.');
  }
  return data;
}
