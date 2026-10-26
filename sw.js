/* Mission Révision — service worker (réseau d'abord, cache si hors ligne) */
const CACHE = 'mr-shell-v8';
const SHELL = [
  './', './index.html', './app.js', './create.js', './styles.css', './manifest.webmanifest',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
  './exemples/demo.json', './exemples/sciences-masse-volume.json',
  './exemples/francais-classes-de-mots.json', './exemples/images/cube-arete-3cm.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('mr-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // Apps Script : jamais intercepté
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await Promise.race([
        // « no-cache » : on revalide toujours auprès de GitHub Pages (sinon le cache HTTP
        // du navigateur peut servir l'ancienne version jusqu'à 10 minutes après une mise à jour)
        fetch(req, { cache: 'no-cache' }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
      ]);
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      return (await cache.match(req, { ignoreSearch: true })) ||
             (req.mode === 'navigate' ? cache.match('./index.html') : Response.error());
    }
  })());
});
