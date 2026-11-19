# Pending migrations (not in the discharge-only release)

These migrations were merged to `main` (PRs #84–#90) but are **not applied to
production** (production ends at 53). On `release/discharge-only` they were
moved here so that `supabase/migrations/` holds exactly what will be applied,
in order: … 53, 61.

| File | Feature | App code to re-land from |
| --- | --- | --- |
| `20260902100054_doctor_identity_columns_fixed` | A doctor's record ID and registration date are fixed (trigger only) | none (database only) |
| `20260902100055_treatment_goal_progress` | Patient goal progress, missed-goal job | b0709ef |
| `20260902100056_automatic_recovery_roadmap` | Generated recovery roadmap | fa3f49a |
| `20260902100058_medication_schedule_instructions` | A medicine's own instructions | aea938c |
| `20260902100059_medication_schedule_reminder_control` | The doctor's reminder switch per medicine | 496b592, de4188f |

`tests/` holds their database tests, unchanged and outside the test run.

## Re-landing

Each comes back **renumbered after 61** (62, 63, …), one release at a time,
with approval, and its rollback added to the front of the rollback-chain
tests (`super-admin-rollback`, `medication-dose-identity`). Known changes:

- **55**: `mark_missed_treatment_goals()` must skip `discharged` plans, as
  57 did. Its patient function already refuses a plan that is not `active`.
- **56**: re-check the recovery-roadmap tests that close a plan; from 61 a
  plan closes only by discharge.
- **59**, then a new migration for **60's second half**: per-plan
  `prescription.treatment_plan_id` / `appointment.treatment_plan_id`, the
  same-patient composite keys, `care_reminders_allowed`,
  `care_reopened_at`, and the four reminder readers, written against 61's
  objects rather than 57's (see `../superseded`). App code: e41a6a8.
