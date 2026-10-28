-- ===========================================================================
-- Rollback of migration 41 (doctor_notifications_general_only)
-- ===========================================================================
-- Puts back the doctor's notification policy exactly as migration 06 wrote
-- it: an active doctor may notify their own patient, with any type, link,
-- read state or length. Applied as a new migration, with approval
-- (tests/db/doctor-notifications.test.ts).
--
-- Nothing else depends on 41, and no data changes in either direction: a
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
    raise exception 'Migration 41 is not applied. Nothing was changed.';
  end if;
end
$$;

-- Putting the policy back locks `notification`, which the reminder jobs
-- write - the pre-dose job every minute. Waiting at most 3 seconds for that
-- lock, the rollback fails rather than holding the website up behind it
-- (docs/deployment.md, "Migration timing and run history"). A plain SET, not
-- SET LOCAL, so it holds whether or not the runner wraps this file in one
-- transaction. It comes after the check, so a refusal changes no setting,
-- and it is reset at the end.
set lock_timeout = '3s';

drop policy notification_insert_doctor_to_patient on public.notification;

create policy notification_insert_doctor_to_patient
  on public.notification for insert to authenticated
  with check ((select app_private.is_user_my_patient(user_id)));

-- Back to the server's default for anything else this connection runs.
reset lock_timeout;
