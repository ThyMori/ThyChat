// Service worker de ThyChat : coquille d'application hors ligne.
// Stratégie « réseau d'abord » pour les fichiers de l'application (les mises à jour
// publiées sur GitHub Pages apparaissent tout de suite), repli sur le cache hors ligne.
// Les appels à Supabase et aux CDN ne sont jamais interceptés ni mis en cache.

const VERSION = "1.1.0"; // géré par scripts/bump-version.mjs
const CACHE = `thychat-shell-${VERSION}`;
const SHELL = [
  "./",
  "index.html",
  "css/style.css",
  "js/app.js",
  "js/supabase.js",
  "js/chat.js",
  "js/themes.js",
  "js/install.js",
  "js/version.js",
  "js/config.js",
  "manifest.webmanifest",
  "icons/icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    // « no-cache » : toujours revalider auprès du serveur, pour ne jamais mélanger
    // d'anciens et de nouveaux fichiers (GitHub Pages met les fichiers en cache ~10 min).
    fetch(request, { cache: "no-cache" })
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match("index.html")))
  );
});
