-- 012_tenant_voice_config.sql
-- Per-tenant voice/prompt customization — additive columns on the
-- existing `tenants` table (001_init.sql), not a new schema. This
-- project already has full multi-tenancy (tenants/client_profiles/
-- appointments, all tenant_id-scoped and RLS-protected since
-- 003_security_rls.sql, plus tenant resolution via requireTenantAuth/
-- requireApiKey and Twilio phone-number routing via
-- getTenantTwilioRoutingByPhoneNumber) — what was actually missing was
-- per-tenant ElevenLabs voice/prompt/greeting configuration, which is
-- what this migration adds.
--
-- No RLS policy changes needed: these columns live on `tenants`, which
-- already has RLS enabled with the existing tenant-scoped SELECT/UPDATE
-- policies (003_security_rls.sql) — a tenant_admin can already read/update
-- their own tenant row, a staff member can already read it, and nothing
-- here changes who can see which tenant's row.

alter table public.tenants add column if not exists elevenlabs_voice_id text;
alter table public.tenants add column if not exists system_prompt_override text;
alter table public.tenants add column if not exists greeting_message text;
alter table public.tenants add column if not exists is_active boolean not null default true;

comment on column public.tenants.elevenlabs_voice_id is
  'Per-tenant ElevenLabs voice — falls back to the ELEVENLABS_VOICE_ID env var default when null (see src/telephony/elevenLabsTts.ts).';
comment on column public.tenants.system_prompt_override is
  'Additional tenant-specific instructions appended to (not replacing) the standard booking/manners rules — see buildSystemPrompt in src/agent/promptBuilder.ts. Deliberately additive: a full replacement could let a tenant accidentally disable the safety/booking-tool-usage rules every tenant needs.';
comment on column public.tenants.greeting_message is
  'Custom voice-call opening line — supports a literal "{company_name}" placeholder, replaced with tenants.name. Falls back to the business-type-templated default (getVoiceGreeting) when null.';
comment on column public.tenants.is_active is
  'Deactivated tenants are rejected at public-facing entry points (widget chat, inbound Twilio routing) with a clear error rather than silently processed — see src/api/routes/widgetChat.ts and src/api/webhooks.ts.';
