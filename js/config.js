// Nastavenie nasadenia – doplň podľa README (krok 3 a 4).
export const API_URL = 'PASTE_APPS_SCRIPT_WEB_APP_URL';
export const GOOGLE_CLIENT_ID = 'PASTE_CLIENT_ID.apps.googleusercontent.com';

export const POLL_MS = 10_000;
export const PUSH_DEBOUNCE_MS = 500;
export const UNDO_MS = 5_000;
export const REQUEST_TIMEOUT_MS = 25_000;

export const isConfigured = () => !API_URL.startsWith('PASTE') && !GOOGLE_CLIENT_ID.startsWith('PASTE');
