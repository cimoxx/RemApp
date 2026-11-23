// Service worker RemApp.
// App shell (HTML, CSS, JS, ikony) = cache-first, verzia cache sa odvodzuje od APP_VERSION.
// Dáta idú cez POST na Apps Script (SW ich nekešuje – offline režim rieši IndexedDB + outbox).
// Ostatné GET požiadavky mimo app shellu = network-first s návratom ku cache.
importScripts('./js/version.js');

const SHELL_CACHE = `remapp-shell-v${self.APP_VERSION}`;
const RUNTIME_CACHE = 'remapp-runtime-v1';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './js/version.js',
  './js/config.js',
  './js/changelog.js',
  './js/util.js',
  './js/categories.js',
  './js/history.js',
  './js/db.js',
  './js/store.js',
  './js/api.js',
  './js/auth.js',
  './js/sync.js',
  './js/ui.js',
  './js/views/home.js',
  './js/views/list.js',
  './js/views/list-form.js',
  './js/views/item-editor.js',
  './js/views/settings.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', event => {
  // Bez skipWaiting: nová verzia čaká, kým používateľ v appke ťukne na „Načítať“.
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL_CACHE && k !== RUNTIME_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

async function cacheFirst(request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  return cached || fetch(request);
}

async function networkFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const res = await fetch(request);
    if (res.ok || res.type === 'opaque') cache.put(request, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  const fresh = fetch(request)
    .then(res => {
      if (res.ok || res.type === 'opaque') cache.put(request, res.clone());
      return res;
    })
    .catch(() => cached);
  return cached || fresh;
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return; // API (POST) ide vždy priamo na sieť
  const url = new URL(request.url);

  if (request.mode === 'navigate' && url.origin === self.location.origin) {
    event.respondWith(caches.match('./index.html').then(r => r || fetch(request)));
  } else if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request));
  } else if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(staleWhileRevalidate(request));
  } else {
    event.respondWith(networkFirst(request));
  }
});
