-- 007_booking_channel.sql
-- Which channel actually created an appointment. Until now every booking
-- went through the AI chat agent, so there was no distinction to make —
-- the voice agent (src/telephony/) and the offline-sync staff-booking
-- endpoint (src/db/offlineDb.ts's sync target) both need one, and it's
-- what makes the analytics "AI agent efficiency" metric
-- (009_analytics_views.sql) a real measurement instead of a guess.

create type booking_channel as enum ('ai_chat', 'ai_voice', 'staff_manual');

alter table public.appointments add column if not exists booking_channel booking_channel not null default 'ai_chat';

create index if not exists appointments_tenant_channel_idx on public.appointments (tenant_id, booking_channel);
