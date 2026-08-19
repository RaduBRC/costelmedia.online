/**
 * /onboarding — a two-step wizard, reached from three places: a brand-new
 * Google sign-in (loginWithGoogle, AuthContext.tsx — no tenant yet), a
 * returning Google user (already owns a tenant), and now also right after
 * RegisterPage.tsx's email/password sign-up (see that file's own comment
 * for why it redirects here too instead of straight to the dashboard).
 *
 * Step 1 — business info: shown only if this account owns no tenant yet.
 * Submits to POST /api/v1/tenants/onboard, which creates the tenant and
 * (via 003_security_rls.sql's seed_owner_as_tenant_admin trigger) makes
 * this user its tenant_admin.
 *
 * Step 2 — auto-generate agent configuration: shown once a tenant exists,
 * whether that's because Step 1 just ran or because this account already
 * had one on arrival. A short free-text description of the business goes
 * to POST /api/tenants/:tenantId/auto-configure (src/agent/autoConfigurator.ts),
 * which uses Groq to generate and save a real greeting, services, FAQs,
 * and required-booking-fields in one shot — the alternative being a blank
 * Settings/Services/FAQs page a non-technical owner has to fill in one
 * field at a time. Always skippable ("Skip for now") — this is a
 * convenience, never a blocker to reaching the dashboard.
 *
 * After Step 1 succeeds, the *current* session's JWT still doesn't carry
 * the new tenant_id/tenant_role claim — 003_security_rls.sql's claim-sync
 * trigger updated auth.users, but a JWT already issued doesn't
 * retroactively change. supabase.auth.refreshSession() forces a new one
 * in the background (not awaited before showing Step 2, which uses the
 * tenantId from onboardTenant()'s own response instead) so that by the
 * time the user actually navigates to /admin/dashboard, DashboardLayout's
 * own tenantId check already sees it.
 */
