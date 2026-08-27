-- 023_voice_improvements.sql
-- Six additions backing this round of voice-pipeline improvements:
--
-- 1. tenants.stt_strategy — 'deepgram_only' (fast/cheap, default) vs
--    'whisper_hybrid' (Deepgram for real-time turn-detection/barge-in,
--    Whisper for the actual transcription — see whisperStt.ts). A free
--    toggle for every tenant, not plan-gated: this is a latency/cost vs
--    accuracy tradeoff the tenant should choose deliberately, not
--    something Starter/VIP status should silently decide for them.
--
-- 2. knowledge_gaps — every time the voice/chat agent falls back to "I
--    don't know" (neither the tenant's own FAQs nor the niche fallback
--    knowledge base, promptBuilder.ts/nicheKnowledgeBase.ts, covered the
--    question), the caller's actual question gets logged here instead of
--    just vanishing — a super admin (cross-tenant, by business type) or a
--    tenant admin (their own) can turn a real recurring question into a
--    real FAQ in minutes instead of guessing what callers actually ask.
--
-- 3. voice_call_metrics + service_failures — the "why is this call
--    slow/broken" visibility this pipeline never had: per-turn latency
--    breakdown (Whisper/LLM/TTS) and a persisted log of TTS/STT failures
--    that previously only ever hit a server console someone would have
--    to be tailing live to notice.
--
-- 4. call_transcripts.needs_follow_up — set when a caller shows
--    sustained frustration (callSession.ts's consecutive-frustrated-turn
--    tracking) so a human can follow up after the fact; this migration
--    only adds the column, the escalation logic itself lives in code.
--
-- 5. (Twilio number provisioning needs no new schema — it just writes to
--    tenants.twilio_phone_number, already a column.)
--
-- 6. usage_events — a simple per-call/per-message event log (Groq tokens,
--    ElevenLabs characters, Whisper audio seconds, Twilio messages) so a
--    tenant's actual usage/cost is visible instead of invisible until a
--    provider bill arrives.

alter table public.tenants
  add column if not exists stt_strategy text not null default 'deepgram_only' check (stt_strategy in ('deepgram_only', 'whisper_hybrid'));

comment on column public.tenants.stt_strategy is
  'deepgram_only (fast/cheap) vs whisper_hybrid (Deepgram for turn-detection + Whisper for transcription, higher accuracy/latency/cost) — see src/telephony/voiceStreamServer.ts.';

create table if not exists public.knowledge_gaps (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  business_type text not null,
  question text not null,
  channel text not null check (channel in ('ai_chat', 'ai_voice')),
  created_at timestamptz not null default now()
);

create index if not exists knowledge_gaps_tenant_idx on public.knowledge_gaps (tenant_id, created_at desc);
create index if not exists knowledge_gaps_business_type_idx on public.knowledge_gaps (business_type, created_at desc);

alter table public.knowledge_gaps enable row level security;

create policy "knowledge_gaps_select_tenant_members"
  on public.knowledge_gaps for select
  using (tenant_id = public.current_tenant_id() or public.is_super_admin());

-- No tenant-facing insert policy — these are only ever written by
-- server-side code via the service-role client (bypasses RLS by design,
-- same as every other system-generated log table in this schema), never
-- directly by a tenant's own request.

create table if not exists public.voice_call_metrics (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  stream_sid text not null,
  stt_strategy text not null,
  whisper_used boolean not null default false,
  whisper_latency_ms integer,
  llm_latency_ms integer,
  tts_first_byte_latency_ms integer,
  total_turn_latency_ms integer,
  elevenlabs_fallback_used boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists voice_call_metrics_tenant_idx on public.voice_call_metrics (tenant_id, created_at desc);

alter table public.voice_call_metrics enable row level security;

create policy "voice_call_metrics_select_tenant_members"
  on public.voice_call_metrics for select
  using (tenant_id = public.current_tenant_id() or public.is_super_admin());

create table if not exists public.service_failures (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants (id) on delete cascade,
  service text not null check (service in ('elevenlabs', 'whisper', 'deepgram', 'groq', 'twilio')),
  error_message text not null,
  created_at timestamptz not null default now()
);

create index if not exists service_failures_tenant_idx on public.service_failures (tenant_id, created_at desc);
create index if not exists service_failures_service_idx on public.service_failures (service, created_at desc);

alter table public.service_failures enable row level security;

create policy "service_failures_select_tenant_members"
  on public.service_failures for select
  using (tenant_id = public.current_tenant_id() or public.is_super_admin());

alter table public.call_transcripts
  add column if not exists needs_follow_up boolean not null default false;

comment on column public.call_transcripts.needs_follow_up is
  'Set when the caller showed sustained frustration during the call (callSession.ts) — surfaced as a dashboard badge so a human can follow up.';

create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  service text not null check (service in ('groq_llm', 'groq_whisper', 'elevenlabs_tts', 'twilio_sms', 'twilio_voice')),
  quantity numeric not null check (quantity >= 0),
  unit text not null,
  created_at timestamptz not null default now()
);

create index if not exists usage_events_tenant_service_idx on public.usage_events (tenant_id, service, created_at desc);

alter table public.usage_events enable row level security;

create policy "usage_events_select_tenant_members"
  on public.usage_events for select
  using (tenant_id = public.current_tenant_id() or public.is_super_admin());
