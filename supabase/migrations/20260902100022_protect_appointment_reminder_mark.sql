-- ===========================================================================
-- RecoverEase — 15. The reminder record is kept by the system
-- ===========================================================================
-- `appointment_reminder_sent_at` is the reminder job's duplicate guard
-- (migration 18): NULL means "not reminded yet", anything else means
-- "reminded". Two things are meant to write it, and both are database
-- functions running with their owner's privileges:
--
--   * dispatch_appointment_reminders sets it when it sends the pair;
--   * reschedule_request_apply_decision clears it when an approved
--     reschedule moves the appointment to a different time (migration 19).
--
-- But the column was as writable as any other. The patient and their
-- clinician hold INSERT and UPDATE on the table, and appointment_update
-- admits both of them to the whole row, so either could:
--
--   * clear it after each hourly run and have the same reminder sent to both
--     of them again, every hour, while the appointment is inside the reminder
--     window — notifications written into the other person's inbox;
--   * set it early, or book an appointment with it already set, so that
--     neither of them is reminded at all;
--   * rewrite it to any time, so it no longer records when the reminder
--     actually went out.
--
-- This refuses those writes and nothing else:
--
--   * A caller of the Data API with an end-user session or none — the roles
--     `authenticated` and `anon` — may not insert an appointment with the
--     mark already set, nor change it on an existing one, however the rest
--     of the statement is shaped. Writing the value it already holds is not
--     a change and stays allowed; the app itself never sends the column.
--   * Every other writer is left as it was: the reminder job and the
--     reschedule approval run as their owner, the cron job as postgres, and
--     the service key as service_role.
--
-- Why current_user and not auth.uid(): inside a SECURITY DEFINER function
-- current_user is the function's owner, while auth.uid() still reads the
-- caller's session. The reschedule approval that legitimately clears the
-- mark is made by the clinician, so auth.uid() is the clinician there —
-- checking it would refuse the very write migration 19 depends on.
-- current_user is what tells a direct client write apart from one a database
-- function makes on the client's behalf. For the same reason this function
-- is not SECURITY DEFINER itself: it would then always see its own owner.
--
-- Any future writer of this column must therefore be a privileged database
-- function (SECURITY DEFINER) or server-side code using the service key —
-- never a direct client update.
-- ===========================================================================

create or replace function public.appointment_guard_reminder_mark()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  changed boolean;
begin
  -- The Data API's end-user roles. The reminder job, the reschedule
  -- approval, the cron job and the service key all write as other roles.
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      changed := new.appointment_reminder_sent_at is not null;
    else
      changed := new.appointment_reminder_sent_at
                 is distinct from old.appointment_reminder_sent_at;
    end if;

    if changed then
      raise exception
        'appointment_reminder_sent_at is managed by the system and cannot be changed directly'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.appointment_guard_reminder_mark() is
  'Refuses a direct client write of appointment_reminder_sent_at: an insert '
  'with the mark set, or an update that changes it, by the anon or '
  'authenticated role. The reminder job and the reschedule approval write it '
  'as their owner and are unaffected. Run only by the '
  'appointment_guard_reminder_mark trigger.';

-- Not callable directly, like every other trigger function (migration 10).
revoke all on function public.appointment_guard_reminder_mark()
  from public, anon, authenticated;

create trigger appointment_guard_reminder_mark
  before insert or update of appointment_reminder_sent_at on public.appointment
  for each row
  execute function public.appointment_guard_reminder_mark();

comment on trigger appointment_guard_reminder_mark on public.appointment is
  'Keeps appointment_reminder_sent_at out of reach of direct client writes.';
