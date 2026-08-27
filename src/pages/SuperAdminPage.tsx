/**
 * /super-admin — platform-wide visibility, read-only except the (separate)
 * plan-change route. Four tabs: the original tenant list, plus three new
 * ones backing this round's cross-tenant visibility work — Knowledge Gaps
 * (real questions no tenant's FAQs covered), System Health (voice
 * pipeline latency + recent TTS/STT failures), and Usage (platform-wide
 * Groq/ElevenLabs/Twilio consumption). Still deliberately minimal beyond
 * that — deactivating a tenant, impersonating a user, managing
 * platform_admins from the UI, etc. are real, separate features, not
 * built here. See the conversation this shipped in for that scoping.
 */
import { useEffect, useState } from "react";
import { AlertTriangle, Gauge, HelpCircle, Loader2, ShieldCheck, Wallet } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { getSuperAdminKnowledgeGaps, getSuperAdminTenants, getSuperAdminUsage, getSystemHealth } from "../lib/api.js";
import type { SystemHealthSummary, UsageSummaryRow } from "../lib/api.js";
import { useToast } from "../components/Toast.js";
import type { BusinessType, KnowledgeGap, Tenant } from "../types/index.js";

type SuperAdminTab = "tenants" | "knowledge-gaps" | "system-health" | "usage";

const TABS: { value: SuperAdminTab; label: string }[] = [
  { value: "tenants", label: "Tenants" },
  { value: "knowledge-gaps", label: "Knowledge Gaps" },
  { value: "system-health", label: "System Health" },
  { value: "usage", label: "Usage" },
];

const USAGE_SERVICE_LABELS: Record<UsageSummaryRow["service"], string> = {
  groq_llm: "Groq LLM (tokens)",
  groq_whisper: "Whisper transcription (seconds)",
  elevenlabs_tts: "ElevenLabs TTS (characters)",
  twilio_sms: "Twilio SMS/WhatsApp (messages)",
  twilio_voice: "Twilio voice calls (seconds)",
};

