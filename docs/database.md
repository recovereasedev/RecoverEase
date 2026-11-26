# Database

The schema implements the RecoverEase ERD. This document records where the
implementation departs from the diagram and why, and the assumptions made
where the diagram was silent.

Migrations live in [`supabase/migrations/`](../supabase/migrations) and are
applied in filename order.

| File | Contents |
| --- | --- |
| `…100000_identity.sql` | `user_account`, `doctor`, `admin`, `patient` |
| `…100001_clinical.sql` | treatment plans and goals, prescriptions, medication schedules and logs, recovery logs, doctor notes |
| `…100002_scheduling.sql` | appointments, reschedule requests |
| `…100003_communication.sql` | chat sessions and messages, notifications, announcements |
| `…100004_operations.sql` | reports, audit log, system settings |
| `…100005_authorization_helpers.sql` | `app_private` schema and RLS helper functions |
| `…100006_rls_policies.sql` | every Row Level Security policy |
| `…100007_triggers_and_functions.sql` | column guards, audit triggers, dose generation, admin aggregates |

## Naming

The ERD uses camelCase with an entity prefix (`patFirstName`). PostgreSQL
folds unquoted identifiers to lower case, so `patFirstName` would silently
become `patfirstname`. The schema uses snake_case and **keeps the prefix**:
`patient.pat_first_name`. The mapping back to the diagram stays mechanical.

## Deviations from the ERD

Each of these is a deliberate decision, repeated in a comment at the point of
implementation.

### 1. `userAccount.userPasswordHash` is not implemented

Supabase Auth owns credentials in `auth.users`. Implementing the ERD's
password-hash column would create a **second credential store** — two places
a password can be wrong, two places it can leak, and no answer to which one
is authoritative.

`user_account.user_id` is the same value as `auth.users.id`, with
`ON DELETE CASCADE`. This is a security improvement over the diagram, not a
convenience.

### 2. Surrogate keys are `uuid`, not `int`

Sequential integers in a system holding patient data are enumerable. They
leak how many records exist and invite probing `/patients/1`, `/patients/2`.
Entities, attributes and relationships are otherwise exactly as drawn.

### 3. `report.patId` is nullable

The ERD shows it as a plain foreign key, but module 9.3 is "Generate
System-wide Report", which has no subject patient. Requiring one would make
that module impossible. A CHECK constraint keeps the two shapes honest:

```sql
check (
  (report_type = 'patient_recovery' and pat_id is not null)
  or (report_type = 'system_wide' and pat_id is null)
)
```

### 4. `medicationScheduleTimes` is `time[]`, not `varchar`

As a varchar this means a delimited string like `'08:00,20:00'`, which has to
be parsed by every reader and cannot be validated. As `time[]` it is the same
information, correctly typed, and the database can reject a schedule claiming
three doses a day while listing two times:

```sql
check (cardinality(medication_schedule_times) = medication_schedule_frequency)
```

**How the times are set.** The clinician does not type them. The medication
form asks for **Doses a day**, **Hours between doses** and **First dose at**,
and `calculateDoseTimes()` in `src/features/medications/dose-times.ts` works
out the day's times, which the form shows before anything is saved (group QA
9/12/26, item 4). For example, 3 doses a day, 4 hours apart, first at 08:00
gives 08:00, 12:00 and 16:00. The rules:

- Doses a day is a whole number from 1 to 12, the range
  `medication_schedule_frequency_sane` allows.
- Hours between doses is a whole number from 1 to 23. It is not asked for when
  there is one dose a day.
- Every dose falls on the same day, before midnight. A combination whose doses
  would cross midnight is refused with the reason, never wrapped into the next
  day or shortened: 4 doses 6 hours apart from 06:00 would put the last at
  24:00 and is refused, while from 00:00 it gives 00:00, 06:00, 12:00 and
  18:00. The stored times are a daily set that dose generation repeats on each
  day of the course, so a time past midnight would be scheduled on the first
  day before the first dose.
- The calculation is clock arithmetic on times of day, with no date or time
  zone involved. Dose generation places the times in the patient's clinic's
  time zone (`clinic.clinic_timezone`; before migration 31, the
  `app.timezone` setting, which held the same zone).

Only the calculated times are stored, in `medication_schedule_times`, with
`medication_schedule_frequency` counted from them. There is no interval
column, so there is one source of truth and nothing that could disagree with
the times. Dose generation, reminders, the patient's checklist, reports and
printing read them exactly as before. Schedules created before this, including
any whose times are not evenly spaced, remain valid and readable unchanged;
new schedules are always evenly spaced.

Covered by `tests/unit/medication-dose-times.test.ts`,
`tests/unit/medication-form-dose-times.test.tsx`,
`tests/db/medication-dose-times.test.ts` and
`e2e/medication-dose-times.spec.ts`.

### 5. `auditLogDetails` is `jsonb`, not `text`

Module 13.2 is "Filter / Search Audit Logs" — a structured query over
structured data. `jsonb` makes that indexable rather than a substring scan
over prose.

### 6. `chat_message` is a new table

The ERD models `chatSession` with no message entity, only an external
reference. Modules 8.4 ("View Chat History / Past Conversations") and 8.5
("View Patient Chat Transcript") cannot be implemented without stored
messages — a transcript *is* the messages.

This is the **only entity added** to the ERD, and it is added because two
named modules require it. `chat_session_external_ref` is retained for the
provider's own conversation id, so both models coexist.

### 7. Three columns added for ordering

| Column | Why |
| --- | --- |
| `treatment_goal_created_at` | The ERD gives goals no timestamp. `target_date` is nullable and uuid ordering is arbitrary, so a goal list would reorder between page loads. |
| `medication_schedule_created_at` | Same reason. |
| `reschedule_request_created_at` | The ERD has `respondedAt` but no submission time, so a doctor could not see which request arrived first (module 6.4). |

### 8. Clinics are new

The ERD has a single implicit clinic. Phase A adds `clinic` (migration 28)
and gives every doctor and Clinic Admin one (`doctor.clinic_id`, required;
`admin.clinic_id`, required of a Clinic Admin; migration 29). A patient has no
clinic column: their clinic is their doctor's, so it cannot disagree with it.
`announcement.clinic_id` and `report.clinic_id` record whose they are, and
`audit_log` gains `clinic_id` and `audit_scope` (migration 30). Triggers set
all of these from the row's source rather than from the request.

Migration 31 makes settings and time the clinic's (decision D3).
`system_setting.clinic_id` is required, set from the Clinic Admin who writes
it, and unique together with the key. `clinic.clinic_timezone` is the only
time zone anything reads: each function that works out a date or a time -
"today", dose slots, missed doses, reminders, notices, date checks - resolves
the clinic from its own row, through the patient's doctor. The old
`app.timezone` row stays, read by nothing, as an alias the settings screen
deployed before 31 saves through.

