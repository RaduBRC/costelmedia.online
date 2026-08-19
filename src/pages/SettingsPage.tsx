/**
 * /admin/settings — business info, working hours, and AI persona, all
 * PATCHed through src/api/routes/tenantSettings.ts. A single "Save
 * changes" button submits everything at once rather than per-section
 * saves: nothing here needs to persist independently, and one write
 * keeps the tenant row (and therefore the very next AI prompt built from
 * it — see promptBuilder.ts) consistent instead of momentarily mixing
 * old/new fields across separate requests.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Calendar, Loader2, Lock, Play, Save, Unlink } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import IntegrationsSection from "../components/IntegrationsSection.js";
import PhoneSetupSection from "../components/PhoneSetupSection.js";
import { disconnectGoogleCalendar, getGoogleCalendarConsentUrl, getGoogleCalendarStatus, listVoices, updateTenant } from "../lib/api.js";
import type { ElevenLabsVoice, GoogleCalendarConnectionStatus } from "../lib/api.js";
import { useToast } from "../components/Toast.js";
import { useAuth } from "../context/AuthContext.js";
import { useDashboardData } from "../hooks/useDashboardData.js";
import type { BusinessType, ToneOfVoice, Weekday, WorkingHours } from "../types/index.js";

type SettingsTab = "general" | "phone" | "integrations";

const SETTINGS_TABS: { value: SettingsTab; label: string }[] = [
  { value: "general", label: "General" },
  { value: "phone", label: "Phone Setup" },
  { value: "integrations", label: "Integrations" },
];

/**
 * Starter/DIY plan hard limit, mirrored from tenantSettings.ts's own
 * STARTER_ALLOWED_VOICE_IDS — this copy is display-only (which options
 * the dropdown offers a Starter tenant); the PATCH route enforces the
 * real limit server-side regardless of what the frontend shows, so these
 * two lists drifting would be a UX inconsistency, not a security gap.
 */
const STARTER_ALLOWED_VOICE_IDS: readonly string[] = ["21m00Tcm4TlvDq8ikWAM", "pNInz6obpgDQGcFmaJgB", "AZnzlk1XvdvUeBnXmlld", "EXAVITQu4vr4xnSDxMaL"];

const BUSINESS_TYPES: { value: BusinessType; label: string }[] = [
  { value: "clinic", label: "Medical clinic" },
  { value: "restaurant", label: "Restaurant" },
  { value: "callcenter", label: "Call center" },
  { value: "auto_shop", label: "Auto repair shop" },
  { value: "salon", label: "Hair / beauty salon" },
  { value: "legal_services", label: "Professional services / Legal" },
  { value: "general_services", label: "General / other business" },
];

const TONES_OF_VOICE: { value: ToneOfVoice; label: string; description: string }[] = [
  { value: "friendly", label: "Friendly", description: "Warm, conversational, contractions and a light emoji are fine." },
  { value: "formal", label: "Formal", description: "Polished, professional language — no slang, no emoji." },
];

const WEEKDAYS: { value: Weekday; label: string }[] = [
  { value: "monday", label: "Monday" },
  { value: "tuesday", label: "Tuesday" },
  { value: "wednesday", label: "Wednesday" },
  { value: "thursday", label: "Thursday" },
  { value: "friday", label: "Friday" },
  { value: "saturday", label: "Saturday" },
  { value: "sunday", label: "Sunday" },
];

const inputClass =
  "mt-1 min-h-12 w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-base outline-none focus:border-violet-500 sm:text-sm dark:border-slate-700";

function VoicePreviewButton({ url }: { url: string }): JSX.Element {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  return (
    <button
      type="button"
      onClick={() => {
        if (!audioRef.current) {
          audioRef.current = new Audio(url);
        }
        audioRef.current.currentTime = 0;
        void audioRef.current.play();
      }}
      aria-label="Preview voice"
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-violet-600 transition active:bg-violet-50 dark:text-violet-400 dark:active:bg-violet-950/40"
    >
      <Play className="h-4 w-4" />
    </button>
  );
}

/**
 * Standalone from the business-info/hours/persona <form> below — Connect/
 * Disconnect are their own immediate actions (each is a real API call,
 * not a draft field waiting on "Save changes"), so this card lives
 * outside that form and manages its own status independently.
 */
