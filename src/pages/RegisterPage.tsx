/**
 * /register — self-service sign-up. Email/password creates the tenant and
 * the admin account together in one call (POST /api/v1/tenants/register,
 * src/api/tenantProvisioning.ts) and logs the new admin straight in; the
 * Google button goes through AuthContext's loginWithGoogle instead, which
 * always lands on /onboarding to collect the same business info
 * afterward — see OnboardingPage.tsx for why that has to be a separate
 * step for OAuth (there's no request body to attach it to at consent time).
 */
import { useState } from "react";
import type { FormEvent } from "react";
import { AlertCircle, Loader2, LogIn, Sparkles } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { registerTenant } from "../lib/api.js";
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

const MIN_PASSWORD_LENGTH = 8;

const inputClass =
  "mt-1 min-h-12 w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-base text-slate-900 outline-none focus:border-violet-500 sm:text-sm dark:border-slate-700 dark:text-slate-100";

export default function RegisterPage(): JSX.Element {
  const { login, loginWithGoogle } = useAuth();
  const navigate = useNavigate();

  const [businessName, setBusinessName] = useState("");
  const [businessType, setBusinessType] = useState<BusinessType>("clinic");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isGoogleSubmitting, setIsGoogleSubmitting] = useState(false);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setError(null);

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }

    setIsSubmitting(true);
    registerTenant({ businessName: businessName.trim(), businessType, adminEmail: email.trim(), adminPassword: password })
      .then(() => login(email.trim(), password))
      .then(() => {
        void navigate("/admin/dashboard", { replace: true });
      })
      .catch((submitError: unknown) => {
        setError(submitError instanceof Error ? submitError.message : "Registration failed.");
      })
      .finally(() => {
        setIsSubmitting(false);
      });
  };

  const handleGoogleSignUp = (): void => {
    setError(null);
    setIsGoogleSubmitting(true);
    loginWithGoogle().catch((submitError: unknown) => {
      setError(submitError instanceof Error ? submitError.message : "Google sign-up failed.");
      setIsGoogleSubmitting(false);
    });
    // No `.finally` resetting isGoogleSubmitting on success — a
    // successful call navigates the whole browser away to Google, so
    // there's nothing left here to reset it on.
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10 dark:bg-slate-950">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-violet-600 text-white">
            <Sparkles className="h-5 w-5" />
          </div>
          <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-50">Create your account</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">Set up your AI receptionist in a couple of minutes.</p>
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

        <button
          type="button"
          onClick={handleGoogleSignUp}
          disabled={isGoogleSubmitting}
          className="flex min-h-12 w-full items-center justify-center gap-2 rounded-lg border border-slate-300 px-4 text-sm font-medium text-slate-700 transition active:scale-[0.98] active:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:text-slate-200 dark:active:bg-slate-800"
        >
          {isGoogleSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
          Sign up with Google
        </button>

        <div className="my-5 flex items-center gap-3">
          <div className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
          <span className="text-[11px] uppercase tracking-wide text-slate-400 dark:text-slate-500">or</span>
          <div className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
        </div>

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
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
            Email
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className={inputClass}
              placeholder="you@example.com"
            />
          </label>
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
            Password
            <input
              type="password"
              required
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className={inputClass}
              placeholder="At least 8 characters"
            />
          </label>
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
            Confirm password
            <input
              type="password"
              required
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              className={inputClass}
            />
          </label>

          <button
            type="submit"
            disabled={isSubmitting}
            className="flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-medium text-white transition active:scale-[0.98] active:bg-violet-700 hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {isSubmitting ? "Creating account…" : "Create account"}
          </button>
        </form>

        <p className="mt-6 text-center text-xs text-slate-500 dark:text-slate-400">
          Already have an account?{" "}
          <Link to="/login" className="font-medium text-violet-600 hover:underline dark:text-violet-400">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
