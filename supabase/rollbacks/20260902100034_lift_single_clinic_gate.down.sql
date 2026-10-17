-- ===========================================================================
-- Rollback of migration 34 (lift_single_clinic_gate)
-- ===========================================================================
-- Restores the single-clinic gate and the key-only settings index, exactly as
-- migration 33 left them (tests/db/super-admin-rollback.test.ts). Applied as
-- a new migration, with approval.
--
-- It refuses, changing nothing, once a second clinic exists: an index cannot
-- make two clinics one, and no clinic is ever deleted. Nor can two clinics'
-- settings share one key-only index. With one clinic, nothing is lost.
-- ===========================================================================

do $$
declare
  clinic_count bigint;
begin
  if to_regclass('public.clinic_single_clinic_gate') is not null then
    raise exception 'Migration 34 is not applied. Nothing was changed.';
  end if;

  select count(*) into clinic_count from public.clinic;
  if clinic_count > 1 then
    raise exception 'There are % clinics; the single-clinic gate cannot be restored over them. Nothing was changed.',
      clinic_count;
  end if;

  if exists (
    select 1 from public.system_setting group by system_setting_key having count(*) > 1
  ) then
    raise exception 'Two settings share a key; the key-only index cannot be restored. Nothing was changed.';
  end if;
end
$$;

create unique index clinic_single_clinic_gate
  on public.clinic ((true));

comment on index public.clinic_single_clinic_gate is
  'Allows at most one clinic row until every settings reader is clinic-aware (migration 31 drops it).';

create unique index system_setting_key_unique
  on public.system_setting (system_setting_key);

comment on table public.clinic is
  'A clinic using RecoverEase. Doctors and Clinic Admins belong to one directly (migration 29); patients through their assigned doctor. Written only by the server.';
