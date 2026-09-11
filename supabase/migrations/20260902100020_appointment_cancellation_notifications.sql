-- ===========================================================================
-- RecoverEase — 13. A cancelled appointment tells both people
-- ===========================================================================
-- F-02. Cancelling an appointment only ever changed its status. Nobody was
-- told: the person who cancelled knew, and the other found out only by
-- opening their calendar. Worse, when the upcoming-appointment reminder had
-- already gone out (migration 18), both of them were left holding a
-- notification saying the appointment was still happening, with nothing
-- after it saying otherwise.
--
-- The fix adds one notification for the patient and one for the
-- appointment's doctor, written by a trigger in the same transaction as the
-- cancellation, and nothing else:
--
--   * It fires on the change of status, not on the UPDATE: only 'scheduled'
--     or 'confirmed' becoming 'cancelled'. Cancelling something already
--     cancelled, completed or no_show, confirming, rescheduling, moving the
--     date or writing the reminder guard all fall outside that condition, so
--     none of them send anything. Because the condition is on OLD, a second
--     writer racing the first blocks on the row lock, re-reads the row as
--     already cancelled under READ COMMITTED, and sends nothing: one
--     cancellation, one pair.
--   * Only for an appointment still ahead. A visit that has already passed
--     changes nobody's plans by being cancelled.
--   * The recipients come from the appointment row alone — the same two
--     people the reminder goes to. Never the caller, never an administrator.
--   * The reminder already sent is left exactly as it is. It was true when it
--     was sent, and notifications are the user's history; the cancellation is
--     simply the newer entry above it, naming the same date and time so the
--     two read as a pair.
--   * `appointment_reminder_sent_at` is not touched. A cancelled appointment
--     is excluded from the reminder job by its status, and the guard stays a
--     record of what was actually sent.
--
-- The wording follows the reminder's, in the clinic's timezone. The
-- patient's names nobody and nothing clinical; the clinician's names the
-- patient, which they already see on every screen listing that appointment.
-- Neither says who cancelled.
--
-- SECURITY DEFINER because both notifications are addressed to other people:
-- a patient cancelling has no right to insert a row for their clinician, and
-- is not given one. EXECUTE is revoked as for every trigger function
-- (migration 10), which does not stop the trigger firing.
-- ===========================================================================

create or replace function public.appointment_notify_cancellation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  zone text;
begin
  select coalesce(
           (select system_setting_value
              from public.system_setting
             where system_setting_key = 'app.timezone'),
           'UTC'
         )
    into zone;

  insert into public.notification (
    user_id, notification_type, notification_message
  )
  select recipient.user_id, 'appointment', recipient.message
    from public.patient p
    join public.doctor  d on d.doc_id = new.doc_id
    cross join lateral (
      values
        (
          d.user_id,
          format(
            'The appointment with %s on %s at %s has been cancelled.',
            trim(p.pat_first_name || ' ' || p.pat_last_name),
            to_char(new.appointment_date at time zone zone, 'FMDay, FMDD FMMonth'),
            to_char(new.appointment_date at time zone zone, 'HH24:MI')
          )
        ),
        (
          p.user_id,
          format(
            'Your appointment on %s at %s has been cancelled.',
            to_char(new.appointment_date at time zone zone, 'FMDay, FMDD FMMonth'),
            to_char(new.appointment_date at time zone zone, 'HH24:MI')
          )
        )
    ) as recipient(user_id, message)
   where p.pat_id = new.pat_id;

  return null;
end;
$$;

comment on function public.appointment_notify_cancellation() is
  'F-02. Writes one appointment notification to the patient and one to the '
  'appointment''s doctor when an upcoming appointment is cancelled. Run only '
  'by the appointment_on_cancellation trigger; it leaves earlier '
  'notifications and appointment_reminder_sent_at untouched.';

-- Not callable directly, like every other trigger function (migration 10).
revoke all on function public.appointment_notify_cancellation()
  from public, anon, authenticated;

create trigger appointment_on_cancellation
  after update of appointment_status on public.appointment
  for each row
  when (
    old.appointment_status in ('scheduled', 'confirmed')
    and new.appointment_status = 'cancelled'
    and new.appointment_date > now()
  )
  execute function public.appointment_notify_cancellation();

comment on trigger appointment_on_cancellation on public.appointment is
  'Fires once per cancellation of an upcoming appointment: scheduled or '
  'confirmed becoming cancelled, with the appointment still in the future.';
