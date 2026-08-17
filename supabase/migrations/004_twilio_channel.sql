-- 004_twilio_channel.sql
-- Per-tenant Twilio routing. `twilio_phone_number` is how an inbound
-- webhook's `To` field resolves to a tenant. `twilio_account_sid` /
-- `twilio_auth_token` are optional per-tenant overrides for businesses that
-- bring their own Twilio account; when null, the platform's own
-- TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN (env vars) are used instead — the
-- common case for the zero-cost shared-account setup.
--
-- Note: unlike api_key_hash, the auth token can't be stored as a one-way
-- hash — Twilio's request signature is an HMAC computed with the raw
-- token, which requires the original secret to verify, not just a hash of
-- it. Storing it in plaintext here is what Twilio's model requires; treat
-- this column as sensitive (restrict who can SELECT it, consider
-- pgcrypto/Vault encryption-at-rest for a production deployment).

alter table public.tenants add column if not exists twilio_phone_number text;
alter table public.tenants add column if not exists twilio_account_sid text;
alter table public.tenants add column if not exists twilio_auth_token text;
alter table public.tenants add column if not exists whatsapp_enabled boolean not null default false;

create unique index if not exists tenants_twilio_phone_number_idx
  on public.tenants (twilio_phone_number)
  where twilio_phone_number is not null;
