-- Per-tenant Google OAuth connection, additive alongside the existing
-- platform-wide service-account integration (src/calendar/googleCalendarEngine.ts,
-- src/auth/googleServiceAccount.ts) — a tenant that connects their own
-- Google account via OAuth is used in preference to the shared service
-- account (see googleCalendarEngine.ts's authorizedFetch), but tenants who
-- never connect keep working exactly as before, unchanged.
--
-- google_calendar_id already exists (013 and earlier) and is reused as-is
-- for the OAuth path too — it means the same thing either way: which
-- calendar the AI reads/writes on this tenant's behalf.
--
-- Tokens are encrypted at rest by the application layer (AES-256-GCM, see
-- src/auth/googleOAuthTokens.ts) before being written here — this column
-- never holds a usable plaintext token, matching the existing
-- twilio_auth_token/api_key_hash precedent of "sensitive columns exist on
-- the row but are deliberately never mapped into the shared Tenant type
-- returned by getTenantById" (see toTenant() in src/db/supabase.ts).
alter table public.tenants
  add column if not exists google_access_token text,
  add column if not exists google_refresh_token text,
  add column if not exists google_token_expiry timestamptz,
  add column if not exists google_sync_enabled boolean not null default false;

comment on column public.tenants.google_access_token is
  'AES-256-GCM encrypted OAuth access token for this tenant''s own connected Google account. Never returned by getTenantById/toTenant() — see getGoogleOAuthTokenRow.';
comment on column public.tenants.google_refresh_token is
  'AES-256-GCM encrypted OAuth refresh token — used to mint new access tokens without re-consent. Same exposure rules as google_access_token.';
comment on column public.tenants.google_token_expiry is
  'Expiry instant of the current (encrypted) access token — checked with a 5-minute buffer before use, see getValidGoogleOAuthAccessToken.';
comment on column public.tenants.google_sync_enabled is
  'True once a tenant has completed the OAuth consent flow and has a usable token pair. False (default) means the platform service-account path is used instead — see googleCalendarEngine.ts.';
