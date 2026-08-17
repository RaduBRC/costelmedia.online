-- 006_conversation_logs.sql
-- Per-message tone history. `client_profiles` only ever held the *current*
-- formality/style snapshot — there was nowhere for toneRefiner's
-- "average formality + sentiment progression over the last 5 interactions"
-- to read from. Every call to the agent's tone-assessment pass now inserts
-- one row here (see src/agent/groqAgent.ts), and
-- src/agent/toneRefiner.ts reads the most recent rows back out.

create type message_sentiment as enum ('positive', 'neutral', 'negative', 'frustrated');

create table if not exists public.conversation_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  client_id uuid not null references public.client_profiles (id) on delete cascade,
  message text not null,
  formality_score smallint not null check (formality_score between 1 and 5),
  urgency smallint not null check (urgency between 1 and 5),
  sentiment message_sentiment not null,
  tone_note text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists conversation_logs_client_recent_idx
  on public.conversation_logs (client_id, created_at desc);

alter table public.conversation_logs enable row level security;

create policy "conversation_logs_scoped_to_tenant_members"
  on public.conversation_logs for all
  using (tenant_id = public.current_tenant_id() or public.is_super_admin())
  with check (tenant_id = public.current_tenant_id() or public.is_super_admin());
