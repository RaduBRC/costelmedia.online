-- 022_onboarding_plans_and_leads.sql
-- Three additions for the self-service onboarding engine:
--
-- 1. tenants.plan — the Starter/DIY vs VIP tier a tenant sits on. Starter
--    is the default for every self-registered tenant; only a super admin
--    can move a tenant to 'vip' (see PATCH /api/super-admin/tenants/:id/plan,
--    superAdmin.ts) — there's no self-serve upgrade path, by design: VIP
--    is "manual high-ticket onboarding" per the product ask, not a
--    checkbox a tenant flips on themselves.
--
-- 2. tenants.required_booking_fields — an optional, tenant-specific
--    override of promptBuilder.ts's static REQUIRED_BOOKING_INFO table.
--    Null (the default, and what every tenant has until they run the
--    auto-configurator or a human edits it some other way) means "use the
--    static per-business-type table"; a tenant that ran auto-configure
--    (src/agent/autoConfigurator.ts) gets its own tailored list here
--    instead. A plain array of short field-description strings, same
--    shape the static table already uses per business type.
--
-- 3. vip_leads — captured whenever a Starter tenant clicks "Request VIP
--    Integration" (custom CRM/ERP/WhatsApp sync, etc.) on /admin/settings.
--    Deliberately just a lead record, not a self-serve provisioning flow —
--    a human on the business side follows up and, if it closes, manually
--    flips the tenant's plan via the super-admin route above. Same
--    tenant-scoped RLS shape as tenant_faqs (019_tenant_tone_and_faqs.sql).
alter table public.tenants
  add column if not exists plan text not null default 'starter' check (plan in ('starter', 'vip'));

comment on column public.tenants.plan is
  'Starter (self-serve, hard-capped defaults) vs VIP (manually onboarded, unlocked custom integrations) — see src/api/routes/superAdmin.ts for how a tenant moves to vip.';

alter table public.tenants
  add column if not exists required_booking_fields jsonb;

comment on column public.tenants.required_booking_fields is
  'Optional tenant-specific override of promptBuilder.ts''s static per-business-type required-fields list — an array of short strings. Null means "use the static table for this business type".';

create table if not exists public.vip_leads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  requested_integrations text[] not null default '{}',
  message text,
  contact_email text,
  contact_phone text,
  status text not null default 'new' check (status in ('new', 'contacted', 'won', 'lost')),
  created_at timestamptz not null default now()
);

create index if not exists vip_leads_tenant_idx on public.vip_leads (tenant_id);
create index if not exists vip_leads_status_idx on public.vip_leads (status);

alter table public.vip_leads enable row level security;

-- Any authenticated tenant member can both submit a lead for their own
-- tenant and see their own tenant's past leads (e.g. "we already asked
-- about this") — same shape as tenant_faqs's select/insert policies.
-- There's no update/delete policy at all: a lead, once submitted, is
-- immutable from the tenant side — only a super admin (working the lead
-- manually, outside this app) or a service-role script ever changes
-- `status`, which is why there's no tenant-facing status-change policy
-- here to begin with.
create policy "vip_leads_select_tenant_members"
  on public.vip_leads for select
  using (tenant_id = public.current_tenant_id() or public.is_super_admin());

create policy "vip_leads_insert_tenant_members"
  on public.vip_leads for insert
  with check (tenant_id = public.current_tenant_id() or public.is_super_admin());
