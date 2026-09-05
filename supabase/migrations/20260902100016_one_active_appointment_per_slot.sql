-- ===========================================================================
-- One user action must not be able to create two identical appointments.
-- ===========================================================================
-- Live production produced two rows with the same patient, the same
-- clinician, the same instant and the same status, from a single double
-- click: the interface guarded the submit button with React state, which is
-- committed on a later render, so both submissions reached the insert.
--
-- The interface now refuses the second submission synchronously, but that
-- guard lives in one browser tab. Two tabs, two devices, or a replayed
-- request would still arrive concurrently, and nothing in the database
-- stopped them. This is the part that cannot be raced.
--
-- The rule is narrow on purpose. A patient cannot be with the same clinician
-- twice at the same instant, so two *live* appointments for that triple are
-- never legitimate. Everything else stays possible:
--
--   * a different time, a different patient or a different clinician is
--     untouched, because all three are in the key;
--   * cancelling and rebooking the same slot works, because 'cancelled' is
--     outside the predicate;
--   * history is untouched — 'completed' and 'no_show' are outside it too, so
--     an old visit never blocks a new booking at the same clock time;
--   * approving a reschedule still moves an appointment, and is refused only
--     if the destination slot already holds a live appointment for that same
--     patient and clinician, which is the double-booking this prevents.
--
-- Checked against production data before writing this: exactly one group
-- violated the rule, and it was the pair created by the failing test itself.
-- No legitimate record is affected.

create unique index appointment_one_active_per_slot
  on public.appointment (pat_id, doc_id, appointment_date)
  where appointment_status in ('scheduled', 'confirmed');

comment on index public.appointment_one_active_per_slot is
  'One live appointment per patient, clinician and instant. Cancelled and '
  'historical rows are excluded so a slot can be rebooked and past visits '
  'never block a new booking.';
