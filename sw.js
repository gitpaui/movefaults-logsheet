/***** Service worker: makes the app open with no signal *****/
const CACHE = 'mf-logsheet-v19'; // bump this (v2, v3...) every time you change any file
const OPTIONAL = ['logo-top.png', 'logo-footer.png']; // cached if present
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'config.js', 'manifest.webmanifest', 'icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL).then(() => Promise.all(OPTIONAL.map(f => c.add(f).catch(() => null)))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return; // API calls go straight to network
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(cached => {
      const network = fetch(req).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      }).catch(() => cached || caches.match('index.html'));
      return cached || network;
    })
  );
});
