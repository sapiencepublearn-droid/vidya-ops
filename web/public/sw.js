const SHELL = 'ops-shell-v1';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/index.html'])));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never serve API data from cache. A stale task list is confusing;
  // a cached check-in would be wrong.
  if (
  url.origin !== self.location.origin ||
  url.pathname.startsWith('/api/') ||
  e.request.method !== 'GET'
) return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request).then((r) => r || caches.match('/index.html')))
  );
});
