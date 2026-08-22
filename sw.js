// 账务管家已切换为普通联网网页。
// 该脚本只负责让旧版本 Service Worker 自我注销并清理历史缓存。
self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    Promise.all([
      caches.keys().then(keys => Promise.all(keys.map(key => caches.delete(key)))),
      self.registration.unregister()
    ]).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  // 普通网页模式：所有请求直接走网络，不读取或写入缓存。
  event.respondWith(fetch(event.request));
});
