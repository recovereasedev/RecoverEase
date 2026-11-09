-- ===========================================================================
-- Rollback of migration 47 (super_admin_clinic_details)
-- ===========================================================================
-- Removes the two clinic details functions. Neither created a table, a
-- policy or a grant on a table, so nothing else changes. A clinic renamed
-- with them keeps its new name, and the audit entries recording the renames
-- stay: a rollback removes the means, never the history. Applied as a new
-- migration, with approval (tests/db/super-admin-clinic-details.test.ts).
--
-- Roll the website back first: from migration 47 the clinic details page
-- (/platform/clinics/:clinicId) calls both functions; without them that page
-- shows its error state, though every other console page keeps working.
-- ===========================================================================

do $$
begin
  if to_regprocedure('public.super_admin_list_clinic_admins(uuid)') is null
     and to_regprocedure('public.super_admin_rename_clinic(uuid, text)') is null then
    raise exception 'Migration 47 is not applied. Nothing was changed.';
  end if;
end
$$;

-- Dropping a function locks no table; waiting at most 3 seconds for any lock
-- all the same, as every migration from 41 does. Reset at the end.
set lock_timeout = '3s';

drop function if exists public.super_admin_rename_clinic(uuid, text);
drop function if exists public.super_admin_list_clinic_admins(uuid);

reset lock_timeout;
