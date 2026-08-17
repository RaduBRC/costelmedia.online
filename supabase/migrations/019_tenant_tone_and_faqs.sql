-- 019_tenant_tone_and_faqs.sql
-- Two additions for promptBuilder.ts's dynamic multi-vertical refactor:
--
-- 1. tenants.tone_of_voice — a tenant-level "brand voice" setting
--    (formal/friendly), distinct from ClientProfile.formalityScore (a
--    per-*client*, learned-over-time trait) and from the current
--    message's tone read (ToneAssessment, per-*turn*). This one is a
--    fixed persona choice the tenant sets once in Settings, same
--    lifecycle as businessType/greetingMessage.
--
-- 2. tenant_faqs — real, structured Q&A pairs injected into the system
--    prompt, same reasoning as 015_services_catalog.sql's own header
--    comment for why services got a real table instead of being crammed
--    into free text: queryable, individually editable, orderable. Reuses
--    the exact tenant-scoped RLS shape every other tenant-owned table
--    uses (see 003_security_rls.sql / 015_services_catalog.sql).
alter table public.tenants
  add column if not exists tone_of_voice text not null default 'friendly' check (tone_of_voice in ('formal', 'friendly'));

comment on column public.tenants.tone_of_voice is
  'Fixed brand-voice persona (formal/friendly) injected into every system prompt for this tenant — see promptBuilder.ts''s describeToneOfVoice.';

create table if not exists public.tenant_faqs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  question text not null,
  answer text not null,
  display_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tenant_faqs_tenant_idx on public.tenant_faqs (tenant_id);
create index if not exists tenant_faqs_tenant_active_idx on public.tenant_faqs (tenant_id, is_active) where is_active;

alter table public.tenant_faqs enable row level security;

create policy "tenant_faqs_select_tenant_members"
  on public.tenant_faqs for select
  using (tenant_id = public.current_tenant_id() or public.is_super_admin());

create policy "tenant_faqs_write_tenant_members"
  on public.tenant_faqs for insert
  with check (tenant_id = public.current_tenant_id() or public.is_super_admin());

create policy "tenant_faqs_update_tenant_members"
  on public.tenant_faqs for update
  using (tenant_id = public.current_tenant_id() or public.is_super_admin())
  with check (tenant_id = public.current_tenant_id() or public.is_super_admin());

create policy "tenant_faqs_delete_tenant_admin"
  on public.tenant_faqs for delete
  using (
    (tenant_id = public.current_tenant_id() and public.current_tenant_role() = 'tenant_admin')
    or public.is_super_admin()
  );