import { useState } from "react";
import type { FormEvent } from "react";
import { AlertCircle, Check, Loader2, Sparkles, Wand2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { autoConfigureTenant, onboardTenant } from "../lib/api.js";
import type { AutoConfigureResult } from "../lib/api.js";
import { supabase } from "../lib/supabaseClient.js";
import { useAuth } from "../context/AuthContext.js";
import type { BusinessType } from "../types/index.js";

const BUSINESS_TYPES: { value: BusinessType; label: string }[] = [
  { value: "clinic", label: "Medical clinic" },
  { value: "restaurant", label: "Restaurant" },
  { value: "callcenter", label: "Call center" },
  { value: "auto_shop", label: "Auto repair shop" },
  { value: "salon", label: "Hair / beauty salon" },
  { value: "legal_services", label: "Professional services / Legal" },
  { value: "general_services", label: "General / other business" },
];

const DESCRIPTION_PLACEHOLDER =
  "e.g. We're a family-owned auto repair shop in Cluj specializing in European cars — oil changes, brake service, and full diagnostics. We're open Monday to Saturday and usually book 30-60 minute slots depending on the job.";

const inputClass =
  "mt-1 min-h-12 w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-base text-slate-900 outline-none focus:border-violet-500 sm:text-sm dark:border-slate-700 dark:text-slate-100";

export default function OnboardingPage(): JSX.Element {
  const { tenantId, isLoading, user } = useAuth();
  const navigate = useNavigate();

  // Step 1 state
  const [businessName, setBusinessName] = useState("");
  const [businessType, setBusinessType] = useState<BusinessType>("clinic");
  const [step1Error, setStep1Error] = useState<string | null>(null);
  const [isSubmittingStep1, setIsSubmittingStep1] = useState(false);
  // Set from onboardTenant()'s own response the instant Step 1 succeeds —
  // deliberately NOT waiting on the `tenantId` context claim (see file
  // header), so Step 2 can render immediately rather than however long
  // refreshSession() + the next re-render takes.
  const [justCreatedTenantId, setJustCreatedTenantId] = useState<string | null>(null);

  // Step 2 state
  const [description, setDescription] = useState("");
  const [step2Error, setStep2Error] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationResult, setGenerationResult] = useState<AutoConfigureResult | null>(null);

  const effectiveTenantId = justCreatedTenantId ?? tenantId;

  const handleStep1Submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setStep1Error(null);
    setIsSubmittingStep1(true);
    onboardTenant({ businessName: businessName.trim(), businessType })
      .then((result) => {
        setJustCreatedTenantId(result.tenantId);
        // Fire-and-forget — see file header. Step 2 doesn't wait on this.
        void supabase.auth.refreshSession();
      })
      .catch((submitError: unknown) => {
        setStep1Error(submitError instanceof Error ? submitError.message : "Failed to finish setting up your account.");
      })
      .finally(() => {
        setIsSubmittingStep1(false);
      });
  };

  const handleGenerate = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!effectiveTenantId) return;
    setStep2Error(null);
    setIsGenerating(true);
    autoConfigureTenant(effectiveTenantId, description.trim())
      .then(setGenerationResult)
      .catch((genError: unknown) => {
        setStep2Error(genError instanceof Error ? genError.message : "Failed to generate a configuration. You can still edit everything manually in Settings.");
      })
      .finally(() => {
        setIsGenerating(false);
      });
  };

  const goToDashboard = (): void => {
    void navigate("/admin/dashboard", { replace: true });
  };

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-slate-950">
        <Loader2 className="h-6 w-6 animate-spin text-violet-600" />
      </div>
    );
  }

  // ---------------------------------------------------------------------
  // Step 1 — business info (only reached with no tenant at all yet)
  // ---------------------------------------------------------------------
  if (!effectiveTenantId) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 dark:bg-slate-950">
        <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="mb-6 flex flex-col items-center gap-2 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-violet-600 text-white">
              <Sparkles className="h-5 w-5" />
            </div>
            <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-50">One more step</h1>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {user?.email ? `Welcome, ${user.email}. ` : ""}Tell us about your business to finish setting up your account.
            </p>
          </div>

          {step1Error && (
            <div
              role="alert"
              className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300"
            >
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{step1Error}</span>
            </div>
          )}

          <form onSubmit={handleStep1Submit} className="space-y-4" noValidate>
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
              Business name
              <input required value={businessName} onChange={(event) => setBusinessName(event.target.value)} className={inputClass} />
            </label>
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
            <button
              type="submit"
              disabled={isSubmittingStep1}
              className="flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-medium text-white transition active:scale-[0.98] active:bg-violet-700 hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSubmittingStep1 && <Loader2 className="h-4 w-4 animate-spin" />}
              {isSubmittingStep1 ? "Setting up…" : "Continue"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------
  // Step 2 — auto-generate agent configuration (always skippable)
  // ---------------------------------------------------------------------
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10 dark:bg-slate-950">
      <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-8 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-violet-600 text-white">
            <Wand2 className="h-5 w-5" />
          </div>
          <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-50">Auto-generate your AI agent</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Describe your business in a sentence or two and we'll draft a greeting, a services list, FAQs, and what your agent should ask
            callers before booking — all editable afterward in Settings.
          </p>
        </div>

        {generationResult ? (
          <div className="space-y-4">
            <div
              role="status"
              className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-3 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
            >
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div className="space-y-1">
                <p className="font-medium">Configuration generated.</p>
                <p>
                  {generationResult.createdServices.length} service{generationResult.createdServices.length === 1 ? "" : "s"} and{" "}
                  {generationResult.createdFaqs.length} FAQ{generationResult.createdFaqs.length === 1 ? "" : "s"} added — review and edit
                  anytime in Settings, Services, and FAQs.
                </p>
              </div>
            </div>
            <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
              <p className="mb-1 font-medium text-slate-700 dark:text-slate-200">New greeting:</p>
              <p className="italic">"{generationResult.greetingMessage.replaceAll("{company_name}", businessName || "your business")}"</p>
            </div>
            <button
              type="button"
              onClick={goToDashboard}
              className="flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-medium text-white transition active:scale-[0.98] active:bg-violet-700 hover:bg-violet-500"
            >
              Go to dashboard
            </button>
          </div>
        ) : (
          <form onSubmit={handleGenerate} className="space-y-4" noValidate>
            {step2Error && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300"
              >
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{step2Error}</span>
              </div>
            )}
            <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
              Describe your business
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={5}
                placeholder={DESCRIPTION_PLACEHOLDER}
                className={inputClass}
              />
            </label>
            <button
              type="submit"
              disabled={isGenerating || !description.trim()}
              className="flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-medium text-white transition active:scale-[0.98] active:bg-violet-700 hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isGenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
              {isGenerating ? "Generating…" : "Auto-Generate Agent Configuration"}
            </button>
            <button
              type="button"
              onClick={goToDashboard}
              disabled={isGenerating}
              className="flex min-h-11 w-full items-center justify-center text-xs font-medium text-slate-500 transition hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-60 dark:text-slate-400 dark:hover:text-slate-200"
            >
              Skip for now — I'll set this up manually
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