Migration 34 drops the index that allowed only one clinic row, and the
key-only settings index, which only the settings screen deployed before 31
needed: every reader of a setting, date or time now resolves its clinic from
its own row, and `tests/db/gate-lift.test.ts` shows two clinics, one with
daylight saving time, each keeping its own settings, "today" and dose times.
What still assumes a single clinic refuses rather than guesses: `app_today()`
and the settings and doctor clinic defaults, asked by a server-side writer
that names no clinic, raise once there are two. The `app.timezone` alias
stays, as one clinic's row passed only to that clinic; a new clinic gets
none.

### 9. The Super Admin is new

The ERD's administrator is a clinic's. Migration 32 adds `super_admin` to
`user_role`, and migration 33 a `super_admin` profile table (names only, no
clinic) for the platform's administrator. An announcement now has exactly one
author: a Clinic Admin (`admin_id`, with their clinic) or a Super Admin
(`super_admin_id`, with no clinic - a platform announcement). `clinic_name`
is bounded at 120 characters. The audit log's `platform` scope gains the
Super Admin's own entities: `super_admin`, `clinic_admin_account` and
platform announcements. From migration 35 the Super Admin's read of them,
`super_admin_list_audit`, carries in `audit_log_details` only the names of
the fields an update changed (`{"changed_columns": [...]}`, or NULL), never a
stored value; the entries themselves are unchanged.

Migration 46 adds no table: `super_admin_platform_overview()` returns one
`jsonb` of platform totals - `clinics` (`total`, `active`, `inactive`),
`clinic_admins`, `doctors` and `patients` (`total`, `active`),
`announcements` (`published`, `drafts`) and `generated_at` - and nothing
per clinic. A platform announcement is one with a `super_admin_id`,
published when `announcement_published_at` is set.

Migration 48 (applied to production on 2026-11-09 - do not apply it
again; its clinical decisions were owner-accepted without clinical adviser
review, not clinically approved - `docs/medication-clock-change-decisions.md`)
gives each dose an identity:
`medication_log_dose_date` and `medication_log_dose_time`, the clinic-local
date and wall-clock time it was created for, unique per schedule
(`medication_log_occurrence_key`) and never changed. The generator creates a
dose only for an occurrence that is not already a dose or a
`medication_dose_conflict` - one held for the treating doctor because the
time does not exist or happens twice that day (a clock change), or because
its moment is already another dose of the schedule (after a time zone
change). A conflict has the same identity columns, a reason, the moment
PostgreSQL would give it, and, once decided, the resolution
(`rescheduled`, `not_given_separately` or `course_ended`), the doctor, the
time and the reason. A rescheduled conflict's dose is an ordinary
`medication_log` row. A schedule's times, frequency, start date and
prescription can no longer be edited. See `docs/deployment.md`, "Medication
dose identity and clock-change conflicts (migration 48)".

Migration 36 adds a third announcement author: `announcement.doc_id`, a
doctor writing for their own patients. An announcement still has exactly one
author (`announcement_one_author`: a Clinic Admin, a doctor or a Super
Admin), and its clinic still follows from that author
(`announcement_clinic_follows_author`, set by `announcement_assign_clinic`).
Who reads it follows from the author too: a platform announcement everyone,
a Clinic Admin's their clinic, and a doctor's only the patients assigned to
that doctor now, while the doctor is active
(`app_private.current_assigned_doctor_id()`).

### 10. A reminder before each dose

The ERD's `medicationLogFollowUpSentAt` records the reminder sent after an
unrecorded dose came due. Migration 37 adds the reminder before it (plan
section 5) and its own record beside that one:
`medication_log.medication_log_pre_dose_sent_at`, stamped by
`dispatch_medication_pre_dose_reminders()` when it sends the reminder, so
each dose gets at most one. Only that job writes it: a direct client write is
refused (`medication_log_guard_pre_dose_mark`), as migration 22 refuses one of
the appointment reminder's mark.

The lead time is each clinic's `medication.reminder_lead_minutes` setting
when that is 5, 10, 15 or 30, and ten minutes otherwise. A dose gets the
reminder while it is pending and not yet due, within that lead time, if its
patient has reminders on and their preferred time of day has been reached,
and if it is not after its course's end date. The job runs every minute. A
dose already due when it runs is left to the follow-up, which is unchanged.

### 11. The guidance assistant can be switched off

Migration 38 adds the adviser's "AI Chatbot On/Off" as two switches, and the
assistant answers only where both are on:

- **The platform's**: `app_private.platform_setting`, key
  `guidance_assistant.enabled`, value `true` or `false`. It is in
  `app_private`, which the Data API does not expose, with row level security
  on, no policy and no grant to the API's roles: it is read and written only
  through `super_admin_get_guidance_assistant()` and
  `super_admin_set_guidance_assistant(boolean)`, which an assured Super Admin
  alone may call. Each change is audited as a platform entry (entity
  `platform_setting`).
- **Each clinic's**: the `system_setting` key `chatbot.enabled`, written by its
  Clinic Admin like any other clinic setting.

