-- 011_security_logs.sql
-- Backing store for the AI Security & Threat Countermeasure module
-- (src/security/) — an additive layer in front of the existing chat/voice
-- pipeline, not a replacement for it. src/agent/guardrails.ts's
-- sanitizeUserInput() (length cap + static injection-pattern stripping)
-- stays exactly as it was; this module runs *before* that, at the API
-- boundary, and can short-circuit a request before it ever reaches Groq.
--
-- Two tables:
--   * security_logs — append-only audit trail of every prompt the
--     sentinel evaluated, allowed or blocked. Useful both for incident
--     review and, longer-term, as the training corpus a human (or a
--     future classifier) would draw new blacklisted_patterns rows from —
--     "threat learning" here means that feedback loop, not an automated
--     ML pipeline this migration doesn't build.
--   * blacklisted_patterns — the sentinel's rule set, DB-backed rather
--     than hardcoded, so blocking a newly-observed attack phrasing is an
--     INSERT, not a deploy. src/security/threatSentinel.ts caches this
--     table in memory for a short TTL rather than querying it per
--     request.
--
-- RLS: enabled on both, matching every other table in this schema (see
-- 003_security_rls.sql). Only public.is_super_admin() can read either
-- table directly via PostgREST/a user JWT; the backend's own service-role
-- client (src/db/supabase.ts) bypasses RLS as it always has, which is how
-- src/security/threatSentinel.ts actually reads/writes these tables.
-- Neither table has an insert/update/delete policy for any non-service
-- role — these are backend-managed, not something a tenant or staff
-- member can edit from the dashboard.

