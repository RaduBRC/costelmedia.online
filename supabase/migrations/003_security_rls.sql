-- 003_security_rls.sql
-- Multi-tenant RBAC + stricter RLS. Renumbered from the requested
-- "002_security_rls.sql" because 002 is already taken by
-- 002_push_subscriptions.sql — filenames are applied in order, so it can't
-- be reused; this is 003 instead.
--
-- Design notes:
--   * Roles: 'tenant_admin' and 'staff' are per-tenant memberships
--     (tenant_members). 'super_admin' is platform-wide, not tied to any one
--     tenant, so it's modeled separately (platform_admins) rather than as a
--     tenant_role value — a super_admin isn't "an admin of tenant X", they
--     bypass tenant scoping entirely.
--   * public.current_tenant_id() / public.current_tenant_role() read from the
--     JWT's app_metadata rather than querying tenant_members per row. This
--     assumes one active tenant per session, set via a custom claim synced
--     from tenant_members by the trigger below. Claim changes only take
--     effect on the user's next token refresh — a known tradeoff of this
--     pattern, not a bug.
--   * None of this affects the backend's existing service-role Supabase
--     client (src/db/supabase.ts) — the service role bypasses RLS
--     entirely, as it always has. These policies matter for any future
--     direct-from-browser Supabase queries using a user's own JWT.
--   * current_tenant_id()/current_tenant_role() live in `public`, not
--     `auth` — most Supabase projects' migration role can't create
--     objects inside the `auth` schema (CREATE FUNCTION there requires
--     elevated privileges the SQL Editor has but the Management API and
--     some CLI-linked roles don't). Living in `public` works identically
--     for every RLS policy below; only the namespace differs.

create type tenant_role as enum ('tenant_admin', 'staff');

-- ---------------------------------------------------------------------------
-- tenant_members — links auth.users to tenants with a role
-- ---------------------------------------------------------------------------
create table if not exists public.tenant_members (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role tenant_role not null default 'staff',
  created_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);

create index if not exists tenant_members_user_idx on public.tenant_members (user_id);

alter table public.tenant_members enable row level security;

-- ---------------------------------------------------------------------------
-- platform_admins — super_admin is a platform-wide capability, not a
-- per-tenant role, so it isn't a tenant_members row.
-- ---------------------------------------------------------------------------
create table if not exists public.platform_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.platform_admins enable row level security;

create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid());
$$;

create policy "tenant_members_readable_by_super_admin"
  on public.tenant_members for select
  using (public.is_super_admin());

create policy "platform_admins_readable_by_super_admin"
  on public.platform_admins for select
  using (public.is_super_admin());

-- ---------------------------------------------------------------------------
-- JWT claim sync: keep app_metadata.tenant_id / tenant_role current
-- ---------------------------------------------------------------------------
create or replace function public.sync_user_tenant_claim()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update auth.users
  set raw_app_meta_data =
    coalesce(raw_app_meta_data, '{}'::jsonb) ||
    jsonb_build_object('tenant_id', NEW.tenant_id, 'tenant_role', NEW.role)
  where id = NEW.user_id;
  return NEW;
end;
$$;

create trigger tenant_members_sync_claim
  after insert or update on public.tenant_members
  for each row
  execute function public.sync_user_tenant_claim();

-- Seed a tenant_admin membership for a tenant's owner_user_id automatically,
-- so existing single-owner tenants (created before this migration) keep
-- working without a manual membership row.
create or replace function public.seed_owner_as_tenant_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.tenant_members (tenant_id, user_id, role)
  values (NEW.id, NEW.owner_user_id, 'tenant_admin')
  on conflict (tenant_id, user_id) do nothing;
  return NEW;
end;
$$;

create trigger tenants_seed_owner_membership
  after insert on public.tenants
  for each row
  execute function public.seed_owner_as_tenant_admin();

-- Backfill for tenants that already existed before this migration.
insert into public.tenant_members (tenant_id, user_id, role)
select id, owner_user_id, 'tenant_admin'
from public.tenants
on conflict (tenant_id, user_id) do nothing;

