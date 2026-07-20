const CACHE_NAME = "ai-flow-cache-v19";
const ASSETS = [
  "/",
  "/index.html",
  "/style.css",
  "/app.js",
  "/manifest.json"
];

// Install Event
self.addEventListener("install", (e) => {
  self.skipWaiting(); // activate immediately
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log("[Service Worker] Caching all static assets v19");
      return cache.addAll(ASSETS);
    })
  );
});

// Activate Event
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log("[Service Worker] Removing old cache", key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch Event
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Only intercept static assets listed in ASSETS or the root path
  const isAsset = ASSETS.some(asset => url.pathname === asset || url.pathname === "/");
  
  if (!isAsset) {
    // Let all API calls and external requests pass directly to the network
    return;
  }

  e.respondWith(
    caches.match(e.request).then((cachedResponse) => {
      return cachedResponse || fetch(e.request);
    })
  );
});