create table if not exists public.blacklisted_patterns (
  id uuid primary key default gen_random_uuid(),
  -- JS RegExp source (no delimiters/flags — threatSentinel.ts always
  -- compiles with 'i'), e.g. 'drop\s+table'. Unique so the seed insert
  -- below can be re-run idempotently via ON CONFLICT DO NOTHING.
  pattern text not null unique,
  category text not null check (
    category in ('prompt_injection', 'role_hijack', 'system_leak', 'template_injection', 'sql_injection_probe', 'other')
  ),
  -- Contribution to threat_score when this pattern matches (0-100 scale
  -- shared with security_logs.threat_score below).
  severity smallint not null check (severity between 1 and 100),
  description text,
  is_active boolean not null default true,
  -- 'seed' = shipped with this migration, 'manual' = added later via an
  -- admin reviewing security_logs — the "dynamic adaptation" path. No
  -- automated writer sets 'learned' yet; the column exists so one could
  -- be added later without a schema change.
  source text not null default 'seed' check (source in ('seed', 'manual', 'learned')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists blacklisted_patterns_active_idx on public.blacklisted_patterns (is_active) where is_active;

alter table public.blacklisted_patterns enable row level security;

create policy "blacklisted_patterns_readable_by_super_admin"
  on public.blacklisted_patterns for select
  using (public.is_super_admin());

create table if not exists public.security_logs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  ip_address text not null,
  -- Nullable: a request can be blocked before a tenant is even resolved
  -- (e.g. a widget chat POST with a bogus tenantId), and not every
  -- caller of the sentinel has one at all (raw webhook probes).
  tenant_id uuid references public.tenants (id) on delete set null,
  channel text not null check (channel in ('ai_chat', 'ai_voice', 'widget', 'sms_whatsapp', 'generic_webhook')),
  -- Truncated to the same MAX_CHAT_INPUT_LENGTH (500) the rest of the
  -- pipeline enforces (src/agent/guardrails.ts) before it ever reaches
  -- this column — this table is an audit trail, not a second place
  -- expected to hold arbitrarily long text.
  raw_prompt text not null,
  threat_score smallint not null check (threat_score between 0 and 100),
  threat_category text not null check (
    threat_category in ('none', 'prompt_injection', 'role_hijack', 'system_leak', 'template_injection', 'sql_injection_probe', 'other')
  ),
  matched_pattern text,
  status text not null check (status in ('allowed', 'blocked'))
);

create index if not exists security_logs_created_at_idx on public.security_logs (created_at desc);
create index if not exists security_logs_ip_idx on public.security_logs (ip_address);
create index if not exists security_logs_status_idx on public.security_logs (status) where status = 'blocked';

alter table public.security_logs enable row level security;

create policy "security_logs_readable_by_super_admin"
  on public.security_logs for select
  using (public.is_super_admin());

-- ---------------------------------------------------------------------------
-- Seed patterns — mirrors (deliberately, not by accident) the categories
-- src/agent/guardrails.ts's static INJECTION_PATTERNS already cover, plus
-- SQL-injection-flavored probes that guardrails.ts doesn't check for.
-- Regex sources only (no // delimiters, no flags) — threatSentinel.ts
-- compiles each with new RegExp(pattern, 'i') (case-insensitive only;
-- no 'g', since only .test() boolean checks are done here, never
-- .exec()/.replace() in a loop, so there's no RegExp.lastIndex state to
-- worry about).
-- ---------------------------------------------------------------------------
insert into public.blacklisted_patterns (pattern, category, severity, description) values
  ('ignore\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+instructions?', 'prompt_injection', 60, 'Classic instruction-override phrasing.'),
  ('disregard\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+instructions?', 'prompt_injection', 60, 'Instruction-override variant.'),
  ('forget\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+instructions?', 'prompt_injection', 60, 'Instruction-override variant.'),
  ('new\s+instructions?\s*[:\-]', 'prompt_injection', 55, 'Attempts to inject a fresh instruction block.'),
  ('you\s+are\s+now\s+(a|an)\s+\w+', 'role_hijack', 50, 'Role/persona hijack attempt.'),
  ('pretend\s+(that\s+)?you(''re|\s+are)\s+(a|an)\s+\w+', 'role_hijack', 50, 'Role/persona hijack attempt.'),
  ('pretend\s+to\s+be\s+(a|an)\s+\w+', 'role_hijack', 50, 'Role/persona hijack attempt.'),
  ('act\s+as\s+(if\s+you(''re|\s+are)|a|an)\s+(unrestricted|unfiltered|jailbroken|different)', 'role_hijack', 65, 'Jailbreak-style role override.'),
  ('reveal\s+(your\s+)?(system\s+)?(prompt|instructions)', 'system_leak', 55, 'System-prompt exfiltration attempt.'),
  ('show\s+me\s+(your\s+)?(system\s+)?(prompt|instructions)', 'system_leak', 55, 'System-prompt exfiltration attempt.'),
  ('what\s+(are|is)\s+your\s+(system\s+)?(prompt|instructions)', 'system_leak', 45, 'System-prompt exfiltration attempt.'),
  ('<\|?(im_start|im_end|system|assistant)\|?>', 'template_injection', 65, 'Fake chat-template boundary token.'),
  ('\[\[?system\]?\]', 'template_injection', 60, 'Fake system-message marker.'),
  ('drop\s+table', 'sql_injection_probe', 45, 'SQL-injection-flavored probe (not an actual vector here — the backend never runs raw SQL built from user input — but a strong anomaly signal.)'),
  ('union\s+select', 'sql_injection_probe', 45, 'SQL-injection-flavored probe.'),
  ('delete\s+from\s+\w+', 'sql_injection_probe', 45, 'SQL-injection-flavored probe.'),
  ('insert\s+into\s+\w+\s*\(', 'sql_injection_probe', 40, 'SQL-injection-flavored probe.'),
  ('''\s*or\s*''?1''?\s*=\s*''?1', 'sql_injection_probe', 50, 'Classic tautology-based SQLi payload.'),
  (';\s*--', 'sql_injection_probe', 35, 'SQL statement terminator + comment.')
on conflict (pattern) do nothing;
