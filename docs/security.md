# Security model

The rule this system is built around:

> **The route guard decides what is rendered. The database decides what is
> readable.**

Hiding a navigation link changes what a user sees. It does not change what
they can fetch. Every access rule in RecoverEase is therefore a Row Level
Security policy, and the React guards exist so people see coherent screens —
not so data stays private.

## Where authorization lives

| Layer | Responsibility | Is it a security boundary? |
| --- | --- | --- |
| Navigation config | Show a role its own sections | **No** |
| Route guards | Send users to a page that will work | **No** |
| API functions | Shape queries | **No** |
| **RLS policies** | Decide every row read and written | **Yes** |
| **Guard triggers** | Column-level rules RLS cannot express | **Yes** |
| **Edge Functions** | Operations needing the service role | **Yes** |

A patient who types `/admin/audit` is redirected — and if they bypassed the
redirect entirely, `select * from audit_log` still returns zero rows.

## Roles come from the database

Authorization reads the role from `public.user_account`.

It is **never** read from `auth.jwt()` metadata. In Supabase,
`raw_user_meta_data` is writable by the user it belongs to and surfaces in the
JWT, so a role taken from there could simply be set to `admin` by the patient
it describes. `user_account` has no self-update policy, which is what makes it
trustworthy for this.

## The `app_private` schema

RLS policies need to answer "is the caller a doctor, and is this patient
assigned to them?". Asking that directly inside a policy on `patient` would
recurse: evaluating the policy requires reading the table the policy protects.

The resolution is `SECURITY DEFINER` helper functions, which run with the
definer's privileges and bypass RLS for the lookup. That is a sharp tool, so
each one is constrained:

- They live in **`app_private`**, which is not exposed through the Data API —
  none of them is reachable as a REST endpoint.
- `EXECUTE` is **revoked from `PUBLIC`** and granted only to `authenticated`.
  PostgreSQL grants `EXECUTE` to `PUBLIC` by default on every new function,
  which would otherwise make each of these callable by `anon`.
- `search_path` is pinned to empty and every reference is schema-qualified, so
  a caller cannot shadow `public` and redirect a lookup.
- Each is keyed on `auth.uid()`. **None accepts a caller-supplied identity**,
  so none can be asked about someone else's permissions.
- All are `STABLE`, so PostgreSQL evaluates them once per statement rather
  than once per row.

The core predicate is `is_my_patient(pat_id)`, which additionally requires
`doc_is_active`. That is what makes module 11.3 real: deactivating a doctor
revokes their access to every patient record at the database, not merely their
ability to sign in.

## Policy conventions

Applied to every policy, each guarding a specific failure:

- **`TO authenticated` on every policy.** `auth.role() = 'authenticated'` is
  deprecated and silently passes anonymous sign-ins.
- **`TO authenticated` is never used alone.** Role alone is authentication,
  not authorization. Every policy also carries an ownership predicate;
  without one it is a broken-object-level-authorization hole.
- **Every `UPDATE` policy defines both `USING` and `WITH CHECK`.** `USING`
  alone lets a user rewrite a row's owning key and hand the row to someone
  else.
- **Helper calls wrapped as `(select fn())`**, so PostgreSQL evaluates them
  once per statement instead of once per row.
- **No policy means denied.** `audit_log` has no `INSERT`, `UPDATE` or
  `DELETE` policy for any role, and that is the point.

## Access matrix

| Table | Patient | Doctor (assigned) | Admin |
| --- | --- | --- | --- |
| `patient` | own row (r/w, guarded) | r/w | **none** |
| `doctor` | own clinician (r) | own row (r/w, guarded) | r/w |
| `admin` | none | none | own row (r/w) |
| `treatment_plan` / `treatment_goal` | r | r/w | none |
| `prescription` / `medication_schedule` | r | r/w | none |
| `medication_log` | r + **update status** | **r only** | none |
| `recovery_log` | r/w | r | none |
| `doctor_note` | **none** | r/w | none |
| `appointment` | r, insert, confirm/cancel | r/w | none |
| `reschedule_request` | r, insert | r + **decide** | none |
| `chat_session` / `chat_message` | own (r/w) | r | **none** |
| `notification` | own (r + mark read) | own + send to own patient | own |
| `announcement` | published only | published only | full |
| `report` | **none** | own | own + system-wide |
| `audit_log` | none | none | **read only** |
| `system_setting` | none | none | r/w |

Four rows in that table are worth calling out.

### Administrators cannot read patient data

The module list gives admin no patient-management module. Module 10.1 is
"View Doctor/Patient Count **Overview**" — a count, not a list. So there is no
admin policy on `patient`, and the dashboard's numbers come from
`admin_dashboard_stats()`, a `SECURITY DEFINER` function that returns
aggregates and never rows.