A switch never set counts as on, so nothing changed when the migration went
in; any value but `true` counts as off. The rule is one function,
`app_private.guidance_assistant_on(clinic_id)`, read by
`guidance_assistant_available()` (the signed-in user's own clinic, for the
patient's screen) and `guidance_assistant_on_for_doctor(doc_id)` (the service
role's only, for `chatbot-reply`).

### 12. A doctor's notification is a general message

Module 7.1 lets a doctor write to their own patient. Before migration 41 the
insert policy checked only the recipient, so a direct Data API call could
send a doctor's words as any type - a critical-chat alert, a reminder, an
announcement - linked to a conversation or already read. Migration 41 keeps
the recipient rule (an active doctor's own patient) and adds what the form
sends: `notification_type = 'general'`, no `chat_session_id`, unread, and a
message of 1 to 1,000 characters once trimmed.

The system's own notifications are not affected: every database function
that writes one is SECURITY DEFINER, and `chatbot-reply` writes its alerts
with the service role. The website also chooses each message's
`notification_id`, so a repeated send is refused as a duplicate key and is
stored once.

### 13. A doctor can turn their own appointment reminders off

Module 7.3, the doctor's own. `dispatch_appointment_reminders` (migration 18)
writes two notifications the day before each appointment, one to the doctor
and one to the patient. Migration 42 adds
`doctor.doc_appointment_reminder_is_enabled`, on by default, so every doctor
keeps that reminder until they turn it off on **My profile → Reminder
settings**. The job then leaves that doctor out; the patient's reminder is
sent as before, and the appointment is still marked reminded, so turning it
back on never sends one late.

Only the doctor may change it. Their clinic's administrator may still edit
the rest of the row (module 11.3), but `doctor_guard_reminder_preference`
refuses a change to this column from any signed-in user other than the
doctor. Nothing clinic-wide changes: no setting, time zone, grace period or
lead time, and no patient's reminder preference.

### 14. A system-wide report keeps its figures

Module 9.5, with the download the adviser asked for. Migration 43 adds
`report.report_snapshot` (jsonb): the figures a system-wide report was
generated with, exactly as `admin_dashboard_stats()` returned them. It is
written only by `admin_record_system_report()`, which the Clinic Admin's
**Generate report** calls: the function computes the figures for the
caller's clinic (refusing anyone but a Clinic Admin) and records the report
with them in one statement. `report_guard_snapshot` refuses any signed-in
user writing or changing a snapshot, and a check constraint keeps one off a
doctor's recovery report. Rows from before 43 have none, and nothing
invents them. Reading is `report_select`, unchanged; no file is stored.

### 15. The recovery roadmap

Module 5.7, enhanced (migration 45). Applied to production on 2026-11-04
(`docs/deployment.md`, "Recovery roadmap (migration 45)"). From migration
56 the phases are generated, not built by hand - see section 18; what
follows describes 45 as it was. A
treatment plan is laid out as numbered phases, each holding the activities
the doctor assigns, which the patient marks done. What already exists stays
the one source of truth and is never copied:

| Already there | Used as | Never |
| --- | --- | --- |
| `treatment_plan` | the roadmap's parent; each active plan has its own roadmap and its own progress | combined with another plan |
| `treatment_goal` | its one authoritative status; now optionally in one phase of its own plan (`recovery_phase_id`) | duplicated as an activity |
| `medication_log`, `medication_schedule` | upcoming doses; adherence charts | recorded again, or counted in roadmap progress |
| `appointment` | upcoming visits | recorded again, or counted in roadmap progress |
| `recovery_log` | mood charts | recorded again, or counted in roadmap progress |

New:

- **`recovery_phase`**: a plan's phases - title, description, order, and
  optional start and target end dates inside the plan's. A partial unique
  index keeps one current phase per place in the order.
- **`recovery_activity`**: a phase's doctor-assigned activities - title,
  instructions, optional target date, order - and the patient's completion
  (`recovery_activity_completed_at`, `_completed_by`).
- **`recovery_activity_event`**: every time the patient marked an activity
  done or undid it (`completed` / `reopened`), with who and when.
  Append-only.
- **`treatment_goal_status_event`**: every change of a goal's status from
  migration 45 on - previous status, new status, who, when - written by a
  trigger on `treatment_goal`. Goals achieved before it have no recorded
  date, and none is invented.

The patient writes only through `patient_complete_recovery_activity()` and
`patient_reopen_recovery_activity()` (owner's rights): they check the caller
is the plan's patient, the plan is active and the activity and its phase are
current, lock the row so a second press is refused rather than doubled,
stamp the server's time and record the event. The doctor reorders through
`doctor_reorder_recovery_phases()` and `doctor_reorder_recovery_activities()`
(caller's rights, under their own RLS), which take the full new order in one
call. Nothing is deleted through the website: a phase or an activity is
archived (`_archived_at`), its history kept; archiving a phase takes its
goals out of it. Either can be restored: a phase comes back at the end of
its plan's order with its activities and whatever was done in them (its
goals stay out until placed again), and an activity at the end of its
phase, done or not as it was - only while that phase is current.

Changes that meet are serialised by row locks, not left to chance: a
reorder locks the plan's (or phase's) current rows before it checks the
new order, and writes only those rows, so none is archived, restored or
moved out from under it and no archived row is given a place; placing a
goal in a phase locks the phase `FOR SHARE`, so the goal and an archive of
that phase cannot cross - whichever comes second either takes the goal back
out or is refused; and the patient's functions check whose activity it is
before they lock it, so nobody else's call takes the lock, then hold the
activity, its phase and its plan (the last two `FOR SHARE`) until the call's
transaction ends, so a phase archived or a plan closed at the same moment
cannot slip in after the check. An activity added, moved or restored holds
its phase `FOR SHARE` the same way. Locks go activity, then phase and plan;
nothing that changes a phase or a plan goes on to lock an activity, so these
cannot deadlock. Goals and phases are the one pair taken in both orders: an
update of a goal locks the goal before its trigger asks for the phase, and an
archive locks the phase before it takes its goals out. So only the archive's
order may wait: a goal joining a phase asks for it `NOWAIT`, and while
someone else is changing that phase it is refused at once (`55P03`, shown to
the doctor as "try again") rather than waiting with the goal held. Tried
again, it finds the phase current or archived. Without that, an update of
several goals - one already in the phase - and an archive of the phase could
each wait for the other.

A goal joins only a phase of its own plan - a composite foreign key
(`treatment_goal_phase_in_plan`, `ON DELETE SET NULL (recovery_phase_id)`,
PostgreSQL 15 and later; production runs 17.6) - and only a current one.

**Roadmap progress** = (activities marked done + goals in a phase marked
achieved) / (activities + goals in a phase), per plan, as a whole percent;
with nothing to count there is none ("No activities yet"). Doses,
appointments and check-ins are never counted
(`src/features/recovery-roadmap/roadmap.ts`).

> Sections 16-21 describe migrations 54-60, which are **not** in the
> discharge-only release (`supabase/pending`, `supabase/superseded`).
> Section 22 is what this release ships.

### 16. A doctor's record ID and registration date are fixed

> Shipped as **migration 62** (pending 54, renumbered after 61; see section 23).

Module 11.2. A Clinic Admin edits a doctor's first and last name, licence
number, specialisation and contact number from **Doctor accounts → Edit**,
through migration 30's `doctor_update_self_or_admin` (their own clinic's
doctors only). That policy decides *whose* row may be updated, not *which
columns*, and two had no guard: an administrator could rewrite a doctor's
`doc_id` (where nothing referenced it yet) and `doc_created_at`, and a doctor
their own `doc_created_at`.

Neither has a legitimate change. `doc_id` is the identity every clinical
record, appointment and audit entry points at; `doc_created_at` is when the
account was registered, shown on Doctor accounts. Migration 54 adds
`doctor_identity_is_fixed`, a `before update` trigger that refuses a change
to either (`insufficient_privilege`) for every writer - the service role and
the database's own jobs included, like the clinic (migration 29). Sending
either back unchanged is not a change and is accepted. The policy and the
guards of migrations 7, 29 and 42 are untouched.

### 17. Treatment goal progress and the missed status

> Shipped as **migration 64** (pending 55, renumbered). From 64 the missed-goal
> job skips a patient whose care is discharged (section 23) and a discharged
> plan, the patient's progress is refused while their care is discharged, and
> the job's first run is limited to an approved set of goals (below).

Modules 3.3 and 5.8, completed by migration 55. The doctor sets a goal
(RLS of migration 6, unchanged: the patient's assigned, active doctor); the
patient records progress; the system marks a goal missed. Nobody else
changes a goal's status.

- **The patient** calls `patient_update_treatment_goal_status(goal, status)`
  (`SECURITY DEFINER`, empty `search_path`, `authenticated` only). It checks
  the caller owns the goal's plan before taking a lock (another patient's or
  a guessed ID gets the same refusal), locks the goal `FOR UPDATE` and the
  plan `FOR SHARE`, requires the plan to be active, and changes the status
  alone: pending → in progress, pending → achieved, in progress → achieved,
  and missed → achieved. A repeat, a step back, `pending` or `missed` is
  refused. The patient still has no UPDATE policy on `treatment_goal`.
- **Late completion.** A missed goal the patient reaches later may be
  marked achieved. The missed event stays in the history and the achieved
  one follows it, so the record shows both that the date passed and that
  the goal was reached; the job never touches an achieved goal.
- **The doctor** may not set a status: `treatment_goal_guard_progress`
  (`before insert or update`, runs as the caller) refuses a session insert
  that is not `pending` and a session update that changes the status. A
  target date set by a session must not be before the clinic's today and
  must lie within the plan's dates. The two functions above run as their
  owner and pass.
- **The system.** `mark_missed_treatment_goals()` (`service_role` only)
  sets `missed` on every goal still pending or in progress whose target
  date is before today in its clinic's time zone (patient → doctor →
  clinic, as the medication jobs). Goals with no target date are never
  touched. One `UPDATE`, so a concurrent achievement is re-checked and wins;
  a second run changes nothing. Failures are raised with the SQLSTATE only.
  pg_cron runs it hourly as `recoverease-mark-missed-treatment-goals`
  (`10 * * * *`), guarded as migration 9.
