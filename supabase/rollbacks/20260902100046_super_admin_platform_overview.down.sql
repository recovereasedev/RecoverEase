-- ===========================================================================
-- Rollback of migration 46 (super_admin_platform_overview)
-- ===========================================================================
-- Removes the platform overview function. It wrote nothing, so nothing else
-- changes: no row, no audit entry, no other function. Applied as a new
-- migration, with approval (tests/db/platform-overview.test.ts).
--
-- Roll the website back first: from migration 46 the console's first page,
-- /platform, calls `super_admin_platform_overview()`; without it that page
-- shows its error state, though every other console page keeps working.
-- ===========================================================================

do $$
begin
  if to_regprocedure('public.super_admin_platform_overview()') is null then
    raise exception 'Migration 46 is not applied. Nothing was changed.';
  end if;
end
$$;

-- Dropping a function locks no table; waiting at most 3 seconds for any lock
-- all the same, as every migration from 41 does. Reset at the end.
set lock_timeout = '3s';

drop function if exists public.super_admin_platform_overview();

reset lock_timeout;