function TenantsTab({ tenants, isLoading }: { tenants: Tenant[]; isLoading: boolean }): JSX.Element {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400 dark:border-slate-800">
            <th className="px-4 py-2 font-medium">Business name</th>
            <th className="px-4 py-2 font-medium">Industry</th>
            <th className="px-4 py-2 font-medium">Plan</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium">Created</th>
            <th className="px-4 py-2 font-medium">Tenant ID</th>
          </tr>
        </thead>
        <tbody>
          {tenants.length === 0 ? (
            <tr>
              <td colSpan={6} className="px-4 py-6 text-center text-xs text-slate-400 dark:text-slate-500">
                {isLoading ? "Loading…" : "No tenants on the platform yet."}
              </td>
            </tr>
          ) : (
            tenants.map((tenant) => (
              <tr key={tenant.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800/60">
                <td className="px-4 py-2.5 text-slate-700 dark:text-slate-200">{tenant.name}</td>
                <td className="px-4 py-2.5 capitalize text-slate-500 dark:text-slate-400">{tenant.businessType.replace("_", " ")}</td>
                <td className="px-4 py-2.5">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      tenant.plan === "vip"
                        ? "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300"
                        : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                    }`}
                  >
                    {tenant.plan === "vip" ? "VIP" : "Starter"}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      tenant.isActive
                        ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300"
                        : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                    }`}
                  >
                    {tenant.isActive ? "Active" : "Inactive"}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-slate-500 dark:text-slate-400">{new Date(tenant.createdAt).toLocaleDateString()}</td>
                <td className="px-4 py-2.5 font-mono text-xs text-slate-400 dark:text-slate-500">{tenant.id}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function KnowledgeGapsTab({ gaps, isLoading }: { gaps: KnowledgeGap[]; isLoading: boolean }): JSX.Element {
  const byBusinessType = new Map<BusinessType, KnowledgeGap[]>();
  for (const gap of gaps) {
    const existing = byBusinessType.get(gap.businessType) ?? [];
    existing.push(gap);
    byBusinessType.set(gap.businessType, existing);
  }

  if (isLoading) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
      </div>
    );
  }
  if (gaps.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
        No unanswered questions logged yet — every caller so far got a real answer from a tenant FAQ or the niche knowledge base.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {Array.from(byBusinessType.entries()).map(([businessType, entries]) => (
        <section key={businessType} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <h3 className="mb-2 text-sm font-semibold capitalize text-slate-900 dark:text-slate-50">
            {businessType.replace("_", " ")} — {entries.length}
          </h3>
          <ul className="space-y-1.5">
            {entries.slice(0, 20).map((gap) => (
              <li key={gap.id} className="flex items-start gap-2 text-xs text-slate-600 dark:text-slate-300">
                <HelpCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-500" />
                <span>
                  {gap.question} <span className="text-slate-400">({gap.channel === "ai_voice" ? "call" : "chat"})</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function SystemHealthTab({ health, isLoading }: { health: SystemHealthSummary | null; isLoading: boolean }): JSX.Element {
  if (isLoading || !health) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
      </div>
    );
  }

  const stats: { label: string; value: string }[] = [
    { label: "Turns measured (last 1000)", value: String(health.totalTurns) },
    { label: "Whisper hybrid usage", value: `${health.whisperUsageRatePct}%` },
    { label: "Avg LLM latency", value: health.avgLlmLatencyMs !== null ? `${health.avgLlmLatencyMs}ms` : "—" },
    { label: "Avg TTS first-byte latency", value: health.avgTtsFirstByteLatencyMs !== null ? `${health.avgTtsFirstByteLatencyMs}ms` : "—" },
    { label: "Avg total turn latency", value: health.avgTotalTurnLatencyMs !== null ? `${health.avgTotalTurnLatencyMs}ms` : "—" },
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <p className="flex items-center gap-1 text-[11px] text-slate-400">
              <Gauge className="h-3 w-3" />
              {stat.label}
            </p>
            <p className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-50">{stat.value}</p>
          </div>
        ))}
      </div>

      <section>
        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-900 dark:text-slate-50">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          Recent failures
        </h3>
        {health.recentFailures.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-300 p-4 text-center text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
            No TTS/STT/LLM failures logged recently.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 uppercase tracking-wide text-slate-400 dark:border-slate-800">
                  <th className="px-3 py-2 font-medium">Service</th>
                  <th className="px-3 py-2 font-medium">Error</th>
                  <th className="px-3 py-2 font-medium">When</th>
                </tr>
              </thead>
              <tbody>
                {health.recentFailures.slice(0, 50).map((failure) => (
                  <tr key={failure.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800/60">
                    <td className="px-3 py-2 capitalize text-slate-700 dark:text-slate-200">{failure.service}</td>
                    <td className="max-w-md truncate px-3 py-2 text-slate-500 dark:text-slate-400" title={failure.errorMessage}>
                      {failure.errorMessage}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-slate-400">{new Date(failure.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function UsageTab({ usage, isLoading }: { usage: UsageSummaryRow[]; isLoading: boolean }): JSX.Element {
  if (isLoading) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400 dark:border-slate-800">
            <th className="px-4 py-2 font-medium">Service</th>
            <th className="px-4 py-2 font-medium">Total (last 30 days)</th>
            <th className="px-4 py-2 font-medium">Events</th>
          </tr>
        </thead>
        <tbody>
          {usage.length === 0 ? (
            <tr>
              <td colSpan={3} className="px-4 py-6 text-center text-xs text-slate-400 dark:text-slate-500">
                No usage recorded in the last 30 days.
              </td>
            </tr>
          ) : (
            usage.map((row) => (
              <tr key={row.service} className="border-b border-slate-100 last:border-0 dark:border-slate-800/60">
                <td className="px-4 py-2.5 text-slate-700 dark:text-slate-200">{USAGE_SERVICE_LABELS[row.service]}</td>
                <td className="px-4 py-2.5 text-slate-700 dark:text-slate-200">
                  {row.totalQuantity.toLocaleString()} {row.unit}
                </td>
                <td className="px-4 py-2.5 text-slate-500 dark:text-slate-400">{row.eventCount.toLocaleString()}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export default function SuperAdminPage(): JSX.Element {
  const { showToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const activeTab: SuperAdminTab = TABS.some((tab) => tab.value === requestedTab) ? (requestedTab as SuperAdminTab) : "tenants";

  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [gaps, setGaps] = useState<KnowledgeGap[]>([]);
  const [health, setHealth] = useState<SystemHealthSummary | null>(null);
  const [usage, setUsage] = useState<UsageSummaryRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    setIsLoading(true);
    const load =
      activeTab === "tenants"
        ? getSuperAdminTenants().then(setTenants)
        : activeTab === "knowledge-gaps"
          ? getSuperAdminKnowledgeGaps().then(setGaps)
          : activeTab === "system-health"
            ? getSystemHealth().then(setHealth)
            : getSuperAdminUsage().then(setUsage);
    load
      .catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : "Failed to load data.", "error");
      })
      .finally(() => setIsLoading(false));
    // showToast is stable (ToastProvider) — only re-fetching when the tab actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-8 sm:px-6 dark:bg-slate-950">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-600 text-white">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-50">Super Admin</h1>
            <p className="text-xs text-slate-500 dark:text-slate-400">Platform-wide tenants, knowledge gaps, system health, and usage.</p>
          </div>
        </div>

        <div className="mb-6 flex gap-1 border-b border-slate-200 dark:border-slate-800">
          {TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              onClick={() =>
                setSearchParams((params) => {
                  params.set("tab", tab.value);
                  return params;
                })
              }
              className={`flex min-h-11 items-center gap-1.5 border-b-2 px-3 text-sm font-medium transition ${
                activeTab === tab.value
                  ? "border-violet-600 text-violet-700 dark:text-violet-400"
                  : "border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
              }`}
            >
              {tab.value === "usage" && <Wallet className="h-3.5 w-3.5" />}
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === "tenants" && <TenantsTab tenants={tenants} isLoading={isLoading} />}
        {activeTab === "knowledge-gaps" && <KnowledgeGapsTab gaps={gaps} isLoading={isLoading} />}
        {activeTab === "system-health" && <SystemHealthTab health={health} isLoading={isLoading} />}
        {activeTab === "usage" && <UsageTab usage={usage} isLoading={isLoading} />}
      </div>
    </div>
  );
}
