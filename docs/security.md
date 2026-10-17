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
it describes.

What makes `user_account` trustworthy for this is that **no browser session
can write it at all** (migration 27). Accounts are created by `create-account`
with the service role, and a role is fixed when the account is created:

- There is no INSERT, UPDATE or DELETE policy on `user_account`, and `anon` and
  `authenticated` hold no INSERT, UPDATE, DELETE or TRUNCATE privilege on it.
  Until migration 27 an administrator could UPDATE any account's
  `user_role` — one Data API request made a patient or a doctor an
  administrator.
- `user_account_guard_writes` refuses every write from those two roles
  whatever the policies say, so a policy or grant added later cannot quietly
  reopen it, and refuses a change of `user_id` from anyone.
- Doctor profiles are created only by `create-account`; there is no INSERT
  policy or privilege on `doctor` for a browser session.

The guard tells a browser write from a server write by `current_user`, which
is the role PostgreSQL actually executes as, not anything the caller sends:

| Path | `current_user` | Guard |
| --- | --- | --- |
| Data API request, signed out | `anon` | refused |
| Data API request, signed in (any role in the app) | `authenticated` | refused |
| Edge Function with the service key (`create-account`) | `service_role` | allowed |
| A `SECURITY DEFINER` function, a migration, the SQL editor | the owner, `postgres` | allowed |

PostgREST picks the role from the signed JWT's `role` claim, which only the
service key can set to `service_role`; `anon` and `authenticated` are members
of no other role, so a session cannot switch to a trusted one. The one way a
session's request runs as a trusted role is through a `SECURITY DEFINER`
function, which only a migration can install — so any such function that
writes `user_account` must check its caller itself. There is none today, and
`tests/db/account-integrity.test.ts` fails if one a session can call appears.

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

### The one `SECURITY DEFINER` function in `public`

`app_private` holds every authorization helper. One function sits outside it,
deliberately: `public.app_today()`, which returns the current date in the
caller's clinic's time zone (migration 31).

It has to be in `public` and callable by `authenticated`, because column
`DEFAULT` expressions are evaluated with the privileges of the *inserting*
role, not the table owner — a default that called into `app_private` would
fail for every real user.

It is `SECURITY DEFINER` so that it reads the caller's clinic and that
clinic's zone whoever calls it. With no member asking - a cron job, the
service key, a migration - it answers only while there is a single clinic,
and refuses rather than guess once there are more.

What keeps that acceptable:

- It takes **no arguments**, so there is nothing to point it at: the clinic
  is always the caller's own.
- It returns **a date**, never table data. The only thing it discloses is what
  day it is in the caller's own clinic.
- `EXECUTE` is revoked from `PUBLIC` and `anon`; it is not reachable
  unauthenticated. A test asserts this.
- `search_path` is pinned to empty, like every helper in `app_private`.

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

| Table | Patient | Doctor (assigned) | Clinic Admin (own clinic only) |
| --- | --- | --- | --- |
| `user_account` | own row (r) | own + own patients (r) | r — **no session writes it** |
| `patient` | own row (r/w, guarded) | r/w | **none** |
| `doctor` | own clinician (r) | own row (r/w, guarded) | r + update (no insert) |
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
| `announcement` | published, own clinic's | published, own clinic's | full |
| `report` | **none** | own | own + system-wide |
| `audit_log` | none | none | **read only** (administration and clinical entries) |
| `system_setting` | none | none | r/w, own clinic's (migration 31) |

Every Clinic Admin cell is limited to the administrator's own clinic (see
"Clinics" below).

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

## Clinics

Every account belongs to a clinic (migrations 28 to 30): doctors and Clinic
Admins directly, through `doctor.clinic_id` and `admin.clinic_id`, and
patients through their doctor. The existing clinic is Harborview Recovery
Clinic.

