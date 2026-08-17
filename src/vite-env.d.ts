/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Backend API origin, e.g. "https://ai-booking-platform-api.onrender.com".
   * Leave unset for same-origin deployments (local dev via the Vite proxy,
   * or a deploy that serves both frontend and API from one origin) — the
   * frontend then falls back to relative `/api/...` requests.
   */
  readonly VITE_API_BASE_URL?: string;
  /** Supabase project URL — same project as the backend's SUPABASE_URL, just re-declared with the VITE_ prefix Vite requires to expose it to browser code. */
  readonly VITE_SUPABASE_URL: string;
  /** Supabase anon/publishable key — safe for the browser bundle (RLS-protected), unlike the backend's SUPABASE_SERVICE_ROLE_KEY. */
  readonly VITE_SUPABASE_ANON_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
