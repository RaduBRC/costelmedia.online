/**
 * "Usage" tab (SettingsPage.tsx): Groq/ElevenLabs/Twilio consumption over
 * the last 30 days — GET /api/tenants/:tenantId/usage
 * (023_voice_improvements.sql) — so a tenant's real cost is visible
 * instead of invisible until a provider bill arrives.
 */
import { useEffect, useState } from "react";
import { Loader2, Wallet } from "lucide-react";
import { getTenantUsage } from "../lib/api.js";
import type { UsageSummaryRow } from "../lib/api.js";
import { useToast } from "./Toast.js";

const SERVICE_LABELS: Record<UsageSummaryRow["service"], string> = {
  groq_llm: "AI conversation (Groq tokens)",
  groq_whisper: "Voice transcription (Whisper, seconds of audio)",
  elevenlabs_tts: "Voice replies (ElevenLabs, characters spoken)",
  twilio_sms: "SMS / WhatsApp messages",
  twilio_voice: "Phone call minutes",
};

export default function UsageSection({ tenantId }: { tenantId: string }): JSX.Element {
  const { showToast } = useToast();
  const [usage, setUsage] = useState<UsageSummaryRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    getTenantUsage(tenantId)
      .then(setUsage)
      .catch((error: unknown) => showToast(error instanceof Error ? error.message : "Failed to load usage.", "error"))
      .finally(() => setIsLoading(false));
  }, [tenantId, showToast]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-slate-400">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center gap-2">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300">
          <Wallet className="h-4.5 w-4.5" />
        </div>
        <div>
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Usage — last 30 days</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">What your AI agent actually used across every service it depends on.</p>
        </div>
      </div>

      {usage.length === 0 ? (
        <p className="rounded-lg bg-slate-50 px-3 py-4 text-center text-xs text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
          No usage recorded yet — this fills in as your AI agent handles real conversations and calls.
        </p>
      ) : (
        <div className="space-y-2">
          {usage.map((row) => (
            <div key={row.service} className="flex items-center justify-between rounded-lg border border-slate-100 px-3 py-2.5 dark:border-slate-800/60">
              <span className="text-sm text-slate-700 dark:text-slate-200">{SERVICE_LABELS[row.service]}</span>
              <span className="text-sm font-medium text-slate-900 dark:text-slate-50">
                {row.totalQuantity.toLocaleString()} {row.unit}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
