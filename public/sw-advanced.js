// Unified service worker for the booking PWA: offline shell caching,
// network-first API reads with an IndexedDB fallback, background sync of
// offline-created appointments, and sticky push-notification handling.
// Supersedes the earlier public/sw.js (deleted) — one service worker per
// scope is all a page can have active, so this consolidates rather than
// running alongside it.
//
// Plain JS, not TypeScript or a bundled module — the browser loads this
// file directly. It can't `import` src/db/offlineDb.ts (a different
// execution context, outside the Vite build), so the IndexedDB schema
// (store names, keyPath) is duplicated here in raw IndexedDB calls; keep
// the two in sync by hand if the schema ever changes.
//
// AUTH NOTE: the dashboard API's tenant routes require a Supabase session
// Bearer token (see src/api/middleware/auth.ts). A `sync` event fires
// without any page context, so fetches made from here have no token
// unless the page hands one over — see the `SET_AUTH_TOKEN` message
// handler below, sent by src/notifications/tokenBridge.ts on every auth
// state change (login, logout, token refresh).

const STATIC_CACHE_NAME = "static-shell-v2";
const STATIC_SHELL_URLS = ["/", "/manifest.webmanifest", "/icons/appointment-192.png", "/icons/badge-72.png"];

const DB_NAME = "ai-booking-offline";
const DB_VERSION = 1;
const PENDING_STORE = "pendingAppointments";
const CACHE_STORE = "apiCache";

let cachedAuthToken = null;

// ---------------------------------------------------------------------------
// Raw IndexedDB helpers (see src/db/offlineDb.ts for the `idb`-wrapped
// equivalent used by the page — same DB name/version/stores).
// ---------------------------------------------------------------------------

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PENDING_STORE)) {
        db.createObjectStore(PENDING_STORE, { keyPath: "localId" });
      }
      if (!db.objectStoreNames.contains(CACHE_STORE)) {
        db.createObjectStore(CACHE_STORE, { keyPath: "url" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbGetAll(storeName) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, "readonly").objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbGet(storeName, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, "readonly").objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbPut(storeName, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(storeName, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function withAuthHeader(request) {
  if (!cachedAuthToken) {
    return request;
  }
  const headers = new Headers(request.headers);
  headers.set("Authorization", `Bearer ${cachedAuthToken}`);
  return new Request(request, { headers });
}

// ---------------------------------------------------------------------------
// Install / activate — precache the app shell, drop stale cache versions.
// ---------------------------------------------------------------------------

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_SHELL_URLS))
      .catch(() => {
        /* Best-effort — a missing shell asset shouldn't block install. */
      }),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== STATIC_CACHE_NAME).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

// ---------------------------------------------------------------------------
// Fetch — Cache-First for the static shell/assets, Network-First with an
// IndexedDB fallback for the two live data endpoints.
// ---------------------------------------------------------------------------

function isApiDataRequest(url) {
  return /^\/api\/tenants\/[^/]+\/(appointments|clients)$/.test(url.pathname);
}

function isStaticAssetRequest(request, url) {
  return url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/") || url.pathname === "/manifest.webmanifest";
}

async function cacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) {
    return cached;
  }
  const response = await fetch(request);
  if (response.ok) {
    cache.put(request, response.clone());
  }
  return response;
}

