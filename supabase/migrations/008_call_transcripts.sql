-- 008_call_transcripts.sql
-- Post-call voice transcripts (src/telephony/callSession.ts). Kept as its
-- own table rather than overloading appointments/client_profiles columns —
-- a call may span multiple turns, may or may not result in a booking, and
-- the transcript is a fundamentally different shape of data (a full
-- conversation log) than either of those tables' rows.

create table if not exists public.call_transcripts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  client_id uuid references public.client_profiles (id) on delete set null,
  appointment_id uuid references public.appointments (id) on delete set null,
  call_sid text not null,
  transcript text not null,
  duration_seconds integer not null default 0 check (duration_seconds >= 0),
  created_at timestamptz not null default now(),
  unique (call_sid)
);

create index if not exists call_transcripts_tenant_created_idx on public.call_transcripts (tenant_id, created_at desc);
create index if not exists call_transcripts_client_idx on public.call_transcripts (client_id);

alter table public.call_transcripts enable row level security;

create policy "call_transcripts_scoped_to_tenant_members"
  on public.call_transcripts for all
  using (tenant_id = public.current_tenant_id() or public.is_super_admin())
  with check (tenant_id = public.current_tenant_id() or public.is_super_admin());
