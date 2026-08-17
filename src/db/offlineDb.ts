/**
 * Browser-side IndexedDB access for offline appointment creation — the
 * write-side "outbox" that public/sw-advanced.js's `sync` handler also
 * drains (that file can't `import` this one; it's a plain script loaded
 * directly by the browser, not part of the Vite bundle — see its header
 * comment for why the schema is duplicated there in raw IndexedDB calls
 * rather than shared).
 *
 * Uses the `idb` package (explicitly allowed by this deliverable) rather
 * than the raw IndexedDB callback API, which is painful enough to use
 * directly that hand-rolling it here — on top of what the service worker
 * already has to hand-roll — would be pure duplication for no benefit.
 */
import { openDB } from "idb";
import type { DBSchema, IDBPDatabase } from "idb";
import type { PendingAppointment, SyncResult } from "../types/index.js";

export const OFFLINE_DB_NAME = "ai-booking-offline";
export const OFFLINE_DB_VERSION = 1;
export const PENDING_APPOINTMENTS_STORE = "pendingAppointments";
export const API_CACHE_STORE = "apiCache";

interface OfflineDbSchema extends DBSchema {
  [PENDING_APPOINTMENTS_STORE]: { key: string; value: PendingAppointment };
  [API_CACHE_STORE]: { key: string; value: { url: string; body: unknown; cachedAt: string } };
}

let dbPromise: Promise<IDBPDatabase<OfflineDbSchema>> | null = null;

function getDb(): Promise<IDBPDatabase<OfflineDbSchema>> {
  dbPromise ??= openDB<OfflineDbSchema>(OFFLINE_DB_NAME, OFFLINE_DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(PENDING_APPOINTMENTS_STORE)) {
        db.createObjectStore(PENDING_APPOINTMENTS_STORE, { keyPath: "localId" });
      }
      if (!db.objectStoreNames.contains(API_CACHE_STORE)) {
        db.createObjectStore(API_CACHE_STORE, { keyPath: "url" });
      }
    },
  });
  return dbPromise;
}

/** Queues a staff-entered appointment while offline, for the sync handler to push once connectivity returns. */
export async function saveAppointmentOffline(appointmentData: PendingAppointment): Promise<void> {
  const db = await getDb();
  await db.put(PENDING_APPOINTMENTS_STORE, appointmentData);
}

export async function listPendingAppointments(): Promise<PendingAppointment[]> {
  const db = await getDb();
  return db.getAll(PENDING_APPOINTMENTS_STORE);
}

export async function countPendingAppointments(): Promise<number> {
  const db = await getDb();
  return db.count(PENDING_APPOINTMENTS_STORE);
}

/**
 * Iterates every queued appointment, POSTs it to the staff-booking
 * endpoint, and removes it from the queue on success — leaving failures
 * queued for the next attempt (a background `sync` retry, or the next
 * manual call to this function) rather than silently dropping them.
 */
export async function syncPendingAppointments(): Promise<SyncResult> {
  const db = await getDb();
  const pending = await db.getAll(PENDING_APPOINTMENTS_STORE);

  let synced = 0;
  const errors: string[] = [];

  for (const appointment of pending) {
    try {
      const response = await fetch(`/api/tenants/${encodeURIComponent(appointment.tenantId)}/appointments/manual`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phoneNumber: appointment.phoneNumber,
          fullName: appointment.fullName,
          serviceType: appointment.serviceType,
          startTime: appointment.startTime,
          durationMinutes: appointment.durationMinutes,
        }),
      });

      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const message =
          body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
            ? (body as { error: string }).error
            : `Sync failed (${response.status}).`;
        errors.push(`${appointment.localId}: ${message}`);
        continue;
      }

      await db.delete(PENDING_APPOINTMENTS_STORE, appointment.localId);
      synced++;
    } catch (error) {
      errors.push(`${appointment.localId}: ${error instanceof Error ? error.message : "network error"}`);
    }
  }

  return { synced, failed: pending.length - synced, errors };
}
