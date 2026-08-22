const CACHE_NAME = 'ledger-pwa-v6';
const APP_FILES = [
  './',
  './index.html',
  './styles.css',
  './pwa-overrides.css',
  './app.js',
  './seed-data.js',
  './vendor/sql-wasm.js',
  './vendor/sql-wasm.wasm',
  './manifest.webmanifest',
  './icon.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      for (const file of APP_FILES) {
        try {
          await cache.add(file);
        } catch (error) {
          console.warn('Unable to precache', file, error);
        }
      }
    })
  );
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

  if (event.request.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html').then(cached => cached || fetch(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
      }
      return response;
    }))
  );
});
