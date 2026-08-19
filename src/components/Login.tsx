import { useState } from "react";
import type { FormEvent } from "react";
import { AlertCircle, Info, LogIn, Loader2, Sparkles } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { Location } from "react-router-dom";
import { useAuth } from "../context/AuthContext.js";
import { REMEMBER_ME_FLAG_KEY } from "../lib/supabaseClient.js";

interface LocationState {
  from?: Location;
}

export default function Login(): JSX.Element {
  const { login, loginWithGoogle, sessionExpiredMessage } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isGoogleSubmitting, setIsGoogleSubmitting] = useState(false);

  const handleGoogleSignIn = (): void => {
    setError(null);
    setIsGoogleSubmitting(true);
    loginWithGoogle().catch((submitError: unknown) => {
      setError(submitError instanceof Error ? submitError.message : "Google sign-in failed.");
      setIsGoogleSubmitting(false);
    });
    // No `.finally` — a successful call navigates the whole browser away
    // to Google, so there's nothing left here to reset isGoogleSubmitting on.
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    // Must be set before login() actually calls Supabase's
    // signInWithPassword — the client's storage adapter (see
    // supabaseClient.ts) reads this flag on every write, including the
    // one that persists the new session a moment from now.
    localStorage.setItem(REMEMBER_ME_FLAG_KEY, String(rememberMe));

    void login(email, password)
      .then(() => {
        const state = location.state as LocationState | null;
        const redirectTo = state?.from ? `${state.from.pathname}${state.from.search}` : "/admin/dashboard";
        void navigate(redirectTo, { replace: true });
      })
      .catch((submitError: unknown) => {
        setError(submitError instanceof Error ? submitError.message : "Sign in failed.");
      })
      .finally(() => {
        setIsSubmitting(false);
      });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 dark:bg-slate-950">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-violet-600 text-white">
            <Sparkles className="h-5 w-5" />
          </div>
          <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-50">Sign in</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400">AI Booking Platform staff dashboard</p>
        </div>

        {/* A forced sign-out (session expired, or an API call's 401 interceptor
            gave up — see src/lib/api.ts) is a distinct situation from a bad
            login attempt below: informational, not something the user did wrong. */}
        {!error && sessionExpiredMessage && (
          <div
            role="status"
            className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300"
          >
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{sessionExpiredMessage}</span>
          </div>
        )}

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
          onClick={handleGoogleSignIn}
          disabled={isGoogleSubmitting}
          className="flex min-h-12 w-full items-center justify-center gap-2 rounded-lg border border-slate-300 px-4 text-sm font-medium text-slate-700 transition active:scale-[0.98] active:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:text-slate-200 dark:active:bg-slate-800"
        >
          {isGoogleSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
          Sign in with Google
        </button>

        <div className="my-5 flex items-center gap-3">
          <div className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
          <span className="text-[11px] uppercase tracking-wide text-slate-400 dark:text-slate-500">or</span>
          <div className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
        </div>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
            Email
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
              // text-base (16px), not text-sm (14px): iOS Safari
              // auto-zooms the page on focusing any input under 16px,
              // which is jarring and hard to undo one-handed.
              className="mt-1 min-h-12 w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-base text-slate-900 outline-none focus:border-violet-500 sm:text-sm dark:border-slate-700 dark:text-slate-100"
              placeholder="you@example.com"
            />
          </label>

          <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
            Password
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
              className="mt-1 min-h-12 w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-base text-slate-900 outline-none focus:border-violet-500 sm:text-sm dark:border-slate-700 dark:text-slate-100"
              placeholder="••••••••"
            />
          </label>

          <div className="flex items-center justify-between">
            <label className="flex min-h-11 items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(event) => {
                  setRememberMe(event.target.checked);
                }}
                className="h-4 w-4 rounded border-slate-300 text-violet-600 focus:ring-violet-500 dark:border-slate-700"
              />
              Remember me
            </label>
            <Link to="/forgot-password" className="text-xs font-medium text-violet-600 hover:underline dark:text-violet-400">
              Forgot password?
            </Link>
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-medium text-white transition active:scale-[0.98] active:bg-violet-700 hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
            {isSubmitting ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="mt-6 text-center text-xs text-slate-500 dark:text-slate-400">
          Don&apos;t have an account?{" "}
          <Link to="/register" className="font-medium text-violet-600 hover:underline dark:text-violet-400">
            Sign up
          </Link>
        </p>
      </div>
    </div>
  );
}
