// Prihlásenie cez Google Identity Services.
// Google ID token (JWT) sa pošle backendu iba raz; ten ho overí a vydá vlastný session token
// (30 dní, predlžuje sa pri používaní). Ten sa posiela pri každej požiadavke.
import { GOOGLE_CLIENT_ID } from './config.js';
import { call } from './api.js';

const SESSION_KEY = 'remapp_session_v1';

export function getSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    return s && s.token && s.email ? s : null;
  } catch (_) {
    return null;
  }
}

export const getToken = () => (getSession() || {}).token || '';

function saveSession(s) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
}

export function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

let gisReady = false;
let handlers = { onLogin: () => {}, onStatus: () => {} };

function whenGis() {
  return new Promise(resolve => {
    if (window.google?.accounts?.id) return resolve();
    const t = setInterval(() => {
      if (window.google?.accounts?.id) {
        clearInterval(t);
        resolve();
      }
    }, 100);
  });
}

/**
 * Zobrazí tlačidlo „Prihlásiť sa cez Google“ do `holder` a skúsi tiché prihlásenie (auto_select).
 */
export async function showSignIn(holder, { onLogin, onStatus }) {
  handlers = { onLogin, onStatus };
  if (!navigator.onLine) onStatus('Na prihlásenie potrebuješ internet.', 'warn');
  await whenGis();
  if (!gisReady) {
    google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: onCredential,
      auto_select: true,
      cancel_on_tap_outside: false,
      use_fedcm_for_prompt: true,
      itp_support: true,
      context: 'signin'
    });
    gisReady = true;
  }
  holder.innerHTML = '';
  google.accounts.id.renderButton(holder, {
    theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'filled_black' : 'outline',
    size: 'large',
    shape: 'pill',
    text: 'signin_with',
    locale: 'sk',
    width: 280
  });
  google.accounts.id.prompt();
}

async function onCredential(response) {
  if (!response?.credential) return;
  handlers.onStatus('Overujem účet…', 'info');
  try {
    const r = await call('login', { credential: response.credential });
    const session = { token: r.token, email: r.email, name: r.name, picture: r.picture, expiresAt: r.expiresAt };
    saveSession(session);
    handlers.onStatus('', 'info');
    handlers.onLogin(session);
  } catch (err) {
    handlers.onStatus(err.message || 'Prihlásenie sa nepodarilo.', 'error');
  }
}

export async function signOut() {
  const token = getToken();
  clearSession();
  try {
    window.google?.accounts?.id?.disableAutoSelect();
  } catch (_) { /* GIS nemusí byť načítané */ }
  if (token) call('logout', {}, token).catch(() => {});
}