- **The first run (64).** Goals already overdue when 64 is installed would
  all turn missed at once, so the job's first run is limited to a set of
  goals approved in advance, all or none. `app_private.missed_goal_bootstrap`
  (one row; every privilege revoked; `app_private` is not exposed through the
  Data API) is `unarmed` → `armed` → `consumed`, forward only (its trigger
  refuses anything else, a delete or a truncate - SQLSTATE `RE64C`).
  - Unarmed, the job refuses to run (`RE64A`) and changes nothing.
  - `app_private.arm_missed_goal_bootstrap(ids)` (database owner only) arms
    it with exactly the goals the job would mark at that moment
    (`app_private.missable_treatment_goal_ids()`), each once; any other set
    is refused (`RE64B`). The deployment applies 64 and arms it in **one
    transaction**; the IDs are given then and are in no tracked file. It may
    be re-armed, the same rule, until it has run.
  - Armed, the job locks the approved goals `FOR UPDATE NOWAIT` and their
    plans and patients `FOR SHARE NOWAIT` (a goal being changed makes the
    run fail with 55P03), re-checks each against the job's own rule, and
    marks exactly those goals or, if any is no longer eligible, nothing
    (`RE64B`). It records the run consumed in the same transaction, so any
    failure leaves it armed and every goal as it was.
  - Consumed, it is the ordinary hourly job above, for good.
  Tested in `tests/db/missed-goal-first-run.test.ts` (real row locks held by
  prepared transactions); suites that use the hourly job complete the first
  run first (`tests/db/helpers/missed-goal-bootstrap.ts`).
- **History.** `treatment_goal_status_event.treatment_goal_change_source`
  (new, nullable): `user` (a signed-in person, in `treatment_goal_changed_by`),
  `system` (the job: no actor, and only when no one is signed in), or
  `service` (any other change with no one signed in). Events from before 55
  keep a null source; none is rewritten or deleted.

### 18. The recovery roadmap is generated

> Shipped as **migration 65** (pending 56, renumbered). While a patient is
> discharged, no signed-in person changes the roadmap (section 23).

Module 5.7, migration 56 (**not applied to production**; see
`docs/deployment.md`, "Automatic recovery roadmap (migration 56)"). It
replaces the hand-built phases of section 15. Every treatment plan has
exactly **goals + 2** current phases, made and kept in step by the database:

| Order | Kind (`recovery_phase_kind`) | Title | Dates |
| --- | --- | --- | --- |
| 1 | `initial` | Initial Recovery | starts on the plan's start date |
| 2 … 999 999 | `goal`, one per goal (`treatment_goal_id`, unique), in the order goals were set | Recovery and Monitoring (shown with the goal's own description) | due on the goal's target date |
| 1 000 000 | `follow_up` | Follow-up and Assessment | due on the plan's end date, with the plan's follow-up appointment |

- **Generator.** `app_private.sync_recovery_roadmap(plan)` (owner's
  rights, `service_role` only) makes any missing phase, relinks
  `treatment_goal.recovery_phase_id` to the goal's own phase, and updates a
  date only where it differs; run again, it writes nothing. Triggers run it
  when a plan is created or its start or end date changes, and when a goal
  is added or its target date changes. It locks the plan `FOR NO KEY
  UPDATE`, so goals added to one plan at once are generated one after the
  other without conflicting with a new goal's foreign-key lock.
- **Held by the database.** A partial unique index allows one current
  `initial` and one current `follow_up` per plan; `unique
  (treatment_goal_id)` one phase per goal; checks require every current
  phase to have a kind (and a `goal` phase its goal) and pin each kind's
  place in the order. Adding a goal never rewrites another phase.
- **A goal deleted.** `treatment_goal_retire_phase` moves its phase's
  current activities, in order, to Initial Recovery (same rows, completion
  and history kept) and archives the phase. Nothing when the whole plan is
  deleted.
- **Status is not copied.** A goal phase shows `treatment_goal_status` from
  the goal; section 17's workflow stays its only writer.
- **No manual phases.** The doctor's insert policy,
  `doctor_reorder_recovery_phases()` and the release of goals on archive are
  removed; INSERT, DELETE and TRUNCATE on `recovery_phase` are revoked from
  `anon` and `authenticated`. UPDATE stays granted, with the doctor's update
  policy, only because the doctor's own goal and activity writes lock a
  phase `FOR SHARE` (which needs both); `recovery_phase_prepare` refuses every
  session update ("Roadmap phases are generated by the system"). A session
  may not change a goal's `recovery_phase_id` or move a goal to another plan
  (`treatment_goal_keep_roadmap`); a phase named when adding a goal is
  dropped. Activities are unchanged: the doctor adds, edits, orders,
  archives and restores them in any current phase, the patient marks them
  through section 15's functions.
- **Follow-up appointment.** `treatment_plan.treatment_plan_follow_up_appointment_id`
  (nullable), chosen by the doctor. A composite foreign key to
  `appointment (appointment_id, pat_id)` (new unique constraint
  `appointment_id_patient_unique`) means it can only be the plan patient's
  own appointment; `ON DELETE SET NULL` on that column alone. `appointment`
  has no type or plan of its own, so nothing is inferred: with none chosen,
  the phase says so. Date and status are read from the appointment, so a
  reschedule or cancellation shows at once.
- **Existing roadmaps.** A current hand-made phase holding exactly one goal
  becomes that goal's phase in place (same row, activities, history and
  description). Every other current hand-made phase hands its current
  activities, in order, to Initial Recovery and is archived (kind null).
  Nothing is deleted; activities already archived stay where they were.
