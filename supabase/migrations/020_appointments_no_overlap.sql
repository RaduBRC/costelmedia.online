-- 020_appointments_no_overlap.sql
-- Closes a real race window: bookSlot's own conflict re-check
-- (googleCalendarEngine.ts, added after live testing caught two different
-- clients both getting confirmed into the identical slot) is a
-- check-then-write, not atomic — two requests landing within the same few
-- milliseconds could both pass the check before either writes. This adds
-- the actual database-level guarantee: Postgres physically refuses a
-- second overlapping *confirmed* appointment for the same tenant, no
-- matter how many concurrent requests race for it.
--
-- btree_gist is what lets a GiST exclusion index use a plain equality
-- comparison (tenant_id with =) alongside the range-overlap comparison
-- (with &&) in the same constraint — GiST doesn't support = natively on
-- its own.
create extension if not exists btree_gist;

alter table public.appointments
  add constraint appointments_no_overlap
  exclude using gist (
    tenant_id with =,
    tstzrange(start_time, end_time, '[)') with &&
  )
  where (status = 'confirmed');
