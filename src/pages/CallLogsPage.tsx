/**
 * /admin/calls — the first surface in this app that lets a tenant see
 * their own past voice-call transcripts. Read-only: transcripts are
 * written once, at the end of a call (callSession.ts's endCallSession),
 * never edited from here. The "needs follow-up" filter surfaces calls
 * where the caller showed sustained frustration (callSession.ts's
 * recordToneSignal) — see 023_voice_improvements.sql.
 */
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronUp, Loader2, Phone } from "lucide-react";
import { getCallTranscripts } from "../lib/api.js";
import { useToast } from "../components/Toast.js";
import { useAuth } from "../context/AuthContext.js";
import type { CallTranscriptRecord } from "../types/index.js";

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}:${remaining.toString().padStart(2, "0")}`;
}

export default function CallLogsPage(): JSX.Element {
  const { tenantId } = useAuth();
  const { showToast } = useToast();
  const [calls, setCalls] = useState<CallTranscriptRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [followUpOnly, setFollowUpOnly] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!tenantId) return;
    setIsLoading(true);
    getCallTranscripts(tenantId, followUpOnly)
      .then(setCalls)
      .catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : "Failed to load call logs.", "error");
      })
      .finally(() => setIsLoading(false));
  }, [tenantId, followUpOnly, showToast]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-50">Call Logs</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">Full transcripts of past voice calls handled by your AI agent.</p>
        </div>
        <label className="flex min-h-11 items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300">
          <input
            type="checkbox"
            checked={followUpOnly}
            onChange={(event) => setFollowUpOnly(event.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-violet-600 focus:ring-violet-500 dark:border-slate-700"
          />
          Needs follow-up only
        </label>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
        </div>
      ) : calls.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
          {followUpOnly ? "No calls currently flagged for follow-up." : "No calls recorded yet."}
        </p>
      ) : (
        <div className="space-y-2">
          {calls.map((call) => {
            const isExpanded = expandedId === call.id;
            return (
              <div key={call.id} className="rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
                <button
                  type="button"
                  onClick={() => setExpandedId(isExpanded ? null : call.id)}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
                >
                  <div className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                    <Phone className="h-4 w-4 shrink-0 text-slate-400" />
                    <span>{new Date(call.createdAt).toLocaleString()}</span>
                    <span className="text-slate-400">— {formatDuration(call.durationSeconds)}</span>
                    {call.needsFollowUp && (
                      <span className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
                        <AlertTriangle className="h-3 w-3" />
                        Needs follow-up
                      </span>
                    )}
                  </div>
                  {isExpanded ? <ChevronUp className="h-4 w-4 shrink-0 text-slate-400" /> : <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />}
                </button>
                {isExpanded && (
                  <pre className="whitespace-pre-wrap border-t border-slate-100 px-4 py-3 text-xs text-slate-600 dark:border-slate-800/60 dark:text-slate-300">
                    {call.transcript}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