- **Not recovery.** Nothing here reads or writes `treatment_plan_status`, a
  patient or an account. A roadmap fully done is progress; completing the
  plan and discharging the patient stay the doctor's decisions.

**Roadmap progress** is unchanged in form: (activities done + goals
achieved) / (activities + goals), now counting every goal, since every goal
has its phase.

### 19. Discharging and reopening a treatment case

> **Superseded.** Migrations 57 and 60 were never applied and stay in
> `supabase/superseded/`. Discharge is now the patient's (section 23), with
> the plan-level discharge of section 22 kept alongside.

Migrations 57 and 60 (**neither applied to production**; see
`docs/deployment.md`, "Discharge and reopen a treatment case (migration 57)"
and "A care case is Active or Discharged (migration 60)"). A treatment plan is
the patient's care case. From migration 60 it has exactly two statuses, and
only the patient's assigned, active doctor moves it between them:

| From | To | By |
| --- | --- | --- |
| `active` | `discharged` | the patient's assigned, active doctor, with a closure reason |
| `discharged` | `active` | the same doctor (reopen) |

- **Two statuses.** The check `treatment_plan_status_valid` allows only
  `active` and `discharged`, for every writer including the service role.
  The `treatment_plan_status` enum still lists `draft`, `completed`,
  `cancelled` and `ready_for_discharge` (PostgreSQL cannot drop an enum
  label); the check is what refuses them. Migration 60 made every plan that
  was ready for discharge active (the doctor had not discharged it) and kept
  every discharged one; it refuses to run while any plan is draft, completed
  or cancelled, since no rule says what those become.
- **Nothing automatic.** Migration 57's daily readiness job
  (`mark_treatment_plans_ready_for_discharge()`, pg_cron
  `recoverease-mark-plans-ready-for-discharge`) and its "ready for discharge
  review" notifications are gone (60). No job replaces them: a plan past its
  end date, or with every goal achieved, stays active until the doctor
  discharges it.
- **Discharge metadata.** `treatment_plan_closure_reason`
  (`completed_recovery`, `transferred`, `withdrew`, `lost_to_follow_up`,
  `referred`) and `treatment_plan_discharged_at`, both set exactly while the
  plan is discharged (a check holds this even for the owner); reopening
  clears them.
- **Writes.** `doctor_discharge_treatment_plan(plan, reason)` and
  `doctor_reopen_treatment_plan(plan)`: `SECURITY DEFINER`, empty
  `search_path`, `is_my_patient` before any lock (the same refusal for
  another doctor's plan, a doctor in another clinic, a Clinic Admin, a
  patient or a missing plan), then the plan `FOR UPDATE` and the allowed
  transition only. `treatment_plan_guard_lifecycle` refuses any session that
  inserts a discharged plan, moves a plan into or out of `discharged`, or
  writes the two columns, so the API cannot bypass the functions.
- **History.** `treatment_plan_lifecycle_event`: previous and new status,
  the reason on a discharge, `treatment_plan_changed_by`, source and time.
  Written only by `treatment_plan_record_lifecycle` on a real status change,
  in the same transaction as the change and before the reopening's update is
  visible; no session may write, change or delete it; readable by whoever may
  read the plan. Each discharge and each reopening is its own row, so a
  reopened case keeps every earlier discharge with its reason and time.
- **Open care.** Only an `active` plan is open: the patient's activity and
  goal functions refuse a discharged plan. The missed-goal job skips
  discharged plans, and checks them again once reopened.
