/**
 * "Continue with Google" / "Continue with GitHub" — identical on both
 * Login.tsx and RegisterPage.tsx (Supabase treats sign-in and sign-up
 * through an OAuth provider as the same call), so it lives here once
 * instead of being duplicated across both pages. Both providers land on
 * /onboarding via AuthContext's loginWithGoogle/loginWithGithub — see
 * that file for why a dedicated landing page is needed instead of going
 * straight to the dashboard.
 */
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useAuth } from "../context/AuthContext.js";

type OAuthProvider = "google" | "github";

interface OAuthButtonsProps {
  /** Called with null to clear a previous error, or a message on failure. Left to the caller so it can share one error banner with the email/password form below it. */
  onError: (message: string | null) => void;
}

function GoogleIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.47a5.53 5.53 0 0 1-2.4 3.63v3h3.88c2.27-2.09 3.57-5.17 3.57-8.82Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.07 7.95-2.91l-3.88-3c-1.08.72-2.46 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.26v3.11A12 12 0 0 0 12 24Z"
      />
      <path fill="#FBBC05" d="M5.27 14.28A7.2 7.2 0 0 1 4.89 12c0-.79.14-1.56.38-2.28V6.61H1.26A12 12 0 0 0 0 12c0 1.94.46 3.77 1.26 5.39Z" />
      <path
        fill="#EA4335"
        d="M12 4.75c1.76 0 3.34.6 4.58 1.79l3.44-3.44C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.26 6.61l4.01 3.11C6.22 6.86 8.87 4.75 12 4.75Z"
      />
    </svg>
  );
}

function GithubIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4 shrink-0" aria-hidden="true">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.69-1.28-1.69-1.04-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.09-.12-.29-.51-1.47.11-3.06 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.24 2.77.12 3.06.74.8 1.19 1.83 1.19 3.09 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.07.78 2.15 0 1.55-.01 2.8-.01 3.18 0 .31.21.67.8.55A11.5 11.5 0 0 0 23.5 12c0-6.35-5.15-11.5-11.5-11.5Z" />
    </svg>
  );
}

const PROVIDERS: { id: OAuthProvider; label: string; Icon: () => JSX.Element }[] = [
  { id: "google", label: "Continue with Google", Icon: GoogleIcon },
  { id: "github", label: "Continue with GitHub", Icon: GithubIcon },
];

export default function OAuthButtons({ onError }: OAuthButtonsProps): JSX.Element {
  const { loginWithGoogle, loginWithGithub } = useAuth();
  const [pendingProvider, setPendingProvider] = useState<OAuthProvider | null>(null);

  const handleClick = (provider: OAuthProvider): void => {
    onError(null);
    setPendingProvider(provider);
    const start = provider === "google" ? loginWithGoogle : loginWithGithub;
    start().catch((error: unknown) => {
      onError(error instanceof Error ? error.message : `${provider === "google" ? "Google" : "GitHub"} sign-in failed.`);
      setPendingProvider(null);
    });
    // No `.finally` resetting pendingProvider on success — a successful
    // call navigates the whole browser away to the provider's consent
    // screen, so there's nothing left here to reset it on.
  };

  return (
    <div className="grid grid-cols-2 gap-3">
      {PROVIDERS.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          onClick={() => handleClick(id)}
          disabled={pendingProvider !== null}
          className="flex min-h-12 items-center justify-center gap-2 rounded-lg border border-slate-300 px-3 text-sm font-medium text-slate-700 transition active:scale-[0.98] active:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:text-slate-200 dark:active:bg-slate-800"
        >
          {pendingProvider === id ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : <Icon />}
          <span className="truncate">{label}</span>
        </button>
      ))}
    </div>
  );
}