-- ---------------------------------------------------------------------------
-- public.current_tenant_id() / public.current_tenant_role()
-- ---------------------------------------------------------------------------
create or replace function public.current_tenant_id()
returns uuid
language sql
stable
as $$
  select nullif(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid;
$$;

create or replace function public.current_tenant_role()
returns tenant_role
language sql
stable
as $$
  select nullif(auth.jwt() -> 'app_metadata' ->> 'tenant_role', '')::tenant_role;
$$;

-- ---------------------------------------------------------------------------
-- Updated RLS policies: strict tenant isolation, `super_admin` bypass,
-- `tenant_admin`-only for destructive operations.
-- ---------------------------------------------------------------------------

-- tenants
drop policy if exists "tenants_select_own" on public.tenants;
drop policy if exists "tenants_modify_own" on public.tenants;

create policy "tenants_select_members"
  on public.tenants for select
  using (id = public.current_tenant_id() or public.is_super_admin());

create policy "tenants_insert_super_admin_only"
  on public.tenants for insert
  with check (public.is_super_admin());

create policy "tenants_update_tenant_admin"
  on public.tenants for update
  using (
    (id = public.current_tenant_id() and public.current_tenant_role() = 'tenant_admin')
    or public.is_super_admin()
  )
  with check (
    (id = public.current_tenant_id() and public.current_tenant_role() = 'tenant_admin')
    or public.is_super_admin()
  );

create policy "tenants_delete_super_admin_only"
  on public.tenants for delete
  using (public.is_super_admin());

-- client_profiles
drop policy if exists "client_profiles_scoped_to_owned_tenant" on public.client_profiles;

create policy "client_profiles_select_tenant_members"
  on public.client_profiles for select
  using (tenant_id = public.current_tenant_id() or public.is_super_admin());

create policy "client_profiles_write_tenant_members"
  on public.client_profiles for insert
  with check (tenant_id = public.current_tenant_id() or public.is_super_admin());

create policy "client_profiles_update_tenant_members"
  on public.client_profiles for update
  using (tenant_id = public.current_tenant_id() or public.is_super_admin())
  with check (tenant_id = public.current_tenant_id() or public.is_super_admin());

create policy "client_profiles_delete_tenant_admin"
  on public.client_profiles for delete
  using (
    (tenant_id = public.current_tenant_id() and public.current_tenant_role() = 'tenant_admin')
    or public.is_super_admin()
  );

-- appointments
drop policy if exists "appointments_scoped_to_owned_tenant" on public.appointments;

create policy "appointments_select_tenant_members"
  on public.appointments for select
  using (tenant_id = public.current_tenant_id() or public.is_super_admin());

create policy "appointments_write_tenant_members"
  on public.appointments for insert
  with check (tenant_id = public.current_tenant_id() or public.is_super_admin());

create policy "appointments_update_tenant_members"
  on public.appointments for update
  using (tenant_id = public.current_tenant_id() or public.is_super_admin())
  with check (tenant_id = public.current_tenant_id() or public.is_super_admin());

create policy "appointments_delete_tenant_admin"
  on public.appointments for delete
  using (
    (tenant_id = public.current_tenant_id() and public.current_tenant_role() = 'tenant_admin')
    or public.is_super_admin()
  );

-- push_subscriptions (scoped via client_profiles -> tenants join, updated
-- here for consistency with the new tenant_members-based model this
-- migration introduces — its old owner_user_id-based policy no longer
-- makes sense once tenants stop being single-owner.)
drop policy if exists "push_subscriptions_scoped_to_owned_tenant" on public.push_subscriptions;

create policy "push_subscriptions_scoped_to_tenant_members"
  on public.push_subscriptions for all
  using (
    public.is_super_admin()
    or user_id in (
      select cp.id from public.client_profiles cp where cp.tenant_id = public.current_tenant_id()
    )
  )
  with check (
    public.is_super_admin()
    or user_id in (
      select cp.id from public.client_profiles cp where cp.tenant_id = public.current_tenant_id()
    )
  );

-- tenant_members: members can see their own tenant's roster; only
-- tenant_admins can manage membership.
create policy "tenant_members_select_same_tenant"
  on public.tenant_members for select
  using (tenant_id = public.current_tenant_id() or public.is_super_admin());

create policy "tenant_members_write_tenant_admin"
  on public.tenant_members for insert
  with check (
    (tenant_id = public.current_tenant_id() and public.current_tenant_role() = 'tenant_admin')
    or public.is_super_admin()
  );

create policy "tenant_members_update_tenant_admin"
  on public.tenant_members for update
  using (
    (tenant_id = public.current_tenant_id() and public.current_tenant_role() = 'tenant_admin')
    or public.is_super_admin()
  )
  with check (
    (tenant_id = public.current_tenant_id() and public.current_tenant_role() = 'tenant_admin')
    or public.is_super_admin()
  );

create policy "tenant_members_delete_tenant_admin"
  on public.tenant_members for delete
  using (
    (tenant_id = public.current_tenant_id() and public.current_tenant_role() = 'tenant_admin')
    or public.is_super_admin()
  );

-- ---------------------------------------------------------------------------
-- API key auth (server-to-server webhook ingestion) — hash only, never the
-- raw key. requireApiKey (src/api/middleware/auth.ts) hashes the incoming
-- `X-API-Key` header with SHA-256 and compares against this column.
-- ---------------------------------------------------------------------------
alter table public.tenants add column if not exists api_key_hash text;
alter table public.tenants add column if not exists api_key_created_at timestamptz;

create unique index if not exists tenants_api_key_hash_idx
  on public.tenants (api_key_hash)
  where api_key_hash is not null;
