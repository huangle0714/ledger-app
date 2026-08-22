const CACHE_NAME = 'ledger-pwa-v3';
const APP_FILES = [
  './',
  './index.html',
  './styles.css',
  './pwa-overrides.css',
  './app.js',
  './manifest.webmanifest',
  './icon.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request).then(response => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
      return response;
    }).catch(async () => {
      const cached = await caches.match(event.request);
      if (cached) return cached;

      // Safari may request the page URL itself while offline. Use the cached
      // app shell as a final navigation fallback instead of showing a network
      // error page.
      if (event.request.mode === 'navigate') {
        return caches.match('./index.html');
      }

      return Response.error();
    })
  );
});

