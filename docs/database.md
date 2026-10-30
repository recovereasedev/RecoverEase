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

Module 5.7, enhanced (migration 45). Not applied to production yet. A
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
before they lock it, so nobody else's call takes the lock.

A goal joins only a phase of its own plan - a composite foreign key
(`treatment_goal_phase_in_plan`, `ON DELETE SET NULL (recovery_phase_id)`,
PostgreSQL 15 and later; production runs 17.6) - and only a current one.

**Roadmap progress** = (activities marked done + goals in a phase marked
achieved) / (activities + goals in a phase), per plan, as a whole percent;
with nothing to count there is none ("No activities yet"). Doses,
appointments and check-ins are never counted
(`src/features/recovery-roadmap/roadmap.ts`).

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
