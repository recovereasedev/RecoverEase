-- ===========================================================================
-- Rollback of migration 44 (notification_created_at_server_time)
-- ===========================================================================
-- Removes the trigger and its function, so a notification is dated by its
-- column default again - and by its sender, where the sender names a time.
-- Applied as a new migration, with approval
-- (tests/db/notification-created-at.test.ts).
--
-- Nothing deployed depends on 44, and no data changes in either direction:
-- every notification keeps the time it was stored with.
--
-- It runs while either of 44's objects is still there, so a run that stops
-- between dropping the trigger and dropping the function is finished by
-- running this file again. It refuses only once both are gone.
-- ===========================================================================

do $$
begin
  if not exists (
    select 1
      from pg_trigger
     where tgrelid = 'public.notification'::regclass
       and tgname = 'notification_assign_created_at'
  ) and to_regprocedure('public.notification_assign_created_at()') is null then
    raise exception 'Migration 44 is not applied. Nothing was changed.';
  end if;
end
$$;

-- Dropping the trigger locks `notification`, which the reminder jobs write -
-- the pre-dose job every minute. Waiting at most 3 seconds for that lock, the
-- rollback fails rather than holding the website up behind it
-- (docs/deployment.md, "Migration timing and run history"). A plain SET, not
-- SET LOCAL, so it holds whether or not the runner wraps this file in one
-- transaction. It comes after the check, so a refusal changes no setting,
-- and it is reset at the end.
set lock_timeout = '3s';

drop trigger if exists notification_assign_created_at on public.notification;
drop function if exists public.notification_assign_created_at();

-- Back to the server's default for anything else this connection runs.
reset lock_timeout;
