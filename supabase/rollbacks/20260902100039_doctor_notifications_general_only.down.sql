-- ===========================================================================
-- Rollback of migration 39 (doctor_notifications_general_only)
-- ===========================================================================
-- Puts back the doctor's notification policy exactly as migration 06 wrote
-- it: an active doctor may notify their own patient, with any type, link,
-- read state or length. Applied as a new migration, with approval
-- (tests/db/doctor-notifications.test.ts).
--
-- Nothing else depends on 39, and no data changes in either direction: a
-- notification already sent stays as it is.
-- ===========================================================================

do $$
begin
  if not exists (
    select 1
      from pg_policies
     where schemaname = 'public'
       and tablename = 'notification'
       and policyname = 'notification_insert_doctor_to_patient'
       and with_check like '%notification_type%'
  ) then
    raise exception 'Migration 39 is not applied. Nothing was changed.';
  end if;
end
$$;

drop policy notification_insert_doctor_to_patient on public.notification;

create policy notification_insert_doctor_to_patient
  on public.notification for insert to authenticated
  with check ((select app_private.is_user_my_patient(user_id)));
