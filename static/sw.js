// Keeps the app shell available offline (and quick to open on a phone).
// Network first, so a new version is picked up as soon as there's a connection;
// the cached copy is only used when the network fails. API calls are never cached.
const CACHE = 'forkcast-v1';
const SHELL = [
  '/', '/styles.css', '/js/app.js', '/js/plan.js', '/js/recipes.js', '/js/shop.js', '/js/me.js', '/js/foods.js',
  '/shared/units.js', '/shared/ingredients.js', '/shared/shopping.js', '/manifest.json', '/icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' }) // revalidate, so a new version shows up right away
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/')))
  );
});