- **A Clinic Admin works within their own clinic.** Each administration
  policy compares the row's clinic with `app_private.admin_clinic_id()`,
  which is the caller's clinic only when the caller is a Clinic Admin, and
  empty for anyone else. That covers accounts (emails included, decision D5),
  doctors, announcements, system-wide reports and the audit log, and the
  dashboard and chatbot usage counts. Another clinic's rows read as empty and
  writes to them fail.
- **The clinic never comes from the request.** A new doctor joins the
  registering administrator's clinic (`create-account`). An announcement takes
  its author's clinic and a report its patient's, or its author's, from
  triggers, whatever the request says. A Clinic Admin resets only their own
  clinic's doctors (`reset-account-password`), and another clinic's doctor is
  answered exactly as one that does not exist.
- **A profile's clinic is fixed** for every writer, the service role
  included, and a patient can only move to an active doctor in the same
  clinic.
- **Moving a deactivated doctor's patients (decision D8)** is one audited
  database function, for that clinic's Clinic Admin only. It shows counts
  and never a name, moves only each patient's doctor, keeps the author of
  every plan, prescription and note, and moves nothing if a count has
  changed since it was shown. From migration 31 (option A) their upcoming
  scheduled and confirmed appointments move with them, to the same times;
  past and closed ones stay with the doctor they were with. Nothing moves if
  any would clash with another booking. The patient and the new doctor are
  notified, reminders already sent are not repeated, and each moved
  appointment gets a clinical audit entry naming only the changed field.
- **Settings and the time zone are the clinic's** from migration 31
  (decision D3). A Clinic Admin reads and writes only their own clinic's; the
  clinic comes from who is writing, never from the request, and cannot be
  changed afterwards. The time zone is set with `admin_set_clinic_timezone`,
  audited as an administration entry. The chatbot uses the patient's clinic's
  prompt, and the built-in guidance - never another clinic's - when it cannot
  be read. A single-clinic gate still refuses a second clinic until the
  clinic-creation migration.
- **An announcement keeps its author and clinic** (migration 31): neither can
  be changed by anyone, the service key included.

**Deployment fails closed.** `create-account` and `reset-account-password`
read the caller's clinic before creating or changing anything. Deployed
before migration 29, that read fails and the request is refused with nothing
created; registering and resetting patients does not need it and works
either way.

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
| `user_account_guard_writes` | Any browser session writing an account — a role, a sign-in address, a login — even if a later policy allowed it; and anyone re-pointing an account at a different login. |
| `profile_matches_account_role` | A doctor or patient profile being created for an account of a different role — a doctor profile on a patient's account, a patient profile on an administrator's. Applies to the service role too. |
| `patient_guard_reassignment` | A patient being reassigned to a deactivated doctor, or to a doctor row whose account is not a doctor's, where no active clinician could see them. |

Each is covered by a test in `tests/db/rls.test.ts` or
`tests/db/account-integrity.test.ts` that asserts both the refusal **and**
that the legitimate edit still works — a guard that blocks everything would
pass a one-sided test.

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

### Every entry has a scope and a clinic

From migration 30 every audit entry carries `audit_scope` (`platform`,
`administration` or `clinical`) and the clinic it is about. A trigger works
the scope out from the entry's entity as the entry is written; no writer
chooses it, and anything unrecognised is `clinical`, the most restricted.
Only clinic entries are `platform`. A clinic's settings, including its time
zone (`clinic_settings`, migration 31), are `administration`. Patients,
prescriptions, treatment plans, appointments and patients' accounts are
`clinical`.

A Clinic Admin reads their own clinic's administration and clinical entries,
which is what an administrator saw before, within one clinic. Platform
entries are for the Super Admin (migration 33), who will read nothing else.
An account's entry is written a moment before its profile and cannot know
its clinic yet; the Clinic Admin policy resolves it as it is read.

## The recovery guidance assistant

The AI provider is **Google Gemini** (Interactions API). There is no Anthropic
dependency anywhere in RecoverEase, and no provider SDK is installed: the Edge
Function calls the REST endpoint with `fetch`, which keeps the function's
module graph small and removes a class of cold-start failure.

