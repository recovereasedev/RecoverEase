-- ===========================================================================
-- RecoverEase — 12. A rescheduled appointment is reminded at its new time
-- ===========================================================================
-- F-01. `dispatch_appointment_reminders` (migration 18) keeps each
-- appointment to one reminder with a single timestamp on the row,
-- `appointment_reminder_sent_at`. An approved reschedule moves that same row
-- to a new time, in `reschedule_request_apply_decision` — and left the
-- timestamp where it was.
--
-- So an appointment reminded about its old time was never reminded about its
-- new one: the dispatcher saw it as already done. That is the likely order of
-- events, not an edge case: the reminder arrives the day before, the patient
-- realises it clashes, asks to move it, and the clinician approves. Both of
-- them were then left with a notification naming the old time and nothing
-- about the new one.
--
-- The fix is the smallest one available: when an approval actually changes
-- the appointment's time, clear the guard in the same UPDATE that moves it.
-- The existing hourly job then treats the appointment like any other and
-- sends the reminder for the new time — once, to the same two people, with
-- its own duplicate guard exactly as before. Nothing is sent from the
-- approval itself.
--
-- What does not change:
--
--   * An approval that leaves the time as it was keeps the guard. The
--     reminder already sent is still correct, and must not be repeated.
--   * A cancelled, completed or no_show appointment still cannot be moved
--     (migration 17), so its guard is never touched and it is never revived.
--   * The notification already sent stays. It was true when it was sent, and
--     notifications are the user's history; retracting or correcting them is
--     a separate question (F-02) and deliberately not answered here.
--   * Security: still SECURITY DEFINER with an empty search_path, still run
--     only by its trigger. CREATE OR REPLACE keeps the existing grants, so
--     the EXECUTE revocation from migration 10 stands.
--
-- The function body below is migration 17's, unchanged except for the one
-- added assignment and its comment.
-- ===========================================================================

create or replace function public.reschedule_request_apply_decision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  moved integer;
begin
  if new.reschedule_request_status = old.reschedule_request_status then
    return new;
  end if;

  if new.reschedule_request_responded_at is null then
    new.reschedule_request_responded_at := now();
  end if;

  if new.reschedule_request_status = 'approved' then
    update public.appointment
       set appointment_date   = new.reschedule_request_date,
           appointment_status = 'scheduled',
           -- A reminder names a time. Once the time moves, the one already
           -- sent is about a different appointment slot, so the guard is
           -- cleared and the hourly dispatcher reminds about the new time.
           -- On the right of SET, `appointment_date` is still the old value.
           appointment_reminder_sent_at = case
             when appointment_date is distinct from new.reschedule_request_date
               then null
             else appointment_reminder_sent_at
           end
     where appointment_id = new.appointment_id
       and appointment_status in ('scheduled', 'confirmed');

    get diagnostics moved = row_count;

    if moved = 0 then
      raise exception
        'This appointment is no longer active, so it cannot be moved to a new time'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.reschedule_request_apply_decision is
  'Applies a reschedule decision. Only a scheduled or confirmed appointment '
  'can be moved; approving against a cancelled, completed or no_show '
  'appointment is refused so a closed appointment cannot be revived. When an '
  'approval changes the appointment time, appointment_reminder_sent_at is '
  'cleared so the hourly reminder job reminds about the new time.';

comment on column public.appointment.appointment_reminder_sent_at is
  'When the upcoming-appointment reminder was dispatched for this '
  'appointment''s current time. NULL means it has not been sent. Set by '
  'dispatch_appointment_reminders, which uses it as its duplicate guard; '
  'cleared by reschedule_request_apply_decision when an approved reschedule '
  'changes the time.';