// Navigations (loading "/" itself) must NEVER be cache-first: the shell's
// script/link tags point at content-hashed filenames that change on every
// deploy, so an old cached "/" keeps referencing assets that no longer
// exist post-deploy. Vercel's SPA rewrite then serves index.html in their
// place (200, wrong content-type for a JS module), which the browser
// fails to execute — silently blank page, no console error. Network-first
// means every online visit gets the current shell; the cache is only a
// fallback for genuinely offline loads.
async function networkFirstWithCacheFallback(request) {
  const cache = await caches.open(STATIC_CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (networkError) {
    const cached = await cache.match(request);
    if (cached) {
      return cached;
    }
    throw networkError;
  }
}

async function networkFirstWithIndexedDbFallback(request, url) {
  const cacheKey = url.pathname + url.search;
  try {
    const response = await fetch(withAuthHeader(request));
    if (response.ok) {
      const body = await response.clone().json();
      idbPut(CACHE_STORE, { url: cacheKey, body, cachedAt: new Date().toISOString() }).catch(() => {});
    }
    return response;
  } catch (networkError) {
    const cached = await idbGet(CACHE_STORE, cacheKey).catch(() => null);
    if (cached) {
      return new Response(JSON.stringify(cached.body), {
        status: 200,
        headers: { "Content-Type": "application/json", "X-Served-From": "offline-cache" },
      });
    }
    throw networkError;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") {
    return; // Writes always go straight to the network — see offlineDb.ts for the offline-write queue instead.
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  if (isApiDataRequest(url)) {
    event.respondWith(networkFirstWithIndexedDbFallback(request, url));
  } else if (request.mode === "navigate") {
    event.respondWith(networkFirstWithCacheFallback(request));
  } else if (isStaticAssetRequest(request, url)) {
    event.respondWith(cacheFirst(request));
  }
});

// ---------------------------------------------------------------------------
// Background Sync — batch-push queued offline appointment creations.
// ---------------------------------------------------------------------------

async function syncPendingAppointments() {
  const pending = await idbGetAll(PENDING_STORE).catch(() => []);
  let synced = 0;
  let failed = 0;

  for (const appointment of pending) {
    try {
      const response = await fetch(
        withAuthHeader(
          new Request(`/api/tenants/${encodeURIComponent(appointment.tenantId)}/appointments/manual`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              phoneNumber: appointment.phoneNumber,
              fullName: appointment.fullName,
              serviceType: appointment.serviceType,
              startTime: appointment.startTime,
              durationMinutes: appointment.durationMinutes,
            }),
          }),
        ),
      );
      if (response.ok) {
        await idbDelete(PENDING_STORE, appointment.localId);
        synced++;
      } else {
        failed++;
      }
    } catch {
      failed++; // Still offline, or the server's unreachable — leave it queued for the next sync/retry.
    }
  }

  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clients) {
    client.postMessage({ type: "sync-complete", synced, failed });
  }
}

self.addEventListener("sync", (event) => {
  if (event.tag === "sync-appointments") {
    event.waitUntil(syncPendingAppointments());
  }
});

// ---------------------------------------------------------------------------
// Push notifications (sticky appointment reminders) — see
// src/notifications/webPush.ts#WebPushNotificationPayload for the payload shape.
// ---------------------------------------------------------------------------

self.addEventListener("push", (event) => {
  if (!event.data) {
    return;
  }
  const payload = event.data.json();

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: payload.icon,
      badge: payload.badge,
      tag: payload.tag,
      renotify: payload.renotify,
      // Keeps the notification on screen (not auto-dismissed) until the
      // client acts on it or dismisses it manually — the "sticky" behavior
      // on the web.
      requireInteraction: payload.requireInteraction,
      actions: payload.actions,
      data: payload.data,
    }),
  );
});

// Clicking "Confirm" or "Reschedule" posts the action back to the app and
// keeps the notification open until the appointment is actually resolved
// (completed or cancelled) or the client dismisses it manually — only
// "Directions" (which just opens a map) closes it immediately, since it
// doesn't change the appointment's state.
self.addEventListener("notificationclick", (event) => {
  const { action, notification } = event;
  const data = notification.data || {};

  if (action === "directions") {
    notification.close();
    event.waitUntil(self.clients.openWindow(`https://maps.google.com/?q=${encodeURIComponent(data.appointmentId || "")}`));
    return;
  }

  if (action === "confirm" || action === "reschedule") {
    event.waitUntil(
      (async () => {
        const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        const message = { type: "notification-action", action, appointmentId: data.appointmentId, tenantId: data.tenantId };

        if (allClients.length > 0) {
          for (const client of allClients) {
            client.postMessage(message);
          }
        } else {
          await self.clients.openWindow("/");
        }
        // Deliberately not calling notification.close() here: the
        // reminder stays sticky until the app confirms the appointment is
        // completed/cancelled and explicitly closes it (see the
        // "close-notification" message handler below), or the client
        // dismisses it by hand.
      })(),
    );
    return;
  }

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = allClients[0];
      if (existing) {
        await existing.focus();
      } else {
        await self.clients.openWindow("/");
      }
    })(),
  );
});

// ---------------------------------------------------------------------------
// Messages from the page: retire a completed/cancelled reminder, or hand
// over the current session token for authenticated background requests.
// ---------------------------------------------------------------------------

self.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.type === "close-notification" && typeof message.tag === "string") {
    event.waitUntil(
      self.registration.getNotifications({ tag: message.tag }).then((notifications) => {
        notifications.forEach((notification) => notification.close());
      }),
    );
    return;
  }

  if (message.type === "SET_AUTH_TOKEN") {
    cachedAuthToken = typeof message.token === "string" ? message.token : null;
  }
});
