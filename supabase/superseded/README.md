# Superseded migrations

`20260902100057_discharge_reopen_treatment_case` and
`20260902100060_simplify_discharge_lifecycle` were merged to `main`
(PRs #87, #90) and **never applied to production**. They are replaced by
`supabase/migrations/20260902100061_discharge_care_plan.sql`, which builds the
same Active/Discharged lifecycle directly on migration 53.

**Never apply these two files.** After 61, 57 would bring back the "ready for
discharge" status and its daily job and replace 61's functions; 60 refuses
without 59 and would redo what 61 did.

What carries forward:

- 61 = 60's discharge part (two statuses, the guard, discharge and reopen,
  the check-in guard) + 57's history table and follow-up mark, without
  anything that needs 55, 56 or 59.
- 60's per-plan links and reminder gating are deferred; see
  `../pending/README.md`.

`tests/` holds their database tests, for reference only (outside the test
run; they read paths under `supabase/migrations` that no longer exist here).

## After migration 63

Discharge is now the **patient's** (migration 63, `pat_care_status`), not a
plan's alone. 61's plan-level functions stay for compatibility; 57 and 60
remain superseded and are never to be applied or renumbered.