Module 8.6 is "Monitor Chatbot Usage **Logs**" — usage statistics, not
transcripts. `admin_chatbot_usage()` returns counts and timings, with no
transcript, no summary and no patient identifier.

### Doctors cannot edit adherence

Module 4.6 gives "Mark Medication as Taken" to the patient. Module 5.3 gives
the doctor "Track Medication Adherence" — a read. That asymmetry is
deliberate: an adherence record the treating clinician can edit is not
evidence of anything. `medication_log` has no doctor `UPDATE` policy.

The timestamp is also stamped by a trigger from the server clock rather than
sent by the client, so a device with a wrong clock cannot corrupt the record.

### Patients cannot read doctor notes

Modules 5.4 and 5.5 are both clinician-only, and no patient module mentions
notes. `doctor_note` has no patient `SELECT` policy at all — a patient
querying it receives zero rows, not a filtered view.

### The audit log is append-only for everyone

Rows are written by `SECURITY DEFINER` triggers, so no session can forge an
entry, and no session — administrators included — can alter or erase one.

## Column-level guards

RLS decides which *rows* a caller may touch; it cannot express "this role may
edit these *columns* but not those". Several columns RLS lets a user write are
the columns that decide their own privileges, so triggers close that gap:

| Guard | Prevents |
| --- | --- |
| `patient_guard_protected_columns` | A patient reassigning themselves to another doctor, or resetting their own status after discharge. `user_id` is immutable for everyone — re-pointing it would transfer an entire medical history to a different login. |
| `doctor_guard_protected_columns` | A deactivated doctor reactivating themselves, or changing their own licence number. |
| `appointment_guard_patient_transitions` | A patient marking their own appointment `completed` (a clinical assertion), or moving its time instead of using the reschedule flow. |
| `medication_log_guard_slot` | Anyone moving when a dose was due, which would make the adherence history meaningless. |

Each is covered by a test in `tests/db/rls.test.ts` that asserts both the
refusal **and** that the legitimate edit still works — a guard that blocks
everything would pass a one-sided test.

## PHI must not leak through the audit trail

This is the subtlest rule in the system.

Administrators **can** read `audit_log`. Administrators **cannot** read
patient records. If the audit trigger wrote row values into the details
column, an administrator could read protected health information straight out
of the audit trail — defeating the access model through the very mechanism
meant to police it.

So `audit_row_change()` takes a disclosure mode:

- `values` — record what changed and to what. Used for administrative
  entities (doctor accounts, announcements, system settings) whose contents an
  administrator may legitimately see.
- `keys_only` — record only **which columns changed**, never their contents.
  Used for anything touching a patient.

An administrator can still see that a clinician edited a record and when,
which is what an audit trail is for, without being handed the clinical data.

`tests/db/rls.test.ts` asserts that no patient name, prescription note or
plan title appears anywhere in audit details.

## Secrets

| Secret | Lives in | Never in |
| --- | --- | --- |
| Publishable (anon) key | `VITE_SUPABASE_PUBLISHABLE_KEY` | — it is public by design; RLS is what protects the data |
| Service-role key | Supabase Edge Function secrets | Any `VITE_`-prefixed variable, any client file, the repo |
| Chatbot provider key | Edge Function secrets | Same |

Anything prefixed `VITE_` is compiled into the browser bundle. `src/lib/env.ts`
declares only the two publishable values, so a service key cannot be read from
client code even by accident.

`.gitignore` blocks all `.env*` files with an explicit exception for
`.env.example`, verified with `git check-ignore` before the first commit.

## Client hardening

`vercel.json` sets a Content-Security-Policy limiting `connect-src` to the
app's own origin and Supabase, `frame-ancestors 'none'`, `object-src 'none'`,
plus `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` and
HSTS.

Sign-in does not distinguish an unknown email from a wrong password: a message
that separates them lets an attacker enumerate which patients and clinicians
are registered.

## Known limitations

Recorded honestly rather than left for someone to discover:

1. **RLS is verified against PGlite, not the deployed project.** The same
   migration files are replayed into a real PostgreSQL, so the policies
   themselves are genuinely exercised — but the deployed instance has not been
   tested, because no Supabase project has been provisioned yet. Run
   `get_advisors` after the first deploy.
2. **Rate limiting relies on Supabase defaults.** No additional throttling is
   applied to the Edge Functions.
3. **`report_file_path` is never populated.** Documents are produced through
   the browser's print pipeline; writing a rendered file to Supabase Storage
   is the documented extension point, deliberately not faked with a URL that
   would 404.
4. **Automated medication reminders need a scheduler.** The database functions
   exist and are tested; wiring them to `pg_cron` is described in
   [`deployment.md`](./deployment.md) and has not been done.
