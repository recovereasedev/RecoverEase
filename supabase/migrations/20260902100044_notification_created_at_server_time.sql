-- ===========================================================================
-- RecoverEase — 44. A notification is dated by the database, not its sender
-- ===========================================================================
-- `notification_created_at` defaults to now(), but a default is only what is
-- written when the insert names no value. Migration 41 narrowed what a
-- doctor's notification may say and to whom; it left this column free, so a
-- direct Data API call could still date a general message to their own
-- patient days in the past or the future. The patient's list is ordered by
-- it, newest first, so the date decided where the message sat - above every
-- reminder, or buried beneath them - and the date the patient was shown.
--
-- One trigger, before every insert: the row is given now(), whatever the
-- insert said. now() is the start of the inserting transaction - exactly
-- what the column's default gives - so nothing that relies on the default
-- sees any difference:
--
--   * every database function that writes a notification - the medication,
--     pre-dose and appointment reminder jobs,
--     `appointment_notify_cancellation` and `admin_reassign_doctor_patients` -
--     names only the recipient, the type and the message;
--   * `chatbot-reply`, with the service role, names the same three and the
--     chat session.
--
-- None of them chooses the time, so each writes the row it wrote before, at
-- the time it wrote it. The trigger sets the time for every writer, not only
-- for signed-in users: nothing has a reason to choose it, and a rule with no
-- exceptions has none to get wrong.
--
-- Not changed: the doctor's policy (migration 41, word for word - who may be
-- notified, and with what), every other policy, and every notification
-- already stored. The trigger runs on insert only; no row is updated.
--
-- Rollback: supabase/rollbacks/20260902100044_notification_created_at_server_time.down.sql
-- ===========================================================================

-- Adding the trigger locks `notification`, which the reminder jobs write -
-- the pre-dose job every minute. Waiting at most 3 seconds for that lock, the
-- migration fails rather than holding the website up behind it
-- (docs/deployment.md, "Migration timing and run history"). A plain SET, not
-- SET LOCAL, so it holds whether or not the runner wraps this file in one
-- transaction; it is reset at the end.
set lock_timeout = '3s';

create or replace function public.notification_assign_created_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.notification_created_at := now();
  return new;
end;
$$;

comment on function public.notification_assign_created_at() is
  'Dates a new notification with the start of the inserting transaction, '
  'whatever the insert supplied (migration 44). Run only by the '
  'notification_assign_created_at trigger.';

-- Not callable directly, like every other trigger function (migration 10).
revoke all on function public.notification_assign_created_at() from public, anon, authenticated;

-- Stopped between these two statements, by a lock it could not get, there
-- is no trigger and notifications are dated as before 44: nothing is
-- refused, and running this file again from the top completes it.
drop trigger if exists notification_assign_created_at on public.notification;
create trigger notification_assign_created_at
  before insert on public.notification
  for each row execute function public.notification_assign_created_at();

-- Back to the server's default for anything else this connection runs.
reset lock_timeout;
