-- 015_services_catalog.sql
-- Real, normalized services catalog with pricing — appointments.service_type
-- (001_init.sql) stays exactly as-is (free text, already relied on by
-- groqAgent.ts's tool contract, Google Calendar sync, and the analytics
-- engine); this is additive, not a replacement. What this unlocks that
-- free text couldn't: a real price per service (needed for revenue
-- reporting later) and a per-service active/inactive toggle a tenant can
-- flip without deleting history.
create table if not exists public.services (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null,
  duration_minutes integer not null check (duration_minutes > 0),
  -- Stored in minor units (cents/bani), like every other system that
  -- avoids floating-point money — RON/EUR display formatting is a
  -- frontend concern (see ServicesPage.tsx), not a schema one.
  price_minor_units integer not null check (price_minor_units >= 0),
  currency text not null default 'RON' check (currency in ('RON', 'EUR')),
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists services_tenant_idx on public.services (tenant_id);
create index if not exists services_tenant_active_idx on public.services (tenant_id, is_active) where is_active;

alter table public.services enable row level security;

-- Same tenant-scoped read/write shape as every other tenant-owned table
-- (appointments, client_profiles — see 003_security_rls.sql) — any
-- tenant member can read/create/update their own tenant's services,
-- only a tenant_admin can delete one.
create policy "services_select_tenant_members"
  on public.services for select
  using (tenant_id = public.current_tenant_id() or public.is_super_admin());

create policy "services_write_tenant_members"
  on public.services for insert
  with check (tenant_id = public.current_tenant_id() or public.is_super_admin());

create policy "services_update_tenant_members"
  on public.services for update
  using (tenant_id = public.current_tenant_id() or public.is_super_admin())
  with check (tenant_id = public.current_tenant_id() or public.is_super_admin());

create policy "services_delete_tenant_admin"
  on public.services for delete
  using (
    (tenant_id = public.current_tenant_id() and public.current_tenant_role() = 'tenant_admin')
    or public.is_super_admin()
  );