**The browser never calls Gemini.** Three separate things force that, and only
the first is about the key:

- the credential must not ship in a client bundle;
- module 8.7 lets an administrator set the system prompt, and a prompt the
  client supplies is a prompt the client can replace — including the safety
  half of it;
- module 8.2 requires critical-concern detection to raise a doctor alert, and
  a check performed in the patient's browser is a check that browser can skip.

### Order of operations

`chatbot-reply` authenticates the caller, proves the conversation belongs to
them, and only then builds the provider request. Constructing it earlier would
mean a failed authorisation had already assembled someone else's transcript.

The configuration check sits *after* authorisation rather than at the top of
the handler, so an unconfigured deployment still answers "this conversation is
not yours" to a caller reaching for another patient's session. Authorisation
should not depend on whether a provider key happens to be set.

### Data minimisation

`toInteractionInput()` is the boundary, and it is a function rather than a
convention so it can be tested. It reads exactly two fields off each message
row — the role and the text — and discards everything else. Gemini therefore
receives the text of one conversation and nothing else: no name, patient id,
date of birth, contact details, diagnosis, medication schedule, appointments,
other conversations, other patients, and nothing from the audit trail.

Because it copies fields out rather than deleting fields off, adding a column
to `chat_message` later cannot silently widen what leaves the system. A test
asserts on the serialised payload that no identifier survives.

### Only the newest 40 messages are replayed

The model is given the newest 40 messages of the conversation
(`HISTORY_LIMIT` in `supabase/functions/_shared/assistant.ts`), not the whole
of it. `chatbot-reply` reads them newest first, ordered by
`chat_message_created_at` and then by `chat_message_id`, both descending, so
two messages with the same timestamp always fall in the same order and the
window is the same every time. `chronologicalWindow()` then puts them back in
the order they were written before `toInteractionInput()` builds the request.

Reading newest first is what makes the limit keep the end of a conversation.
Read oldest first, a conversation longer than 40 messages was cut off at its
fortieth message and the patient's latest question never reached the model.
Older messages are not deleted or hidden: they stay in the transcript the
patient and their doctor see, and are only not replayed to the model. A reply
is requested only when the last of those messages is the patient's.

Covered by `tests/unit/chat-history-window.test.ts` and
`tests/db/chat-history-window.test.ts`.

### Nothing unvalidated reaches a patient

Structured output is requested via `response_format`, and the reply is then
validated with Zod against the same contract regardless:

```
{ message: string, safety_level: "normal" | "caution" | "urgent",
  should_contact_provider: boolean }
```

Asking a model to conform is not the same as it conforming. Output that does
not parse, or parses but fails the schema, is refused with a 502 and the UI
says the assistant is unavailable. Nothing partially-valid is repaired and
shown — a half-understood reply about post-treatment symptoms is the failure
this layer exists to prevent.

The response reader only ever takes text from the model's own output steps.
Echoing the request back as though it were an answer would be a fabricated
reply that reads convincingly, so it is excluded explicitly and tested.

### Failure never leaks

On timeout, network error, non-2xx, rate limit or malformed output, the
provider's response body is logged and never forwarded to the client: error
bodies can carry request detail and, on some providers, the key itself. The
patient's own message is persisted before the provider is called and survives
every failure path.

## Secrets

| Secret | Lives in | Never in |
| --- | --- | --- |
| Publishable (anon) key | `VITE_SUPABASE_PUBLISHABLE_KEY` | — it is public by design; RLS is what protects the data |
| Service-role key | Supabase Edge Function secrets | Any `VITE_`-prefixed variable, any client file, the repo |
| `GEMINI_API_KEY` | Edge Function secrets | Same |

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

### The gap this claim had, and how it was found

The paragraphs above were true for `patient`, `prescription` and
`treatment_plan`, and a test asserted it for exactly those three. It was not
true everywhere.

`audit_row_change` takes a disclosure mode. Four tables were classified as
administrative and given `values`: `doctor`, `announcement`, `system_setting`
and `user_account`. The first three hold no patient rows. **`user_account`
holds one for every patient**, so its audit entries recorded:

