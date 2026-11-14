-- ===========================================================================
-- Rollback of migration 54 (doctor_identity_columns_fixed)
-- ===========================================================================
-- Removes the guard on a doctor's `doc_id` and `doc_created_at`, back to the
-- rules before 54: an administrator may again rewrite both on their clinic's
-- doctors, and a doctor their own registration date. It wrote no row, so no
-- data changes. Applied as a new migration, with approval
-- (tests/db/doctor-identity-fixed.test.ts).
--
-- The website needs no rollback first: no screen sends either column.
-- ===========================================================================

do $$
begin
  if to_regprocedure('public.doctor_identity_is_fixed()') is null then
    raise exception 'Migration 54 is not applied. Nothing was changed.';
  end if;
end
$$;

-- Dropping the trigger locks `doctor`, which the reminder jobs read. Waiting
-- at most 3 seconds for that lock, the rollback fails rather than holding the
-- website up behind it. It comes after the check, so a refusal changes no
-- setting, and it is reset at the end.
set lock_timeout = '3s';

drop trigger if exists doctor_identity_is_fixed on public.doctor;
drop function if exists public.doctor_identity_is_fixed();

reset lock_timeout;
