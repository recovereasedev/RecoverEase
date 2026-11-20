# Pending migrations: none

Everything that was parked here after the discharge-only release (PR #91)
has been re-landed, renumbered after 61, on
`feat/patient-level-discharge-lifecycle`:

| Was | Now | Feature |
| --- | --- | --- |
| 54 | `migrations/20260902100062_doctor_identity_columns_fixed` | A doctor's record ID and registration date are fixed |
| 55 | `migrations/20260902100064_treatment_goal_progress` | Patient goal progress, missed-goal job (skips discharged care) |
| 56 | `migrations/20260902100065_automatic_recovery_roadmap` | Generated recovery roadmap |
| 58 | `migrations/20260902100066_medication_schedule_instructions` | A medicine's own instructions |
| 59 | `migrations/20260902100067_medication_schedule_reminder_control` | The doctor's reminder switch per medicine |

`63` (`patient_care_lifecycle`) is new: the patient-level care lifecycle.
Their rollbacks are in `../rollbacks/` and their tests in `tests/db/`.
57 and 60 stay superseded (`../superseded/README.md`). 60's per-plan
medication and appointment links are still not included: nothing here
needs them.
