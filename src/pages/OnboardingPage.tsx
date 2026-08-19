/**
 * /onboarding — where loginWithGoogle (AuthContext.tsx) always lands.
 * Two cases, told apart by whether a tenant_id claim already exists:
 *   - Returning user (already owns a tenant): redirect straight through
 *     to the dashboard, no form shown — this page is a no-op detour for them.
 *   - Brand-new Google sign-in (no tenant yet): show the same business-info
 *     form RegisterPage.tsx's email/password flow already collects
 *     upfront, then POST /api/v1/tenants/onboard to create it.
 *
 * After onboarding succeeds, the *current* session's JWT still doesn't
 * carry the new tenant_id/tenant_role claim — 003_security_rls.sql's
 * claim-sync trigger updated auth.users, but a JWT already issued doesn't
 * retroactively change. supabase.auth.refreshSession() forces a new one
 * before navigating to the dashboard; skipping that step would land the
 * user on "your account isn't linked to a tenant yet" despite the tenant
 * existing.
 */
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { AlertCircle, Loader2, Sparkles } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { onboardTenant } from "../lib/api.js";
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

const inputClass =
  "mt-1 min-h-12 w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-base text-slate-900 outline-none focus:border-violet-500 sm:text-sm dark:border-slate-700 dark:text-slate-100";

export default function OnboardingPage(): JSX.Element {
  const { tenantId, isLoading, user } = useAuth();
  const navigate = useNavigate();
  const [businessName, setBusinessName] = useState("");
  const [businessType, setBusinessType] = useState<BusinessType>("clinic");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Returning user — already has a tenant, nothing to collect.
  useEffect(() => {
    if (!isLoading && tenantId) {
      void navigate("/admin/dashboard", { replace: true });
    }
  }, [isLoading, tenantId, navigate]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    onboardTenant({ businessName: businessName.trim(), businessType })
      .then(() => supabase.auth.refreshSession())
      .then(() => {
        void navigate("/admin/dashboard", { replace: true });
      })
      .catch((submitError: unknown) => {
        setError(submitError instanceof Error ? submitError.message : "Failed to finish setting up your account.");
      })
      .finally(() => {
        setIsSubmitting(false);
      });
  };

  if (isLoading || tenantId) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-slate-950">
        <Loader2 className="h-6 w-6 animate-spin text-violet-600" />
      </div>
    );
  }

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

        {error && (
          <div
            role="alert"
            className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300"
          >
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
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
            disabled={isSubmitting}
            className="flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-medium text-white transition active:scale-[0.98] active:bg-violet-700 hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {isSubmitting ? "Setting up…" : "Finish setup"}
          </button>
        </form>
      </div>
    </div>
  );
}