function GoogleCalendarCard({ tenantId }: { tenantId: string }): JSX.Element {
  const { showToast } = useToast();
  const [status, setStatus] = useState<GoogleCalendarConnectionStatus | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const refreshStatus = useCallback(() => {
    getGoogleCalendarStatus(tenantId)
      .then(setStatus)
      .catch((error: unknown) => showToast(error instanceof Error ? error.message : "Failed to load calendar status.", "error"));
  }, [tenantId, showToast]);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  const handleConnect = (): void => {
    setIsBusy(true);
    getGoogleCalendarConsentUrl(tenantId)
      .then(({ consentUrl }) => {
        // A real, full-page navigation to Google's own consent screen —
        // not something this app can do on the user's behalf, on purpose.
        window.location.href = consentUrl;
      })
      .catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : "Failed to start Google Calendar connection.", "error");
        setIsBusy(false);
      });
  };

  const handleDisconnect = (): void => {
    setIsBusy(true);
    disconnectGoogleCalendar(tenantId)
      .then(() => {
        showToast("Google Calendar disconnected — falling back to the platform's shared calendar connection.", "success");
        refreshStatus();
      })
      .catch((error: unknown) => showToast(error instanceof Error ? error.message : "Failed to disconnect.", "error"))
      .finally(() => setIsBusy(false));
  };

  return (
    <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Google Calendar</h2>
        {status && (
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              status.connected
                ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300"
                : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
            }`}
          >
            {status.connected ? `Connected: ${status.calendarId}` : "Not connected"}
          </span>
        )}
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Connect your own Google account so the AI checks and books directly on your calendar. Until connected, the platform's shared
        calendar connection is used instead — booking still works either way.
      </p>
      {status?.connected ? (
        <button
          type="button"
          onClick={handleDisconnect}
          disabled={isBusy}
          className="flex h-11 items-center gap-2 rounded-lg border border-slate-300 px-4 text-sm font-medium text-slate-600 transition active:scale-[0.98] disabled:opacity-60 dark:border-slate-700 dark:text-slate-300"
        >
          {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unlink className="h-4 w-4" />}
          Disconnect &amp; revoke access
        </button>
      ) : (
        <button
          type="button"
          onClick={handleConnect}
          disabled={isBusy || !status}
          className="flex h-11 items-center gap-2 rounded-lg bg-violet-600 px-4 text-sm font-medium text-white transition active:scale-[0.98] disabled:opacity-60"
        >
          {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Calendar className="h-4 w-4" />}
          Connect Google Calendar
        </button>
      )}
    </section>
  );
}

export default function SettingsPage(): JSX.Element {
  const { tenantId } = useAuth();
  const { showToast } = useToast();
  const data = useDashboardData(tenantId ?? "");
  const [searchParams, setSearchParams] = useSearchParams();

  const requestedTab = searchParams.get("tab");
  const activeTab: SettingsTab = SETTINGS_TABS.some((tab) => tab.value === requestedTab) ? (requestedTab as SettingsTab) : "general";
  const goToTab = (tab: SettingsTab): void => {
    setSearchParams((params) => {
      params.set("tab", tab);
      return params;
    });
  };

  // Landed here from /api/integrations/google/callback's redirect (see
  // googleIntegration.ts) — surface the result once, then strip the query
  // params so a page refresh doesn't re-show the same toast.
  useEffect(() => {
    const calendarResult = searchParams.get("calendar");
    if (!calendarResult) return;
    if (calendarResult === "connected") {
      showToast("Google Calendar connected.", "success");
    } else if (calendarResult === "error") {
      showToast(searchParams.get("message") ?? "Failed to connect Google Calendar.", "error");
    }
    setSearchParams((params) => {
      params.delete("calendar");
      params.delete("message");
      return params;
    }, { replace: true });
    // Only ever meant to run once, right after landing on this exact
    // redirect — not on every searchParams identity change (setSearchParams
    // itself produces a new one).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [voices, setVoices] = useState<ElevenLabsVoice[]>([]);
  const [voicesUnavailable, setVoicesUnavailable] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const [name, setName] = useState("");
  const [businessType, setBusinessType] = useState<BusinessType>("clinic");
  const [publicPhoneNumber, setPublicPhoneNumber] = useState("");
  const [address, setAddress] = useState("");
  const [workingHours, setWorkingHours] = useState<WorkingHours | null>(null);
  const [greetingMessage, setGreetingMessage] = useState("");
  const [systemPromptOverride, setSystemPromptOverride] = useState("");
  const [elevenlabsVoiceId, setElevenlabsVoiceId] = useState("");
  const [toneOfVoice, setToneOfVoice] = useState<ToneOfVoice>("friendly");

  // Seed local form state from the loaded tenant exactly once — after
  // that, this form owns the fields until Save, so a background refetch
  // elsewhere doesn't clobber in-progress edits.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !data.tenant) return;
    seeded.current = true;
    const tenant = data.tenant;
    setName(tenant.name);
    setBusinessType(tenant.businessType);
    setPublicPhoneNumber(tenant.publicPhoneNumber ?? "");
    setAddress(tenant.address ?? "");
    setWorkingHours(tenant.workingHours);
    setGreetingMessage(tenant.greetingMessage ?? "");
    setSystemPromptOverride(tenant.systemPromptOverride ?? "");
    setElevenlabsVoiceId(tenant.elevenlabsVoiceId ?? "");
    setToneOfVoice(tenant.toneOfVoice);
  }, [data.tenant]);

  useEffect(() => {
    if (!tenantId) return;
    listVoices(tenantId)
      .then(setVoices)
      .catch(() => setVoicesUnavailable(true));
  }, [tenantId]);

  const handleDayChange = (day: Weekday, patch: Partial<{ start: string; end: string }>): void => {
    setWorkingHours((current) => {
      if (!current) return current;
      const existing = current[day] ?? { start: "09:00", end: "17:00" };
      return { ...current, [day]: { ...existing, ...patch } };
    });
  };

  const handleToggleClosed = (day: Weekday, closed: boolean): void => {
    setWorkingHours((current) => {
      if (!current) return current;
      return { ...current, [day]: closed ? null : { start: "09:00", end: "17:00" } };
    });
  };

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!tenantId || !workingHours) return;
    setIsSaving(true);
    updateTenant(tenantId, {
      name: name.trim(),
      businessType,
      publicPhoneNumber: publicPhoneNumber.trim() || null,
      address: address.trim() || null,
      workingHours,
      greetingMessage: greetingMessage.trim() || null,
      systemPromptOverride: systemPromptOverride.trim() || null,
      elevenlabsVoiceId: elevenlabsVoiceId || null,
      toneOfVoice,
    })
      .then(() => {
        showToast("Settings saved.", "success");
        void data.refresh();
      })
      .catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : "Failed to save settings.", "error");
      })
      .finally(() => setIsSaving(false));
  };

  if (!data.tenant || !workingHours || !tenantId) {
    return (
      <div className="flex items-center justify-center py-16 text-slate-400">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  const isStarter = data.tenant.plan === "starter";
  // Starter tenants only ever see the curated standard voices (plus
  // whichever voice they already have set, even if it fell outside that
  // list some other way — never hide their own current selection from
  // the dropdown, just don't offer switching TO a non-standard one).
  const visibleVoices = isStarter ? voices.filter((voice) => STARTER_ALLOWED_VOICE_IDS.includes(voice.voiceId) || voice.voiceId === elevenlabsVoiceId) : voices;

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex gap-1 border-b border-slate-200 dark:border-slate-800">
        {SETTINGS_TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            onClick={() => goToTab(tab.value)}
            className={`min-h-11 border-b-2 px-3 text-sm font-medium transition ${
              activeTab === tab.value
                ? "border-violet-600 text-violet-700 dark:text-violet-400"
                : "border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "phone" && <PhoneSetupSection tenantId={tenantId} />}
      {activeTab === "integrations" && <IntegrationsSection tenantId={tenantId} plan={data.tenant.plan} />}

      {activeTab === "general" && (
        <>
      <GoogleCalendarCard tenantId={tenantId} />
      <form onSubmit={handleSubmit} className="space-y-6">
      <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Business information</h2>
        <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
          Company name
          <input required value={name} onChange={(event) => setName(event.target.value)} className={inputClass} />
        </label>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
            Industry
            <select value={businessType} onChange={(event) => setBusinessType(event.target.value as BusinessType)} className={inputClass}>
              {BUSINESS_TYPES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
            Public phone number
            <input
              value={publicPhoneNumber}
              onChange={(event) => setPublicPhoneNumber(event.target.value)}
              placeholder="+40 7xx xxx xxx"
              className={inputClass}
            />
          </label>
        </div>
        <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
          Address
          <input value={address} onChange={(event) => setAddress(event.target.value)} className={inputClass} />
        </label>
      </section>

      <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Working hours</h2>
        <div className="space-y-2">
          {WEEKDAYS.map(({ value: day, label }) => {
            const hours = workingHours[day];
            const closed = hours === null;
            return (
              <div key={day} className="flex flex-wrap items-center gap-3 border-b border-slate-100 py-2 last:border-0 dark:border-slate-800/60">
                <span className="w-24 shrink-0 text-sm text-slate-700 dark:text-slate-200">{label}</span>
                <label className="flex min-h-11 items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                  <input
                    type="checkbox"
                    checked={closed}
                    onChange={(event) => handleToggleClosed(day, event.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-violet-600 focus:ring-violet-500 dark:border-slate-700"
                  />
                  Closed
                </label>
                {!closed && hours && (
                  <div className="flex items-center gap-2">
                    <input
                      type="time"
                      value={hours.start}
                      onChange={(event) => handleDayChange(day, { start: event.target.value })}
                      className="min-h-11 rounded-lg border border-slate-300 bg-transparent px-2 text-sm outline-none focus:border-violet-500 dark:border-slate-700"
                    />
                    <span className="text-xs text-slate-400">to</span>
                    <input
                      type="time"
                      value={hours.end}
                      onChange={(event) => handleDayChange(day, { end: event.target.value })}
                      className="min-h-11 rounded-lg border border-slate-300 bg-transparent px-2 text-sm outline-none focus:border-violet-500 dark:border-slate-700"
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">AI persona</h2>

        <div>
          <span className="block text-xs font-medium text-slate-600 dark:text-slate-300">Tone of voice</span>
          <div className="mt-1 grid grid-cols-2 gap-2">
            {TONES_OF_VOICE.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setToneOfVoice(option.value)}
                className={`rounded-lg border p-3 text-left transition ${
                  toneOfVoice === option.value
                    ? "border-violet-500 bg-violet-50 dark:bg-violet-950/40"
                    : "border-slate-300 dark:border-slate-700"
                }`}
              >
                <span className="block text-sm font-medium text-slate-900 dark:text-slate-50">{option.label}</span>
                <span className="mt-0.5 block text-[11px] text-slate-500 dark:text-slate-400">{option.description}</span>
              </button>
            ))}
          </div>
        </div>

        <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
          Greeting message
          <textarea
            value={greetingMessage}
            onChange={(event) => setGreetingMessage(event.target.value)}
            rows={2}
            placeholder="Bună ziua! Bine ați venit la {company_name}..."
            className={inputClass}
          />
          <span className="mt-1 block text-[11px] text-slate-400">
            Spoken automatically when a voice call connects. Use {"{company_name}"} to insert the company name. Leave blank to use the default
            greeting for this industry.
          </span>
        </label>

        <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
          Additional instructions (optional)
          {isStarter && systemPromptOverride.trim().length === 0 ? (
            <div className="mt-1 flex items-start gap-2 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-2.5 text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-400">
              <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Custom AI instructions are a VIP feature — Starter plan tenants use the default prompt template for their industry.{" "}
                <button type="button" onClick={() => goToTab("integrations")} className="font-medium text-violet-600 hover:underline dark:text-violet-400">
                  Request VIP Integration
                </button>
              </span>
            </div>
          ) : (
            <textarea
              value={systemPromptOverride}
              onChange={(event) => setSystemPromptOverride(event.target.value)}
              readOnly={isStarter}
              rows={3}
              className={`${inputClass} ${isStarter ? "cursor-not-allowed opacity-60" : ""}`}
            />
          )}
          <span className="mt-1 block text-[11px] text-slate-400">Appended to the AI's standard rules — doesn't replace them.</span>
        </label>

        <div>
          <span className="block text-xs font-medium text-slate-600 dark:text-slate-300">Voice</span>
          {isStarter && (
            <p className="mt-1 flex items-center gap-1.5 text-[11px] text-slate-400">
              <Lock className="h-3 w-3 shrink-0" />
              Starter plan: standard voices only.{" "}
              <button type="button" onClick={() => goToTab("integrations")} className="font-medium text-violet-600 hover:underline dark:text-violet-400">
                Unlock the full library
              </button>
            </p>
          )}
          {voicesUnavailable ? (
            <p className="mt-1 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
              Voice list unavailable — ElevenLabs isn't configured on this server. The current voice ID is preserved below.
            </p>
          ) : (
            <div className="mt-1 flex items-center gap-2">
              <select
                value={elevenlabsVoiceId}
                onChange={(event) => setElevenlabsVoiceId(event.target.value)}
                className={`${inputClass} mt-0 flex-1`}
              >
                <option value="">Platform default</option>
                {visibleVoices.map((voice) => (
                  <option key={voice.voiceId} value={voice.voiceId}>
                    {voice.name}
                  </option>
                ))}
              </select>
              {(() => {
                const selected = voices.find((voice) => voice.voiceId === elevenlabsVoiceId);
                return selected?.previewUrl ? <VoicePreviewButton url={selected.previewUrl} /> : null;
              })()}
            </div>
          )}
        </div>
      </section>

      <button
        type="submit"
        disabled={isSaving}
        className="flex h-12 items-center gap-2 rounded-lg bg-violet-600 px-5 text-sm font-medium text-white transition active:scale-[0.98] disabled:opacity-60"
      >
        {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        Save changes
      </button>
      </form>
        </>
      )}
    </div>
  );
}
