-- 010_index_introspection.sql
-- Lets src/utils/prodChecklist.ts verify expected indexes actually exist
-- without needing raw SQL access (the Supabase JS client has no `.raw()`
-- escape hatch by design) — pg_indexes is a system catalog view readable
-- by any role, so this needs no elevated privileges.

create or replace function public.list_index_names()
returns setof text
language sql
stable
as $$
  select indexname from pg_indexes where schemaname = 'public';
$$;
