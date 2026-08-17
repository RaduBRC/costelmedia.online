/**
 * /reset-password — where the emailed recovery link lands. Supabase's
 * client detects the recovery token in the URL itself
 * (detectSessionInUrl, on by default) and fires a "PASSWORD_RECOVERY"
 * auth event with a temporary session already established; this page
 * just waits for that, then calls auth.updateUser({ password }) to
 * actually set the new password.
 */
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { AlertCircle, CheckCircle2, Loader2, Sparkles } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabaseClient.js";

export default function ResetPasswordPage(): JSX.Element {
  const navigate = useNavigate();
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") {
        setRecoveryReady(true);
      }
    });
    // The event can also have already fired before this listener
    // attached (a fast redirect) — a session existing at all on this
    // page is itself a reasonable signal the recovery link worked.
    void supabase.auth.getSession().then(({ data }) => {
      if (data.session) setRecoveryReady(true);
    });
    return () => subscription.unsubscribe();
  }, []);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }
    setIsSubmitting(true);
    void supabase.auth
      .updateUser({ password })
      .then(({ error: updateError }) => {
        if (updateError) {
          setError(updateError.message);
          return;
        }
        setDone(true);
        setTimeout(() => navigate("/admin/dashboard", { replace: true }), 1500);
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
          <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-50">Choose a new password</h1>
        </div>

        {!recoveryReady && !done && (
          <div
            role="status"
            className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300"
          >
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>Waiting for the reset link's token — if you opened this page directly (not from the emailed link), request a new link first.</span>
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

        {done ? (
          <div
            role="status"
            className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-300"
          >
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>Password updated — taking you to the dashboard…</span>
          </div>
        ) : (
          recoveryReady && (
            <form onSubmit={handleSubmit} className="space-y-4" noValidate>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
                New password
                <input
                  type="password"
                  required
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                  }}
                  className="mt-1 min-h-12 w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-base text-slate-900 outline-none focus:border-violet-500 sm:text-sm dark:border-slate-700 dark:text-slate-100"
                  placeholder="At least 8 characters"
                />
              </label>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
                Confirm new password
                <input
                  type="password"
                  required
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(event) => {
                    setConfirmPassword(event.target.value);
                  }}
                  className="mt-1 min-h-12 w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-base text-slate-900 outline-none focus:border-violet-500 sm:text-sm dark:border-slate-700 dark:text-slate-100"
                  placeholder="••••••••"
                />
              </label>
              <button
                type="submit"
                disabled={isSubmitting}
                className="flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-medium text-white transition active:scale-[0.98] active:bg-violet-700 hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
                {isSubmitting ? "Updating…" : "Update password"}
              </button>
            </form>
          )
        )}
      </div>
    </div>
  );
}
