/**
 * Live connection state + unsynced offline-record count. Polls
 * countPendingAppointments() (cheap — one IndexedDB `count()` call) rather
 * than holding a live subscription, and also listens for the service
 * worker's "sync-complete" message (posted by public/sw-advanced.js after
 * a background sync) to refresh immediately instead of waiting for the
 * next poll tick.
 */
import { useEffect, useState } from "react";
import { CloudOff, RefreshCw, Wifi, WifiOff } from "lucide-react";
import { countPendingAppointments, syncPendingAppointments } from "../db/offlineDb.js";
import { useToast } from "./Toast.js";

const POLL_INTERVAL_MS = 5000;

function isSyncCompleteMessage(data: unknown): data is { type: "sync-complete"; synced: number; failed: number } {
  return typeof data === "object" && data !== null && (data as { type?: unknown }).type === "sync-complete";
}

export default function ConnectivityStatus(): JSX.Element {
  const { showToast } = useToast();
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [pendingCount, setPendingCount] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);

  useEffect(() => {
    const handleOnline = (): void => {
      setIsOnline(true);
    };
    const handleOffline = (): void => {
      setIsOnline(false);
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refreshCount = (): void => {
      countPendingAppointments()
        .then((count) => {
          if (!cancelled) setPendingCount(count);
        })
        .catch(() => {
          /* IndexedDB unavailable (e.g. private browsing) — leave the count as-is. */
        });
    };

    refreshCount();
    const interval = setInterval(refreshCount, POLL_INTERVAL_MS);

    const handleMessage = (event: MessageEvent<unknown>): void => {
      if (isSyncCompleteMessage(event.data)) {
        refreshCount();
        if (event.data.synced > 0) {
          showToast(`Synced ${event.data.synced} offline booking${event.data.synced === 1 ? "" : "s"}.`, "success");
        }
      }
    };
    navigator.serviceWorker?.addEventListener("message", handleMessage);

    return () => {
      cancelled = true;
      clearInterval(interval);
      navigator.serviceWorker?.removeEventListener("message", handleMessage);
    };
  }, [showToast]);

  const handleSyncNow = (): void => {
    setIsSyncing(true);
    syncPendingAppointments()
      .then((result) => {
        setPendingCount(result.failed);
        if (result.synced > 0) {
          showToast(`Synced ${result.synced} offline booking${result.synced === 1 ? "" : "s"}.`, "success");
        }
        if (result.failed > 0) {
          showToast(`${result.failed} offline booking${result.failed === 1 ? "" : "s"} still couldn't sync.`, "error");
        }
      })
      .catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : "Sync failed.", "error");
      })
      .finally(() => {
        setIsSyncing(false);
      });
  };

  if (isOnline && pendingCount === 0) {
    return (
      <div className="flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
        <Wifi className="h-3.5 w-3.5" />
        Online
      </div>
    );
  }

  return (
    <div
      className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
        isOnline
          ? "bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300"
          : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
      }`}
    >
      {isOnline ? <CloudOff className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
      {isOnline ? "Offline mode" : "Offline"}
      {pendingCount > 0 && (
        <span className="rounded-full bg-white/60 px-1.5 tabular-nums dark:bg-black/20">{pendingCount} unsynced</span>
      )}
      {isOnline && pendingCount > 0 && (
        <button
          type="button"
          onClick={handleSyncNow}
          disabled={isSyncing}
          className="ml-0.5 flex items-center gap-1 rounded-full bg-white/60 px-2 py-1 transition active:scale-95 active:bg-white disabled:opacity-50 hover:bg-white dark:bg-black/20 dark:active:bg-black/40 dark:hover:bg-black/40"
        >
          <RefreshCw className={`h-3 w-3 ${isSyncing ? "animate-spin" : ""}`} />
          Sync
        </button>
      )}
    </div>
  );
}
