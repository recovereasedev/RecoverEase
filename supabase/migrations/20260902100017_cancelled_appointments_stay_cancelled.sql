-- ===========================================================================
-- A cancelled appointment must not come back.
-- ===========================================================================
-- `reschedule_request_apply_decision` moved the appointment and set its
-- status to 'scheduled' on approval, unconditionally. It never asked what
-- the appointment's status was first, so approving a request against a
-- cancelled appointment revived it: the row went back to 'scheduled' at a
-- new time, and the fact that it had been cancelled disappeared from the
-- record entirely.
--
-- The path is reachable rather than theoretical. The patient screen listed
-- cancelled future appointments under "Upcoming" — correctly, since they are
-- not past — and offered "Request new time" beside them, and neither
-- `reschedule_request_insert_patient` nor `reschedule_request_update_doctor`
-- restricts by status. So: patient asks, doctor approves, cancellation gone.
-- Proven against production inside a rolled-back transaction before this was
-- written.
--
-- Two changes, and only these:
--
--   1. The update is guarded on the appointment's current status. Only a
--      'scheduled' or 'confirmed' appointment can be moved. 'cancelled',
--      'completed' and 'no_show' are terminal and stay exactly as they are —
--      date included, so an old visit cannot be silently re-dated either.
--
--   2. If the guard matches nothing, the approval is refused rather than
--      recorded. A request marked approved that moved nothing is a lie in
--      the record, and this file already raises for every other illegal
--      transition; matching that is what makes the outcome visible to the
--      clinician instead of silent.
--
-- Declining a request is untouched. A doctor can still clear a stale request
-- against a cancelled appointment by declining it, which is the correct way
-- out and the reason refusing the approval does not strand anybody.
--
-- Nothing else about the decision flow changes: the responded-at stamp, the
-- no-op guard on an unchanged status, ownership and authorization all behave
-- exactly as before.

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
           appointment_status = 'scheduled'
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
  'appointment is refused so a closed appointment cannot be revived.';
