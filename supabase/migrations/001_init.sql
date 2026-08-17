-- 001_init.sql
-- Core multi-tenant schema: tenants, client_profiles, appointments.
--
-- RLS is enabled on every table. The backend talks to Supabase with the
-- service_role key (which bypasses RLS), so these policies exist to protect
-- the tables when queried directly via PostgREST with an end-user JWT (e.g.
-- a future tenant-admin login), scoped through `tenants.owner_user_id`.

create extension if not exists "pgcrypto";

create type business_type as enum ('restaurant', 'clinic', 'callcenter');
create type appointment_status as enum ('confirmed', 'cancelled', 'rescheduled');

-- ---------------------------------------------------------------------------
-- tenants
-- ---------------------------------------------------------------------------
create table if not exists public.tenants (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  business_type business_type not null,
  google_calendar_id text not null,
  timezone text not null default 'UTC',
  -- Per-weekday open hours, e.g.
  -- {"monday": {"start": "09:00", "end": "17:00"}, "tuesday": null, ...}
  -- A null value for a weekday means closed that day.
  working_hours jsonb not null default '{
    "monday": {"start": "09:00", "end": "17:00"},
    "tuesday": {"start": "09:00", "end": "17:00"},
    "wednesday": {"start": "09:00", "end": "17:00"},
    "thursday": {"start": "09:00", "end": "17:00"},
    "friday": {"start": "09:00", "end": "17:00"},
    "saturday": null,
    "sunday": null
  }'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.tenants enable row level security;

create policy "tenants_select_own"
  on public.tenants for select
  using (owner_user_id = auth.uid());

create policy "tenants_modify_own"
  on public.tenants for all
  using (owner_user_id = auth.uid())
  with check (owner_user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- client_profiles
-- ---------------------------------------------------------------------------
create table if not exists public.client_profiles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  phone_number text not null,
  full_name text,
  formality_score smallint not null default 3 check (formality_score between 1 and 5),
  communication_style text not null default '',
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, phone_number)
);

create index if not exists client_profiles_tenant_phone_idx
  on public.client_profiles (tenant_id, phone_number);

alter table public.client_profiles enable row level security;

create policy "client_profiles_scoped_to_owned_tenant"
  on public.client_profiles for all
  using (tenant_id in (select id from public.tenants where owner_user_id = auth.uid()))
  with check (tenant_id in (select id from public.tenants where owner_user_id = auth.uid()));

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger client_profiles_set_updated_at
  before update on public.client_profiles
  for each row
  execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- appointments
-- ---------------------------------------------------------------------------
create table if not exists public.appointments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  client_id uuid references public.client_profiles (id) on delete set null,
  google_event_id text,
  service_type text not null,
  start_time timestamptz not null,
  end_time timestamptz not null,
  status appointment_status not null default 'confirmed',
  created_at timestamptz not null default now(),
  constraint appointments_time_range_valid check (end_time > start_time)
);

create index if not exists appointments_tenant_start_idx
  on public.appointments (tenant_id, start_time);

alter table public.appointments enable row level security;

create policy "appointments_scoped_to_owned_tenant"
  on public.appointments for all
  using (tenant_id in (select id from public.tenants where owner_user_id = auth.uid()))
  with check (tenant_id in (select id from public.tenants where owner_user_id = auth.uid()));
