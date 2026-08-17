-- 002_push_subscriptions.sql
-- Device/browser push registrations, keyed by client and platform. This is
-- what `sendStickyReminder(userId, appointmentId, platform)` looks up to
-- resolve a `userId` (a client_profiles.id) into an actual FCM token, APNs
-- device token, or Web Push subscription to deliver to.

create type push_platform as enum ('android', 'ios', 'web');

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.client_profiles (id) on delete cascade,
  platform push_platform not null,
  -- Shape depends on platform:
  --   android: {"token": "<FCM registration token>"}
  --   ios:     {"deviceToken": "<APNs device token hex>"}
  --   web:     {"endpoint": "...", "keys": {"p256dh": "...", "auth": "..."}}
  target jsonb not null,
  created_at timestamptz not null default now(),
  unique (user_id, platform)
);

create index if not exists push_subscriptions_user_platform_idx
  on public.push_subscriptions (user_id, platform);

alter table public.push_subscriptions enable row level security;

create policy "push_subscriptions_scoped_to_owned_tenant"
  on public.push_subscriptions for all
  using (
    user_id in (
      select cp.id
      from public.client_profiles cp
      join public.tenants t on t.id = cp.tenant_id
      where t.owner_user_id = auth.uid()
    )
  )
  with check (
    user_id in (
      select cp.id
      from public.client_profiles cp
      join public.tenants t on t.id = cp.tenant_id
      where t.owner_user_id = auth.uid()
    )
  );
