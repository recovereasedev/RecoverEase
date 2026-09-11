-- ===========================================================================
-- RecoverEase — 14. A closed appointment stays closed
-- ===========================================================================
-- 'cancelled', 'completed' and 'no_show' settle an appointment. Migration 17
-- already stops a reschedule approval from reopening one, and neither screen
-- offers any action on one. But the status itself is an ordinary column
-- update, and nothing in the database refused moving it back:
--
--   * a patient could set a cancelled, completed or no_show appointment to
--     'confirmed' — the patient guard in migration 07 checks only the new
--     status, never the old one — or rewrite a completed visit as
--     'cancelled';
--   * the clinician, and the service role, could move any of them to
--     anything.
--
-- Only the Data API reached it, but with nothing more than the user's own
-- session. A revived cancellation keeps the reminder guard it already had,
-- so it is never reminded again, and its latest notification still says it
-- was cancelled; reviving one also lets a stale reschedule request through
-- migration 17's check.
--
-- This adds one rule and nothing else: once an appointment is closed, its
-- status no longer changes.
--
--   * cancelled and completed are final.
--   * no_show is final except for the one correction the clinician's screen
--     already offers: a no-show recorded in error can be marked completed.
--     Not by the patient — "completed" is a clinical assertion, which the
--     patient guard already withholds from them.
--   * Writing the same status again is not a change and stays allowed, so a
--     repeated "cancel" remains a harmless no-op (and, per migration 20,
--     sends nothing).
--
-- A BEFORE trigger, so the rule holds for every caller — patient, clinician
-- and service role alike — whatever the client sends. RLS decides which rows
-- a caller may update and cannot compare old and new values; a CHECK
-- constraint cannot see the old value at all. No elevated privilege is
-- needed: the function reads only the row being updated and asks, through
-- the existing helper, whether the caller is that row's patient.
--
-- BEFORE triggers fire in name order, so this one runs ahead of
-- appointment_protect_transitions: a patient trying to reopen a closed
-- appointment is told why, rather than what patients may do in general.
-- Either way the write is refused.
-- ===========================================================================

create or replace function public.appointment_guard_closed_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- The one correction: a no-show recorded in error, marked completed by
  -- anyone the update policy admits other than the patient.
  if old.appointment_status = 'no_show'
     and new.appointment_status = 'completed'
     and not (select app_private.is_own_patient_record(new.pat_id)) then
    return new;
  end if;

  raise exception '%',
    case old.appointment_status
      when 'cancelled' then
        'This appointment has already been cancelled, so it can no longer be changed'
      when 'completed' then
        'This appointment has already been completed, so it can no longer be changed'
      else
        'This appointment has already been marked as a no-show, so it can only be corrected to completed by the clinician'
    end
    using errcode = 'insufficient_privilege';
end;
$$;

comment on function public.appointment_guard_closed_status() is
  'Keeps a closed appointment closed: cancelled and completed never change '
  'status again, and no_show changes only to completed, by someone other '
  'than the patient. Run only by the appointment_guard_closed_status trigger.';

-- Not callable directly, like every other trigger function (migration 10).
revoke all on function public.appointment_guard_closed_status()
  from public, anon, authenticated;

create trigger appointment_guard_closed_status
  before update of appointment_status on public.appointment
  for each row
  when (
    old.appointment_status in ('cancelled', 'completed', 'no_show')
    and new.appointment_status is distinct from old.appointment_status
  )
  execute function public.appointment_guard_closed_status();

comment on trigger appointment_guard_closed_status on public.appointment is
  'Refuses any change of status away from cancelled, completed or no_show, '
  'except the clinician''s correction of a no-show to completed.';
