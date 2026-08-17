-- 005_reminder_tracking.sql
-- Idempotency flags for the cron reminder scheduler. Each is flipped via an
-- atomic `UPDATE ... WHERE flag = false ... RETURNING`, which is what
-- actually prevents concurrent scheduler runs from double-sending — see
-- src/cron/reminderScheduler.ts for why that's sufficient without a
-- separate advisory-lock round trip.

alter table public.appointments add column if not exists reminder_24h_sent boolean not null default false;
alter table public.appointments add column if not exists reminder_2h_sent boolean not null default false;
alter table public.appointments add column if not exists feedback_requested boolean not null default false;

-- The scheduler's claim queries filter on (tenant_id, start_time) plus one
-- of these flags; a composite index keeps that a cheap index scan instead
-- of a sequential scan as the appointments table grows.
create index if not exists appointments_start_time_reminder_24h_idx
  on public.appointments (start_time)
  where reminder_24h_sent = false;

create index if not exists appointments_start_time_reminder_2h_idx
  on public.appointments (start_time)
  where reminder_2h_sent = false;

create index if not exists appointments_end_time_feedback_idx
  on public.appointments (end_time)
  where feedback_requested = false;