- **Check-ins.** `recovery_log` is the patient's, not a plan's, and no
  check-in records a plan, so none is guessed. `recovery_log_guard_care_ended`
  refuses a session adding or changing a check-in while the patient has a
  discharged plan and no active one ("Your care plan has ended. Book a
  follow-up if you need more care."). A patient with an active plan, or no
  plans, is unaffected. The schema has no symptom log: the check-in's notes and
  mood rating are the only place a patient records how they feel, and this
  guard covers them.
- **A care plan of its own (60).** `prescription.treatment_plan_id` and
  `appointment.treatment_plan_id` (nullable, `on delete set null`, indexed)
  record which plan a prescription or appointment belongs to.
  - **New rows.** `prescription_link_care_plan` and
    `appointment_mark_follow_up` (both run as the caller, before insert or
    update) fill it in with the patient's only active plan. With several
    active plans a session must name one ("Choose which care plan …"); with
    none it stays null. A named plan must be the same patient's, for every
    writer (a session cannot even see another patient's plan), and active,
    for a session. A foreign key on `(treatment_plan_id, pat_id)` to
    `treatment_plan (treatment_plan_id, pat_id)` (unique key
    `treatment_plan_id_pat_id_key`) holds this on every write, whatever the
    row policies show: a linked row cannot be moved to another patient with
    its link left as it was, nor a linked plan given to another patient.
    Deleting a plan clears only the link (`on delete set null
    (treatment_plan_id)`). Once set, no session changes it. An appointment booked
    while the patient's care has ended is a follow-up request and belongs to
    no plan.
  - **Screens.** The doctor's prescription form and appointment dialog and
    the patient's booking dialog ask "Care plan" only when the patient has
    several active plans (`CarePlanField`), and otherwise send the only one.
  - **Existing rows.** Linked only where the patient has exactly one plan.
    Rows of a patient with several plans stay null - nothing is guessed - and
    follow-up requests stay null. They are placed by hand (queries in
    `docs/deployment.md`, migration 60).
- **Reminders (60).** `app_private.care_reminders_allowed(plan, patient)`
  fails closed:
  - on a plan: true only while that plan is the same patient's and active;
  - on no plan, for a patient who has any plan: false. Nothing says which
    plan the row belongs to - another plan being active proves nothing - so
    it is silent until placed on a plan by hand;
  - on no plan, for a patient with no plan at all: true, as before 60.

  So a discharged plan's medicines and appointments stop while another
  plan's continue, and a follow-up request (below) is always reminded about.
  The four reminder
  readers ask it, each as 59 (medication, phone) or 53 (appointment) left it
  but for the lines marked `(60)`:
  - `dispatch_medication_pre_dose_reminders()` and
    `dispatch_medication_reminders(integer)` write nothing for a dose of a
    discharged plan, and leave the dose unmarked;
  - `dispatch_appointment_reminders(integer)` writes nothing for an
    appointment of a discharged plan, but always reminds about a follow-up
    request (below);
  - `app_private.push_source_is_current(...)` drops a queued phone reminder of
    a discharged plan when it comes to be delivered (`skipped`,
    `source_no_longer_valid`, for good).

  A medicine is reminded about only when its plan allows it **and** the
  doctor has its reminders on (59) **and** the patient wants reminders
  (module 4.9). Nothing is deleted: pending reminders are cancelled by not
  being written or not being delivered, and every dose, log, appointment and
  notification stays as it was. A reminder already in the patient's
  notification list stays there.
- **The reminder card.** The in-app card (`src/features/reminders/`) applies
  the same rule to the patient's doses and appointments
  (`remindersAllowedFor`), and shows nothing until it knows the patient's
  plans; so does the phone calendar file. A follow-up request is always shown.
  Records stay on their own pages. The doctor's card is unchanged.
- **Reopening sends nothing about the past.** The follow-up job, and the
  check before a queued phone reminder (either kind) is delivered, accept
  only doses that came due after the dose's own plan was last reopened
  (`app_private.care_reopened_at(plan, patient)`, from that plan's history).
  Reopening one plan
  changes nothing for another. A reminder already sent is never repeated:
  each job's own "sent" mark is unchanged. Reopening creates no dose. An
  appointment of the reopened plan that is still ahead is reminded about
  once, as it would have been.
- **Follow-up request.** `appointment.appointment_follow_up_of_plan_id`,
  set only by `appointment_mark_follow_up` when the appointment is booked
  while the patient's care has ended (their most recently discharged plan);
  sessions cannot set or change it, and it stays when the case is reopened.
  The doctor's appointment list shows it as **Follow-up request**. Booking is
  never refused for a discharged patient. It is not the roadmap's chosen
  follow-up appointment (section 18) unless the doctor picks it.
- **Not touched.** The patient row (`pat_status` stays as it was), the
  account, and every record. `patient_status = 'discharged'` is not used.

### 20. A medicine has instructions of its own

> Shipped as **migration 66** (pending 58, renumbered).

The ERD gives a prescription notes (`prescription_notes`) and a medicine
none. Migration 58 adds `medication_schedule_instructions` to
`medication_schedule`: the doctor's instructions for that one medicine,
apart from the notes that apply to the whole prescription.

```sql
check (
  medication_schedule_instructions is null
  or (btrim(medication_schedule_instructions) <> ''
      and char_length(medication_schedule_instructions) <= 500)
)
```

- **Optional.** "None" is NULL, never an empty string. Every schedule from
  before 58 has NULL; nothing was copied from the prescription's notes.
- **The doctor's words only.** No screen, job or function writes it; the
  form has no suggested text.
- **Who may write it** is the row's existing rule (migration 6): only the
  patient's own doctor inserts or updates a schedule, and a patient cannot
  update one. Migration 48's guard fixes a schedule's times, frequency,
  start date and prescription; the instructions are not among them, so the
  doctor can correct them on a medicine already prescribed, running or
  ended.
- **Nothing follows from a change.** No trigger reads the column: doses,
  reminders and adherence are untouched.

The patient reads them under the medicine on **Medications → Your
prescriptions**, and the prescription PDF prints them in that medicine's
row, under its times.

Covered by `tests/db/medication-instructions.test.ts`,
`tests/unit/medication-instructions.test.tsx`,
`tests/unit/medication-instructions-api.test.ts` and
`tests/unit/documents.test.ts`.

### 21. The doctor switches a medicine's reminders on or off

> Shipped as **migration 67** (pending 59, renumbered).

The ERD gives a patient a reminder setting and a medicine none. Migration 59
adds two columns to `medication_schedule`:

| Column | Type | Meaning |
| --- | --- | --- |
| `medication_schedule_reminders_is_enabled` | `boolean not null default true` | Whether RecoverEase reminds the patient about this medicine. Set by the patient's doctor. |
| `medication_schedule_reminders_enabled_at` | `timestamptz`, null | When reminders were last switched back on. Stamped by the database (`medication_schedule_stamp_reminders`); a value a writer sends is ignored. |

- **On by default.** Every schedule from before 59, and every new one, has
  reminders on. Nothing decides for the doctor which medicine needs them.
- **Both must agree.** A reminder is sent only when the doctor has reminders
  on for the medicine **and** the patient wants medication reminders
  (`pat_reminder_is_enabled`). The patient's setting is never changed by the
  doctor's.
- **Who reads it.** The reminder before a dose
  (`dispatch_medication_pre_dose_reminders`), the follow-up
  (`dispatch_medication_reminders`), and the check a queued phone reminder
  gets before delivery (`app_private.push_source_is_current`). Each is as
  migration 53 left it but for that condition.
- **Switching back on** sends nothing about the past: the follow-up is only
  for doses due from `..._enabled_at`, and a dose already reminded about
  keeps its mark.
- **Who does not read it.** Dose generation, the missed-dose job, adherence
  and the checklist. A medicine with reminders off still has its doses,
  they can still be recorded, and an unrecorded one still becomes missed.
- **Who may write it** is the row's existing rule (migration 6): only the
  patient's own doctor updates a schedule.

Covered by `tests/db/medication-reminder-controls.test.ts`,
`tests/unit/medication-reminder-control.test.tsx`,
`tests/unit/medication-reminder-control-api.test.ts` and
`tests/unit/doctor-prescription-print.test.tsx`.

### 22. A care plan is Active or Discharged (migration 61)

Migration 61, on top of 53 alone. `treatmentPlan.treatmentPlanStatus` gains
`discharged`, and `treatment_plan_status_valid` allows only `active` and
`discharged` (the enum keeps migration 1's `draft`, `completed` and
`cancelled`, which PostgreSQL cannot drop; the check refuses them).

- `treatment_plan_closure_reason` (`completed_recovery`, `transferred`,
  `withdrew`, `lost_to_follow_up`, `referred`) and
  `treatment_plan_discharged_at` are set together exactly while a plan is
  discharged, and cleared on reopening.
- `treatment_plan_lifecycle_event` keeps every status change from 61 on:
  previous and new status, reason, who (`treatment_plan_changed_by`, null
  for the service), source (`doctor` or `service`) and when. Written only by
  the trigger `treatment_plan_record_lifecycle`; readable by anyone who may
  read the patient; nobody signed in may insert, change or delete.
- `doctor_discharge_treatment_plan(plan, reason)` and
  `doctor_reopen_treatment_plan(plan)` are the only session paths, for the
  patient's assigned, active doctor; `treatment_plan_guard_lifecycle`
  refuses every other session write into or out of `discharged` and of the
  two columns.
- `recovery_log_guard_care_ended`: no new or changed check-in while the
  patient has a discharged plan and no active one.
- `appointment.appointment_follow_up_of_plan_id`: set by the database on
  booking while the patient's care has ended (their most recently
  discharged plan); a session cannot set or change it. A foreign key on
  `(appointment_follow_up_of_plan_id, pat_id)` referencing the unique
  `treatment_plan (treatment_plan_id, pat_id)` keeps it on a plan of the
  appointment's own patient for every writer (an appointment or a plan
  cannot be moved to another patient while marked); deleting the plan
  clears only the mark.
- Unchanged: reminders (no per-plan link exists at 53; see
  `docs/deployment.md`), roadmap activities (45 already requires an active
  plan), goals (doctor-only at 53), and every patient, account and record.

### 23. A patient's care is In Care or Discharged (migration 63)

The clinic's rule: **the doctor manually discharges the patient.** A
patient's care never depends on a treatment plan existing or not, a plan's
dates or status, goals, the roadmap, appointments, a date or any scheduled
job. Three statuses are kept apart:

| | Column | Means | Moved by |
| --- | --- | --- | --- |
| Account | `patient.pat_status` | Whether the patient can use their account | Administrators, as before. Never by a discharge |
| Care | `patient.pat_care_status` (`in_care`, `discharged`) | Whether the patient is in the clinic's care | Only `doctor_discharge_patient_care` / `doctor_reopen_patient_care` |
| Plan | `treatment_plan.treatment_plan_status` (`active`, `discharged`) | One plan's own state (section 22) | Only the 61 functions; never by the patient's discharge |

- New patients, and every patient that existed before 63, are `in_care`.
  Nothing is inferred from their plans or their plan-level history.
- `pat_care_closure_reason` (the five reasons of section 22) and
  `pat_care_discharged_at` are set together exactly while discharged, and
  cleared on reopening (`patient_care_discharge_complete`).
- `patient_care_event`: every change - previous and new status, reason,
  `patient_care_changed_by` (account) and `patient_care_changed_by_doc_id`
  (doctor), source (`doctor` or `service`), when. Written only by the
  trigger `patient_record_care_event`; readable by the patient and their
  assigned doctor; no session may insert, change or delete; no writer may
  change an event (`patient_care_event_append_only`).
- `doctor_discharge_patient_care(patient, reason)` and
  `doctor_reopen_patient_care(patient)` are `SECURITY DEFINER`, granted to
  `authenticated` only, and refuse anyone but the patient's assigned, active
  doctor (`app_private.is_my_patient`) - the patient, another doctor, a
  deactivated doctor, a Clinic Admin and a visitor - in the same words for a
  patient who does not exist. They lock the patient row `FOR UPDATE`, so a
  second press waits and is refused ("already discharged" / "already in
  care"). `patient_guard_care` refuses every other session write of the
  three columns.
- **Read-only care.** `care_record_guard_discharged`, on `treatment_plan`,
  `treatment_goal`, `recovery_phase` and `recovery_activity`, refuses every
  insert, update and delete made by a signed-in person - directly or through
  any function, the patient's activity and goal functions and the plan-level
  61 functions included - while the patient's care is discharged. It holds
  the patient row `FOR SHARE`, so it and a discharge cannot cross. The
  service role and jobs are not stopped by it; the missed-goal job (64)
  skips discharged care itself. Reading is never affected. Not blocked:
  clinical notes, prescriptions and medicines (instructions and reminder
  switches included), doses, appointments, messages, the patient's profile.
- `recovery_log_guard_care_ended` (61's name and trigger) now reads the
  patient's care: no new or changed check-in while discharged, whatever
  plans they have; a patient in care checks in even with no plan, an
  expired plan or only discharged plans.
- `appointment.appointment_follow_up_of_care_event_id`: set by the database
  when a discharged patient books - the discharge event their care is in
  (`app_private.patient_current_discharge_event`). A foreign key on
  `(appointment_follow_up_of_care_event_id, pat_id)` referencing the unique
  `patient_care_event (patient_care_event_id, pat_id)` keeps it on an event
  of the appointment's own patient for every writer. It stays after the
  case is reopened, so each follow-up keeps its own discharge across cycles.
  61's `appointment_follow_up_of_plan_id` keeps its existing marks and is no
  longer set. No session can set or change either mark.
- Unchanged by a discharge: reminders, medicines and appointments (nothing
  is cancelled or ended), every plan's status, the account.

Rollback: `supabase/rollbacks/20260902100063_patient_care_lifecycle.down.sql`
refuses while any patient is discharged or while 64 is applied, and drops
the care history and care follow-up marks (export them first); it restores
61's two functions byte for byte.

### 24. Clinic subscriptions and PayMongo sandbox payments (migration 68)

Four plans, one current subscription per clinic, and the payments that move
a clinic onto a paid plan. **Not applied to production.** Money is integer
centavos (`bigint`) everywhere. Clinic *account* status (`clinic.clinic_status`)
and *subscription* status are separate and never move each other.

| Table | Holds | Key rules |
| --- | --- | --- |
| `subscription_plan` | `free` (0, forever), `basic` (99900, month), `premium` (249900, month), `enterprise` (no list price, custom) | Seeded `on conflict do nothing`, so an agreed price is never overwritten. A CHECK constraint makes Enterprise's price NULL and every other price set. Readable by any signed-in user; writable by no one signed in |
| `clinic_subscription` | A clinic's plan over a period: `active`, `expired` (a paid month ran out) or `replaced` (left early for another plan) | Unique index `clinic_subscription_one_active` (one `active` row per clinic). Enterprise requires `subscription_agreed_price_centavos > 0`, and every other plan forbids it. Basic and Premium require a period end |
| `subscription_payment` | One row per checkout, holding a plan and amount snapshot, `pending`/`paid`/`failed`/`cancelled`, and PayMongo's `cs_`/`pi_`/`pay_` references | Amount > 0, PHP only, never Free. A `paid` row must have `payment_paid_at`, `provider_payment_id` (unique) and `subscription_id`. No card or account details |
| `paymongo_webhook_event` | Each signed event id once, with its type, livemode, processing status and result | Primary key = PayMongo's `evt_` id. No payload. A deny-all policy (a signed-in read returns no row), no write privilege for any API role, nothing for `anon` |

- **Backfill.** Every existing clinic with no active subscription gets an
  active Free subscription starting at `clinic_created_at`. Free costs nothing
  and gates nothing, so no one's access changes. Re-running adds nothing.
- **New clinics.** The trigger `clinic_starts_on_free_plan` (after insert on
  `clinic`) adds the Free subscription in the same transaction.
- **RLS.** A Clinic Admin selects only their own clinic's
  `clinic_subscription` and `subscription_payment` rows
  (`clinic_id = app_private.admin_clinic_id()`). Doctors, patients, other
  clinics' Clinic Admins and visitors read none. No one signed in may insert,
  update or delete any of the four tables.
- **Functions granted only to `service_role`**, which the Edge Functions call
  after verifying the caller or PayMongo's signature:
  `billing_checkout_quote(user, plan)`, `billing_record_checkout(user, plan,
  cs, pi)` (prices again from the table), `billing_apply_paid_checkout(cs,
  pay, amount, currency, paid_at)` (locks the payment row; `duplicate` if
  already paid; `amount_mismatch` unless amount and currency equal the
  snapshot), `billing_mark_unpaid(cs, pi, failed|cancelled)` (never touches a
  paid row), `billing_handle_webhook_event(...)` (claims the event id first,
  refuses live-mode events, and applies the effect in the same transaction),
  and `expire_lapsed_subscriptions()` (pg_cron
  `recoverease-expire-lapsed-subscriptions`, at minutes 7, 22, 37 and 52 of
  every hour).
- **Granted to `authenticated`:** `clinic_admin_choose_free_plan()` (refuses
  anyone but a Clinic Admin, takes the clinic from the database, and refuses
  to move an Enterprise clinic) and `super_admin_subscription_overview()`
  (migration 46's pattern: `SECURITY DEFINER`, empty `search_path`,
  `app_private.require_super_admin()` first, revoked from `public`/`anon`).
- **The overview's figures.** `total_subscribers` = distinct clinics with an
  active subscription; per plan, distinct clinics with that active plan.
  Revenue = the sum of `payment_amount_centavos` over `paid` rows only, split
  by the payment's own `plan_code` snapshot. It reports lifetime, the current
  Asia/Manila calendar month, the last twelve Asia/Manila months (each
  present, oldest first) and by plan. Changing a list price never changes
  past revenue.
- **Enterprise.** No online checkout. An operator sets the agreed price on
  the subscription and records the payment at the amount actually paid.

Rollback: `supabase/rollbacks/20260902100068_clinic_subscriptions.down.sql`.
It **deletes all billing history**, so dump the four tables first. Tested in
`tests/db/clinic-subscriptions.test.ts` (rollback, then re-apply).

## Assumptions where the ERD was silent

The ERD types every status column as `varchar` without listing values. Each
enum below is derived from the module list.

| Type | Values | Derivation |
| --- | --- | --- |
| `user_role` | `patient`, `doctor`, `admin` | The three columns of Table 31. |
| `patient_status` | `active`, `inactive`, `discharged` | Patients are never deleted; module 11.3 establishes deactivate/reactivate as the pattern. |
| `appointment_status` | `scheduled`, `confirmed`, `completed`, `cancelled`, `no_show` | 6.1 creates `scheduled`; 6.6 "Confirm Appointment Attendance" gives `confirmed`. `no_show` is distinct from `cancelled`: neither attended nor called off. |
| `reschedule_request_status` | `pending`, `approved`, `declined` | Module 6.4 names approve and decline. |
| `treatment_plan_status` | `draft`, `active`, `completed`, `cancelled` | `draft` supports authoring before sharing (3.1/3.2). No delete anywhere, so `cancelled` preserves the record. |
| `treatment_goal_status` | `pending`, `in_progress`, `achieved`, `missed` | Module 5.8 shows goals to the patient; a dated goal needs a not-met outcome. |
| `medication_log_status` | `pending`, `taken`, `missed`, `skipped` | 4.6 gives `taken`; 4.8 adherence needs to distinguish a missed dose from a deliberately skipped one. |
| `notification_type` | `appointment`, `medication`, `treatment`, `chat_critical`, `announcement`, `general` | The places notifications actually originate in the module list. |
| `report_type` | `patient_recovery`, `system_wide` | Modules 9.1 and 9.3. |

Other assumptions:

- **`recoveryLogMoodRating` is 1–5.** The ERD types it `int` with no range.
  Module 5.9 is a daily self-report, for which a five-point scale is
  conventional. Enforced by a CHECK.
- **One recovery log per patient per day.** Module 5.9 says "Log Daily
  Recovery Progress" and 5.12 asks for a streak; a streak is only
  well-defined with one entry per day. A unique index enforces it, and the
  client upserts so re-submitting today edits rather than errors.
- **`rescheduleRequestDate` is the *proposed new* date/time**, not the
  submission time. `respondedAt` already covers the response, and nothing
  else could carry the proposal — without this reading the doctor has nothing
  to approve in module 6.4.
- **A patient has exactly one doctor.** `patient.doc_id` is a single FK in the
  ERD, and it is `NOT NULL` here: a patient with no doctor would be invisible
  to every clinician, since RLS scopes doctor access through this column.
- **Medication times are wall-clock times in the clinic's zone**, read from
  the patient's clinic (`clinic.clinic_timezone`, migration 31). A dose set
  for 08:00 must mean 08:00 where the patient lives, not 08:00 UTC.

## Referential integrity

| Pattern | Where | Reason |
| --- | --- | --- |
| `ON DELETE CASCADE` | patient-owned clinical records | Removing a patient removes their record. |
| `ON DELETE RESTRICT` | anything referencing `doctor` | Doctors are deactivated (11.3), never deleted. Deleting one would orphan the plans and prescriptions they authored. |
| `ON DELETE SET NULL` | `audit_log.user_id`, `system_setting.admin_id` | Deleting an account must not erase the record of what it did, or destroy settings. |

## Indexes

Indexes were chosen from the module list's query patterns, not added
reflexively to every column. Notable ones:

- `patient (doc_id)` — the most frequent lookup in the system, evaluated
  inside nearly every doctor-facing RLS policy.
- `notification (user_id, created_at desc) WHERE NOT is_read` — partial,
  covering exactly the notification-bell query that runs on every page load.
- `chat_session (started_at desc) WHERE has_critical_flag` — partial, for the
  doctor's critical-alert triage in module 8.3.
- `medication_log (medication_schedule_id, scheduled_at)` — unique, which is
  what makes dose generation idempotent.
- `reschedule_request (appointment_id) WHERE status = 'pending'` — unique, so
  at most one request per appointment awaits a decision.

A schema test asserts that every foreign key whose parent can be deleted is
indexed, with an explicit exemption list. Five `doc_id`/`admin_id` columns are
exempt with a recorded reason: their parents are never deleted and no module
queries through them, so an index there would be write cost for no read.

## Generated types

`src/types/database.types.ts` is produced by `npm run db:types`, which applies
the committed migrations to an in-process PostgreSQL and introspects the
result. Supabase's own generator needs a live project; this derives the types
from the migrations that actually ship, so they cannot drift.

It emits the `Relationships` arrays `supabase-js` requires. Without them a
table does not satisfy the client's `GenericTable` constraint and **every
query silently degrades to `never`** — queries still run, but all type safety
is gone.

Regenerate after changing any migration:

```bash
npm run db:types
```
