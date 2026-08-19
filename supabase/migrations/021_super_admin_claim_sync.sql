-- 021_super_admin_claim_sync.sql
-- platform_admins (003_security_rls.sql) already backs is_super_admin() for
-- RLS, but nothing synced that membership into a JWT claim the way
-- sync_user_tenant_claim() already does for tenant_id/tenant_role — so
-- neither the frontend nor the Express backend (requireSuperAdmin, added
-- alongside this migration) had any way to know "is this user a super
-- admin" without a raw DB query. Same pattern, same tradeoff: the claim
-- only reflects reality as of the user's next token refresh, not
-- instantly — acceptable here for the same reason it already was for
-- tenant_role (see that migration's own header comment).
create or replace function public.sync_platform_admin_claim()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'DELETE' then
    update auth.users
    set raw_app_meta_data = raw_app_meta_data - 'is_super_admin'
    where id = OLD.user_id;
    return OLD;
  else
    update auth.users
    set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('is_super_admin', true)
    where id = NEW.user_id;
    return NEW;
  end if;
end;
$$;

create trigger platform_admins_sync_claim
  after insert or delete on public.platform_admins
  for each row
  execute function public.sync_platform_admin_claim();

-- Backfill for any platform_admins rows that already existed before this
-- migration (unlikely today, but the same reasoning as 003's own backfill
-- for tenant_members — cheap insurance either way).
update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('is_super_admin', true)
where id in (select user_id from public.platform_admins);
