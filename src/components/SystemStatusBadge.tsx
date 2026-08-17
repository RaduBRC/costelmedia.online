/**
 * "System Online" header badge — polls the real GET /health endpoint
 * (src/api/health.ts, checks live Groq/Supabase/Google Calendar
 * connectivity) rather than showing a decorative always-green dot.
 */
import { useEffect, useState } from "react";
import { AlertTriangle, CircleDot, WifiOff } from "lucide-react";
import { getHealth } from "../lib/api.js";
import type { HealthCheckResult } from "../lib/api.js";

const POLL_INTERVAL_MS = 30_000;

export default function SystemStatusBadge(): JSX.Element {
  const [health, setHealth] = useState<HealthCheckResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = (): void => {
      getHealth()
        .then((result) => {
          if (!cancelled) setHealth(result);
        })
        .catch(() => {
          if (!cancelled) setHealth(null);
        });
    };
    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (!health) {
    return (
      <div className="flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
        <WifiOff className="h-3.5 w-3.5" />
        Checking…
      </div>
    );
  }

  if (health.status === "ok") {
    return (
      <div
        className="flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300"
        title={`Checked ${new Date(health.timestamp).toLocaleTimeString()}`}
      >
        <CircleDot className="h-3.5 w-3.5" />
        System Online
      </div>
    );
  }

  const failing = Object.entries(health.checks)
    .filter(([, check]) => check.status !== "ok")
    .map(([name]) => name)
    .join(", ");

  return (
    <div
      className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
        health.status === "down"
          ? "bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300"
          : "bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300"
      }`}
      title={`Affected: ${failing || "unknown"}`}
    >
      <AlertTriangle className="h-3.5 w-3.5" />
      {health.status === "down" ? "System Down" : "Degraded"}
    </div>
  );
}
