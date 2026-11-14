# Patient Treatment Goal Progress Implementation Plan

> **For agentic workers:** executed natively in one session (task brief chose this); steps use checkbox syntax.

**Goal:** Doctors set treatment goals; patients move them pending → in progress → achieved; a scheduled database job marks overdue goals missed; every change is kept in `treatment_goal_status_event` with patient vs system attribution.

**Architecture:** One migration (55) adds a patient RPC, a progress guard trigger, a system-attributed missed job on pg_cron, and a `treatment_goal_change_source` column on the existing history table. The frontend reuses the treatment-plan API/hooks: the doctor's progress select becomes a read-only status, the patient's treatment page gains Start / Mark achieved buttons.

**Tech Stack:** React + TanStack Query, Supabase (PostgREST, RLS), PGlite db tests, Vitest, Playwright.

**Spec:** the task brief (Treatment Goals – Patient Progress and Automatic Missed Status).

## Global Constraints

- Migration `20260902100055_treatment_goal_progress.sql` (55 is free: 39/40 PRs #61/#62, 47 PR #75, 49–52 reserved, 53/54 on main).
- `set lock_timeout = '3s'` first, `reset lock_timeout` last; every function `set search_path = ''`; revoke from public, anon, authenticated, then grant only what is needed.
- Rollback `supabase/rollbacks/20260902100055_treatment_goal_progress.down.sql` with an "is not applied" guard; added newest-first to the three rollback-chain suites.
- Clinic date = `(now() at time zone clinic.clinic_timezone)::date` via the patient's doctor's clinic (as `mark_overdue_medication_logs`); never a hardcoded zone.
- No prod writes, no `supabase db push`, no commit/push.

## Decisions

- **Patient transitions** (`patient_update_treatment_goal_status(goal, status)`): pending→in_progress, pending→achieved, in_progress→achieved, missed→achieved (late completion: the MISSED event stays, a new ACHIEVED event follows). Anything else, `pending`/`missed` targets, a repeat, another patient's goal, or a plan that is not active is refused. Mirrors `patient_complete_recovery_activity` (owner check before lock, row `FOR UPDATE`, plan `FOR SHARE`).
- **Doctor:** creates goals (RLS unchanged); a session insert must start `pending`, and a session update may not change the status (`treatment_goal_guard_progress`). Target date set by a session: not before the clinic's today, within the plan's dates (the activity rule).
- **Missed job** `public.mark_missed_treatment_goals()`: status in (pending, in_progress), target date not null and < clinic today. One UPDATE (row locks re-check under READ COMMITTED, so a concurrent achieve wins); idempotent; failures re-raised with SQLSTATE only. pg_cron `recoverease-mark-missed-treatment-goals` at `10 * * * *`, guarded like migration 9. Service role only.
- **History source:** `treatment_goal_change_source` ∈ {user, system, service}; null for events before 55. `system` only when the job's transaction-local flag is set and there is no signed-in user; `changed_by` stays null for it.

## Tasks

1. DB tests `tests/db/treatment-goal-progress.test.ts` (19 cases from the brief) → fail → migration 55 + rollback → pass; update `recovery-roadmap.test.ts` status-history case to the patient RPC; rollback-chain suites.
2. Frontend: `api.ts` RPC, hook, patient page buttons, doctor page read-only status, goal form date validation; `Missed` label.
3. Unit + e2e (stub RPC) tests; full verification; docs (`database.md`, `deployment.md`).

## Review Focus

- Clinic midnight: a goal due today is not missed until the clinic's date passes (tested at the boundary with clinic zones ahead of UTC).
- Concurrent achieve vs job: row lock ordering (documented; PGlite single connection).
- Every patient has a doctor (`patient.doc_id` NOT NULL), so every goal has a clinic date.
- Doctor editing a missed goal's date: status stays missed (no doctor status change).
- Goals in a cancelled plan still follow the stated rule (missed when overdue).