```json
{"record": {"user_id": "...", "user_role": "patient",
            "user_email": "patient@example.com", ...}}
```

An administrator has `SELECT` on `audit_log`. The audit screen never rendered
that payload — its "Fields changed" column showed a dash — but an
administrator could read every patient's email address directly from
`/rest/v1/audit_log`. The interface hiding it is not a boundary; that is the
premise this entire model is built on, and here the model caught the interface
out rather than the other way round.

It also contradicted the codebase's own intent. `create-account` writes its
audit entry with the comment *"Deliberately no name, email or clinical detail:
administrators can read audit_log and must not learn patient identities from
it."* The Edge Function honoured that. The trigger on the same table did not.

An email address is not a diagnosis. But it identifies a person, and "this
identified person is a patient of this clinic" is health information.

**Fixed in migration 15** with a fourth trigger argument naming columns whose
values are never recorded. `user_account` keeps `values` disclosure — the role
and account id are what make the entry useful for reviewing provisioning — and
loses only the identifier. Verified live by creating a throwaway account and
reading back what the trigger wrote.

The test that missed this was scoped to a list of three tables. Its
replacement reads the **entire** audit trail as an administrator and asserts no
email address and no personal name appears anywhere, so a future table added
with the wrong disclosure mode fails without anyone remembering to extend a
whitelist. It was confirmed to fail against the pre-fix trigger.

**One-time remediation.** Three rows written before the fix carried fixture
addresses. Audit history is append-only for every role, administrators
included, and these were rewritten as the table owner to drop the email key.
That is the only time audit history has been altered, and it is recorded here
rather than done quietly. Zero rows in the live audit trail now match an email
pattern.

## Leaked-password protection is a paid feature

Supabase Auth can reject passwords that appear in the Have I Been Pwned
corpus, and the security advisor flags the project while it is off. It is
switched on under **Authentication → Sign In / Providers → Email → Prevent use
of leaked passwords**.

On this project that toggle cannot be saved:

```
Failed to update auth configuration: Configuring leaked password protection
via HaveIBeenPwned.org is available on Pro Plans and up.
```

So the advisor warning is **not** an oversight and cannot be cleared without
upgrading the plan. Recorded here rather than left looking like something
nobody got round to.

What partly covers the same ground in the meantime, and is available on the
current plan, on the same settings page:

- **Minimum password length** — currently 6, the Supabase floor. Raising it to
  10 or 12 costs nothing and removes the largest share of guessable
  passwords.
- **Password requirements** — currently unset; requiring mixed character
  classes is also free.

Neither is a substitute for a breach-corpus check, which is the only control
that catches a long, complex password that has already leaked elsewhere.

## Known limitations

Recorded honestly rather than left for someone to discover:

1. **Verified live, with the advisors reviewed.** The policies are exercised
   both against PGlite and against the deployed project. On the live database
   an administrator was confirmed to read **zero rows** from all eight clinical
   tables while `admin_dashboard_stats()` still returned the correct counts; a
   patient reads zero doctor notes; a deactivated doctor reads zero rows
   everywhere; and eight separate escalation attempts were refused while the
   legitimate edit still succeeded. The Supabase advisors were run and their
   findings either fixed (trigger functions exposed as RPC endpoints, migration
   11; two permissive INSERT policies on `report` merged, migration 12) or
   recorded with a reason — never silenced by weakening a policy.
2. **Rate limiting relies on Supabase defaults.** No additional throttling is
   applied to the Edge Functions.
3. **`report_file_path` is never populated.** Documents are produced through
   the browser's print pipeline; writing a rendered file to Supabase Storage
   is the documented extension point, deliberately not faked with a URL that
   would 404.
4. **Reminder delivery is in-app only.** Medication reminders are dispatched
   on a pg_cron schedule and written to the `notification` table, which is
   what the ERD models. Email and push delivery are not implemented.
