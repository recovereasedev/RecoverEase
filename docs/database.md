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
  the `app.timezone` system setting. A dose set for 08:00 must mean 08:00
  where the patient lives, not 08:00 UTC.

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
