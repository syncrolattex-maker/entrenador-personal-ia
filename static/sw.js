const CACHE_NAME = "aaronfit-cache-v134";
const ASSETS = [
  "/",
  "/index.html",
  "/style.css",
  "/theme-stitch.css",
  "/chart-animations.js",
  "/app.js",
  "/manifest.json",
  "/fonts/geist-400.woff2",
  "/fonts/geist-500.woff2",
  "/fonts/geist-600.woff2"
];

// Install Event
self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

// Activate Event
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((key) => (key !== CACHE_NAME ? caches.delete(key) : null)))
    ).then(() => self.clients.claim())
  );
});

// Fetch Event: Network-First for app shell so UI/map updates apply immediately
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  const isAsset = ASSETS.some(asset => url.pathname === asset || url.pathname === "/");
  if (!isAsset) return;

  e.respondWith(
    fetch(e.request)
      .then((networkResp) => {
        const clone = networkResp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
        return networkResp;
      })
      .catch(() => caches.match(e.request))
  );
});
