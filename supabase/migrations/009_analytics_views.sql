-- 009_analytics_views.sql
-- Renumbered from the requested "003_analytics_views.sql" — 003 was
-- already taken by 003_security_rls.sql (an earlier pass's security
-- migration); this is 009, following on from 008_call_transcripts.sql.
--
-- Security note: both objects below are deliberately created with
-- *invoker* rights (the view via `security_invoker = true`, the function
-- by simply not marking it `security definer`), not elevated ones. That
-- means row-level security on the underlying `appointments` and
-- `conversation_logs` tables is enforced against whoever is actually
-- querying — not silently bypassed. A `security definer` version of
-- `get_tone_distribution` would let any authenticated user read any
-- tenant's data just by passing a different `p_tenant_id`; with invoker
-- rights, RLS still filters to the caller's own tenant regardless of what
-- id they pass. (None of this affects the backend's service-role client,
-- which bypasses RLS either way, as it always has.)

-- Functional indexes so the daily-grouping queries below (and the view)
-- can use an index scan instead of aggregating over a full table scan.
create index if not exists appointments_tenant_start_date_idx
  on public.appointments (tenant_id, ((start_time at time zone 'UTC')::date));

create index if not exists conversation_logs_tenant_created_date_idx
  on public.conversation_logs (tenant_id, ((created_at at time zone 'UTC')::date));

create or replace view public.v_tenant_daily_stats
with (security_invoker = true) as
with appointment_days as (
  select
    tenant_id,
    (start_time at time zone 'UTC')::date as day,
    count(*) as total_appointments,
    count(*) filter (where status = 'cancelled') as cancelled_appointments,
    mode() within group (order by extract(hour from start_time at time zone 'UTC')) as peak_booking_hour
  from public.appointments
  group by tenant_id, (start_time at time zone 'UTC')::date
),
tone_days as (
  select
    tenant_id,
    (created_at at time zone 'UTC')::date as day,
    avg(formality_score) as avg_formality_score
  from public.conversation_logs
  group by tenant_id, (created_at at time zone 'UTC')::date
)
select
  coalesce(a.tenant_id, t.tenant_id) as tenant_id,
  coalesce(a.day, t.day) as day,
  coalesce(a.total_appointments, 0) as total_appointments,
  coalesce(a.cancelled_appointments, 0) as cancelled_appointments,
  case
    when coalesce(a.total_appointments, 0) = 0 then 0
    else round((a.cancelled_appointments::numeric / a.total_appointments) * 100, 1)
  end as cancellation_rate_pct,
  a.peak_booking_hour,
  round(t.avg_formality_score, 2) as avg_formality_score
from appointment_days a
full outer join tone_days t on a.tenant_id = t.tenant_id and a.day = t.day;

create or replace function public.get_tone_distribution(p_tenant_id uuid)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'formality', (
      select coalesce(jsonb_object_agg(formality_score, cnt), '{}'::jsonb)
      from (
        select formality_score, count(*) as cnt
        from public.conversation_logs
        where tenant_id = p_tenant_id
        group by formality_score
      ) f
    ),
    'sentiment', (
      select coalesce(jsonb_object_agg(sentiment, cnt), '{}'::jsonb)
      from (
        select sentiment, count(*) as cnt
        from public.conversation_logs
        where tenant_id = p_tenant_id
        group by sentiment
      ) s
    )
  );
$$;
