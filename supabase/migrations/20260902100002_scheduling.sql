-- ===========================================================================
-- RecoverEase — 03. Scheduling
-- ===========================================================================
-- ERD entities: appointment, rescheduleRequest.
-- ===========================================================================

-- Derived from the appointment modules: 6.1 schedule, 6.6 confirm attendance,
-- 6.7 view history. 'no_show' is included because an appointment that was
-- neither attended nor cancelled is a distinct outcome from both.
create type public.appointment_status as enum
  ('scheduled', 'confirmed', 'completed', 'cancelled', 'no_show');

create type public.reschedule_request_status as enum
  ('pending', 'approved', 'declined');

-- ---------------------------------------------------------------------------
-- appointment
-- ---------------------------------------------------------------------------

create table public.appointment (
  appointment_id         uuid primary key default gen_random_uuid(),
  pat_id                 uuid not null
                           references public.patient (pat_id)
                           on delete cascade,
  doc_id                 uuid not null
                           references public.doctor (doc_id)
                           on delete restrict,
  appointment_date       timestamptz not null,
  appointment_status     public.appointment_status
                           not null default 'scheduled',
  appointment_created_at timestamptz not null default now()
);

-- The patient calendar and the doctor calendar (module 6.2) are the two read
-- paths, and both order by date.
create index appointment_pat_date_idx
  on public.appointment (pat_id, appointment_date desc);

create index appointment_doc_date_idx
  on public.appointment (doc_id, appointment_date desc);

comment on table public.appointment is
  'ERD: appointment. Booked by the patient (module 6.1) against their own '
  'assigned doctor; both parties read it (module 6.2).';

-- An appointment always belongs to the patient's own assigned doctor. Without
-- this, a patient could book time with a clinician who has no relationship to
-- them — and would then gain a read path to that doctor via the appointment.
create or replace function public.appointment_enforce_assigned_doctor()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  assigned_doc_id uuid;
begin
  select p.doc_id into assigned_doc_id
    from public.patient p
   where p.pat_id = new.pat_id;

  if assigned_doc_id is distinct from new.doc_id then
    raise exception
      'An appointment must be booked with the patient''s assigned doctor'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger appointment_check_assigned_doctor
  before insert or update of pat_id, doc_id on public.appointment
  for each row execute function public.appointment_enforce_assigned_doctor();

-- ---------------------------------------------------------------------------
-- rescheduleRequest
-- ---------------------------------------------------------------------------
-- ASSUMPTION: the ERD names a column `rescheduleRequestDate` and separately
-- `rescheduleRequestRespondedAt`. Since the response time has its own column
-- and no other column can carry the proposed slot, `reschedule_request_date`
-- is read as *the newly proposed appointment date and time*. Without that
-- reading the doctor would have nothing to approve in module 6.4.

create table public.reschedule_request (
  reschedule_request_id           uuid primary key default gen_random_uuid(),
  appointment_id                  uuid not null
                                    references public.appointment
                                      (appointment_id)
                                    on delete cascade,
  -- The ERD points this at userAccount rather than patient, so the column is
  -- kept general even though module 6.5 only grants the action to patients.
  user_id                         uuid not null
                                    references public.user_account (user_id)
                                    on delete cascade,
  reschedule_request_date         timestamptz not null,
  reschedule_request_reason       text,
  reschedule_request_status       public.reschedule_request_status
                                    not null default 'pending',
  reschedule_request_responded_at timestamptz,
  reschedule_request_created_at   timestamptz not null default now(),

  -- A decided request must record when it was decided, and a pending one
  -- must not pretend to have been.
  constraint reschedule_request_response_consistent
    check (
      (reschedule_request_status = 'pending')
        = (reschedule_request_responded_at is null)
    )
);

-- At most one request may be awaiting a decision per appointment. Otherwise a
-- patient could queue several proposals and the doctor's approval in module
-- 6.4 would be ambiguous.
create unique index reschedule_request_one_pending_per_appointment
  on public.reschedule_request (appointment_id)
  where reschedule_request_status = 'pending';

create index reschedule_request_appointment_idx
  on public.reschedule_request (appointment_id);

-- ON DELETE CASCADE from user_account: deleting an account must not
-- sequentially scan every reschedule request ever submitted.
create index reschedule_request_user_idx
  on public.reschedule_request (user_id);

comment on table public.reschedule_request is
  'ERD: rescheduleRequest. Submitted by the patient (module 6.5), reviewed '
  'and decided by the doctor (modules 6.3, 6.4). '
  'reschedule_request_date holds the proposed new slot.';

comment on column public.reschedule_request.reschedule_request_date is
  'The proposed new appointment date and time, not the submission time. '
  'Submission time is reschedule_request_created_at.';

-- ADDITION: `reschedule_request_created_at` is not in the ERD. The ERD offers
-- no way to order a patient's request history, and module 6.4 requires the
-- doctor to see which request arrived when.
