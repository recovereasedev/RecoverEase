# Discharge Patient and Reopen Case Implementation Plan

**Goal:** a treatment plan moves ACTIVE → READY FOR DISCHARGE (system flag)
→ DISCHARGED (doctor only), and a doctor can reopen a discharged plan; the
patient's account is never touched.

**Spec:** the task prompt of 2026-11-15 (Discharge Patient and Reopen Case).
Base: `origin/main` b948666 (PR #86 merged). Production history (read-only
`list_migrations`) ends at 53: 54, 55 and 56 are **not applied**.

## Decisions (inspected against main)

1. **Status.** Extend the existing `treatment_plan_status` enum with
   `ready_for_discharge` and `discharged`. `completed` and `cancelled` keep
   their meaning and are never rewritten; no row changes. "Open care" =
   `active` or `ready_for_discharge`.
2. **Metadata.** `treatment_plan_closure_reason` (text, check:
   `completed_recovery`, `transferred`, `withdrew`, `lost_to_follow_up`,
   `referred`) and `treatment_plan_discharged_at` (timestamptz). A check
   holds both set exactly when the status is `discharged`; reopening clears
   both.
3. **Writes.** `doctor_discharge_treatment_plan(plan, reason)` and
   `doctor_reopen_treatment_plan(plan)`: SECURITY DEFINER, empty
   `search_path`, `is_my_patient` first, plan locked `FOR UPDATE`, allowed
   transitions only. A guard trigger refuses any session that writes
   `ready_for_discharge`/`discharged`, moves a plan out of them, or writes
   the two new columns, so a direct API update cannot bypass the RPCs.
4. **History.** Append-only `treatment_plan_lifecycle_event` (plan,
   previous, new, closure reason, actor, source `doctor|system|service`,
   at), written only by an AFTER UPDATE trigger on a real status change;
   no session may write it; readable by whoever may read the plan.
5. **Readiness job.** `mark_treatment_plans_ready_for_discharge()`
   (`service_role` only, pg_cron daily `15 16 * * *` = 00:15 Asia/Manila,
   guarded like 55): one UPDATE of `active` plans where the end date is
   before the clinic's today (patient → doctor → clinic) **or** the plan has
   at least one goal and every goal is `achieved`. Recovery activities are
   not milestones in the schema (no required flag), so they do not count.
   The same statement's rows get one `treatment` notification each for the
   patient's assigned doctor. Run again, nothing is active-and-eligible, so
   no event or notification repeats. It never writes `discharged`.
6. **Care stays open while Ready.** The patient's activity and goal RPCs
   (45, 55) accept `active` or `ready_for_discharge`; the missed-goal job
   (55) skips `discharged` plans.
7. **Recovery logs.** `recovery_log` is linked to the patient, not a plan,
   so no log can be assigned to a plan without guessing. Rule, enforced by
   trigger: a patient may not write a log while they have a discharged plan
   and no open plan. With any open plan the log belongs to that care; with
   no plans at all, or only legacy completed/cancelled ones, nothing
   changes.
8. **Reminders.** No reminder generator is tied to a plan: medication
   reminders belong to prescriptions/schedules, appointment reminders to
   appointments; both continue. The only plan-level automation is the
   missed-goal job (item 6). Nothing else is suppressed.
9. **Follow-up booking.** Booking stays open. New nullable
   `appointment.appointment_follow_up_of_plan_id`, set only by a BEFORE
   INSERT trigger when, at booking, the patient has a discharged plan and no
   open plan (the most recently discharged one); sessions cannot set or
   change it. The doctor's appointments list labels it "Follow-up after
   discharge". It never becomes the roadmap's chosen follow-up by itself.
10. **UI.** Doctor patient record: status badge (Ready = warning), Discharge
    patient (dialog with required reason) on open plans, Reopen case on
    discharged plans, closure reason and date shown. Patient: plans that are
    open count as current everywhere `active` did; with care ended, the
    recovery, roadmap and treatment pages show "Your care plan has ended.
    Book a follow-up if you need more care." with a link to appointments
    and hide the daily entry form.

## Tasks

1. DB tests (`tests/db/discharge-reopen.test.ts`) red → migration 57 +
   rollback green; adjust earlier suites only where they describe older
   schemas.
2. Types, API, hooks; unit tests for status helpers, dialogs, patient
   message.
3. Doctor and patient UI; E2E spec.
4. Docs (database.md §19, deployment.md section, rollback step).
5. Full verification and review.
