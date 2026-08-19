/**
 * Session state for the whole app: wraps Supabase's `onAuthStateChange`
 * listener (which also fires on Supabase's own automatic token refresh,
 * so `session` is always current) so every component sees the same live
 * `user`/`session`/`tenantId`/`role`, and bridges the access token to the
 * service worker on every change via src/notifications/tokenBridge.ts.
 *
 * `tenantId`/`role` are read from the JWT's `app_metadata.tenant_id` /
 * `tenant_role` claims — the same claims `003_security_rls.sql`'s sync
 * trigger keeps current from `tenant_members` (see that migration for the
 * full mechanism).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { Provider, Session, User } from "@supabase/supabase-js";
import { onUnauthorized } from "../lib/authEvents.js";
import { supabase } from "../lib/supabaseClient.js";
import { clearServiceWorkerToken, syncTokenToServiceWorker } from "../notifications/tokenBridge.js";
import type { TenantRole } from "../types/index.js";

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  tenantId: string | null;
  role: TenantRole | null;
  /** From the `is_super_admin` JWT claim (021_super_admin_claim_sync.sql, synced from platform_admins) — platform-wide, not tied to `tenantId`/`role` at all; a super admin may have neither. */
  isSuperAdmin: boolean;
  /** True only while the initial session check is in flight — distinguishes "not logged in" from "haven't checked yet" so ProtectedRoute doesn't flash the login screen on every reload. */
  isLoading: boolean;
  /** Set when api.ts's 401 interceptor forces a sign-out — Login.tsx surfaces this so the user knows *why* they're back at the login screen. Cleared on the next login attempt. */
  sessionExpiredMessage: string | null;
  login: (email: string, password: string) => Promise<void>;
  /** Redirects the browser to Google's consent screen via Supabase Auth's own OAuth flow — distinct from src/auth/googleOAuthTokens.ts's per-tenant Calendar connection, this is sign-in/sign-up only and needs the Google provider enabled in the Supabase dashboard before it does anything. */
  loginWithGoogle: () => Promise<void>;
  /** Same OAuth mechanism as loginWithGoogle, GitHub provider — also needs enabling in the Supabase dashboard (Authentication → Providers) plus its own OAuth App registered in GitHub before it does anything. */
  loginWithGithub: () => Promise<void>;
  logout: () => Promise<void>;
  /** Reads the current access token fresh from Supabase (which handles refresh internally) rather than trusting a possibly-stale closure over `session`. */
  getAccessToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function extractAppMetadataClaim(session: Session | null, claim: string): string | null {
  if (!session) {
    return null;
  }
  const appMetadata: unknown = session.user.app_metadata;
  const value = (appMetadata as Record<string, unknown> | null)?.[claim];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function extractBooleanAppMetadataClaim(session: Session | null, claim: string): boolean {
  if (!session) {
    return false;
  }
  const appMetadata: unknown = session.user.app_metadata;
  return (appMetadata as Record<string, unknown> | null)?.[claim] === true;
}

function isTenantRole(value: string | null): value is TenantRole {
  return value === "tenant_admin" || value === "staff";
}

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [sessionExpiredMessage, setSessionExpiredMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (cancelled) return;
        setSession(data.session);
        if (data.session?.access_token) {
          syncTokenToServiceWorker(data.session.access_token);
        }
        setIsLoading(false);
      })
      .catch(() => {
        if (!cancelled) setIsLoading(false);
      });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      if (nextSession?.access_token) {
        syncTokenToServiceWorker(nextSession.access_token);
      } else {
        clearServiceWorkerToken();
      }
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  // api.ts calls emitUnauthorized() when a request 401s and a token
  // refresh couldn't recover it — that's a real "your session is no
  // longer valid" signal, so force a sign-out rather than leaving the app
  // in a half-authenticated state where every request just fails again.
  useEffect(() => {
    onUnauthorized(() => {
      setSessionExpiredMessage("Your session has expired. Please sign in again.");
      void supabase.auth.signOut();
    });
  }, []);

  const login = useCallback(async (email: string, password: string): Promise<void> => {
    setSessionExpiredMessage(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      throw new Error(error.message);
    }
  }, []);

  /**
   * Full-page redirect to the given provider's consent screen; the browser
   * comes back to `redirectTo` with a session already established
   * (Supabase's own OAuth callback handling, detectSessionInUrl). Works
   * for both a new user's first sign-up and a returning user's sign-in —
   * Supabase treats both the same way for an OAuth provider, there's no
   * separate "register with Google/GitHub" call, which is exactly why
   * this always lands on /onboarding rather than /admin/dashboard
   * directly: tenant_id/tenant_role only exist for a user once they own a
   * tenant (003_security_rls.sql's seed_owner_as_tenant_admin trigger),
   * and there's no way to know from here alone whether this account
   * already has one or needs OnboardingPage.tsx's business-info form.
   * OnboardingPage checks tenantId itself and redirects straight through
   * to the dashboard for a returning user, so this is a no-op detour for
   * that case, not a wrong guess either way. Shared by loginWithGoogle and
   * loginWithGithub below — identical mechanism, only the provider differs.
   */
  const loginWithProvider = useCallback(async (provider: Provider): Promise<void> => {
    setSessionExpiredMessage(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: `${window.location.origin}/onboarding` },
    });
    if (error) {
      throw new Error(error.message);
    }
  }, []);

  const loginWithGoogle = useCallback((): Promise<void> => loginWithProvider("google"), [loginWithProvider]);
  const loginWithGithub = useCallback((): Promise<void> => loginWithProvider("github"), [loginWithProvider]);

  const logout = useCallback(async (): Promise<void> => {
    const { error } = await supabase.auth.signOut();
    if (error) {
      throw new Error(error.message);
    }
  }, []);

  const getAccessToken = useCallback(async (): Promise<string | null> => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  }, []);

  const value = useMemo<AuthContextValue>(() => {
    const role = extractAppMetadataClaim(session, "tenant_role");
    return {
      user: session?.user ?? null,
      session,
      tenantId: extractAppMetadataClaim(session, "tenant_id"),
      role: isTenantRole(role) ? role : null,
      isSuperAdmin: extractBooleanAppMetadataClaim(session, "is_super_admin"),
      isLoading,
      sessionExpiredMessage,
      login,
      loginWithGoogle,
      loginWithGithub,
      logout,
      getAccessToken,
    };
  }, [session, isLoading, sessionExpiredMessage, login, loginWithGoogle, loginWithGithub, logout, getAccessToken]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider.");
  }
  return context;
}
