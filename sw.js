// Service worker de ThyChat : coquille d'application hors ligne.
// Stratégie « réseau d'abord » pour les fichiers de l'application (les mises à jour
// publiées sur GitHub Pages apparaissent tout de suite), repli sur le cache hors ligne.
// Les appels à Supabase ne sont jamais interceptés ; seule la bibliothèque Supabase (CDN) est gardée pour le hors-ligne.
// Gère aussi la réception des notifications push.

const VERSION = "3.41.0"; // géré par scripts/bump-version.mjs
const CACHE = `thychat-shell-${VERSION}`;
const CDN_CACHE = "thychat-cdn"; // bibliothèque Supabase (CDN) : gardée pour pouvoir démarrer sans réseau
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
  "js/notify.js",
  "js/push.js",
  "js/profile.js",
  "js/images.js",
  "js/offline.js",
  "js/documents.js",
  "js/config.js",
  "manifest.webmanifest",
  "icons/icon.svg",
  "icons/mark.svg",
  "fonts/caveat-700.woff2",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE && key !== CDN_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // La bibliothèque Supabase vient d'un CDN : réseau d'abord, copie gardée pour le hors-ligne.
  if (url.hostname === "cdn.jsdelivr.net" && url.pathname.startsWith("/npm/@supabase/")) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CDN_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request, { cacheName: CDN_CACHE }).then((cached) => cached || Response.error()))
    );
    return;
  }
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

// --- Notifications push -------------------------------------------------------
// Le serveur envoie { title, body, tag, channel_id, workspace_id, url, badge }.

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }

  event.waitUntil(
    (async () => {
      if (typeof data.badge === "number" && self.navigator.setAppBadge) {
        try {
          if (data.badge > 0) await self.navigator.setAppBadge(data.badge);
          else await self.navigator.clearAppBadge();
        } catch {
          /* badge non pris en charge : sans conséquence */
        }
      }

      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const visible = windows.find((client) => client.visibilityState === "visible");
      if (visible && data.kind !== "doc") {
        // L'application est ouverte et visible : elle affiche déjà le message, pas de notification système.
        visible.postMessage({ type: "push", channel_id: data.channel_id, workspace_id: data.workspace_id });
        return;
      }

      await self.registration.showNotification(data.title || "ThyChat", {
        body: data.body || "",
        tag: data.tag || "thychat",
        renotify: true,
        icon: "icons/icon-192.png",
        badge: "icons/icon-192.png",
        data: { url: data.url || "./", channel_id: data.channel_id, workspace_id: data.workspace_id },
      });
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const info = event.notification.data || {};
  const target = new URL(info.url || "./", self.registration.scope).href;

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = windows.find((client) => client.url.startsWith(self.registration.scope));
      if (existing) {
        await existing.focus();
        existing.postMessage({ type: "open-channel", channel_id: info.channel_id, workspace_id: info.workspace_id });
        return;
      }
      await self.clients.openWindow(target);
    })()
  );
});
