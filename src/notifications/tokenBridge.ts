/**
 * Bridges the current Supabase access token to the active service worker
 * so its background `sync` fetches (see public/sw-advanced.js's
 * `SET_AUTH_TOKEN` handler) can authenticate — a `sync` event fires with
 * no page/session context of its own, so the worker has to be told the
 * token out of band, ahead of time.
 *
 * Targets `navigator.serviceWorker.controller` specifically (the worker
 * actually controlling *this* page load), not `.ready`/`.active`: a token
 * is only useful to the worker that will actually make the fetch. On a
 * brand-new install before the worker has claimed the page, `controller`
 * is null and this is a no-op — the next reload (once it's controlling)
 * picks up the token via AuthContext's `onAuthStateChange`-driven resync.
 */

export function syncTokenToServiceWorker(token: string): void {
  if (!("serviceWorker" in navigator)) {
    return;
  }
  navigator.serviceWorker.controller?.postMessage({ type: "SET_AUTH_TOKEN", token });
}

/** Clears the worker's cached token on logout, so a background sync can't fire with a now-revoked session. */
export function clearServiceWorkerToken(): void {
  if (!("serviceWorker" in navigator)) {
    return;
  }
  navigator.serviceWorker.controller?.postMessage({ type: "SET_AUTH_TOKEN", token: null });
}
