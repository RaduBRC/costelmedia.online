/**
 * Frontend Supabase client — browser-safe (anon/publishable key only,
 * protected by RLS). Never the service-role key: that lives exclusively in
 * the backend's src/db/supabase.ts and must never reach a bundle shipped
 * to a browser.
 *
 * "Remember me" (Login.tsx): Supabase's client only takes one storage
 * adapter, fixed at creation time — it doesn't expose a per-sign-in
 * "persist or not" option. REMEMBER_ME_FLAG_KEY is a small, separate,
 * always-in-localStorage flag that the adapter below checks on every
 * read/write to decide which real storage to delegate to:
 *   - "remember me" checked (default) → localStorage, survives a full
 *     browser restart, same as Supabase's own default behavior.
 *   - unchecked → sessionStorage, which still survives a same-tab
 *     refresh (satisfying "refreshing keeps you logged in") but is
 *     cleared the moment the tab/window closes — genuine browser-session
 *     semantics, not a `beforeunload` hack (which can't reliably tell a
 *     refresh apart from a close, and would break refresh-persistence
 *     for exactly the users who unchecked the box).
 */
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error("Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY environment variables.");
}

export const REMEMBER_ME_FLAG_KEY = "aibp-remember-me";

function preferredStorage(): Storage {
  return localStorage.getItem(REMEMBER_ME_FLAG_KEY) === "false" ? sessionStorage : localStorage;
}

/** Implements Supabase's minimal storage interface (get/set/removeItem), delegating to whichever real storage preferredStorage() picks at call time. */
const rememberMeAwareStorage = {
  getItem: (key: string): string | null => preferredStorage().getItem(key),
  setItem: (key: string, value: string): void => {
    preferredStorage().setItem(key, value);
  },
  removeItem: (key: string): void => {
    preferredStorage().removeItem(key);
  },
};

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { storage: rememberMeAwareStorage },
});
