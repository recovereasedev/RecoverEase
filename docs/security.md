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
| `notification` | own (r + mark read) | own + **send a general message, up to 1,000 characters, to own patient** (migration 41), **dated by the database, not by the doctor** (migration 44) | own |
| `announcement` | published: platform, own clinic's Clinic Admin's, **own active doctor's** (migration 36) | published platform and Clinic Admin's; **writes for own patients, reads and manages only own** (migration 36) | full |
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
  be read. A single-clinic gate refused a second clinic until every reader
  was clinic-aware; migration 34 lifts it, and only a Super Admin creates
  clinics (below).
- **An announcement keeps its author and clinic** (migration 31): neither can
  be changed by anyone, the service key included.
- **A doctor writes announcements for their own patients** (migration 36).
  Once published, one reaches only the patients assigned to that doctor now
  (`app_private.current_assigned_doctor_id()`), so the audience follows
  reassignment, and only while the doctor is active: a deactivated doctor's
  leave their patients' feeds at once, before the patients are moved. Not
  the doctor's colleagues, not another doctor's patients, no one in another
  clinic. They write only as themselves and only while active
  (`app_private.current_doctor_id()` is empty for a deactivated doctor); the
  clinic is their own, set by the database from the author. They read their
  own, drafts included, and publish, withdraw, edit and delete only their
  own - never a Clinic Admin's, a colleague's, another clinic's or a
  platform one. Their Clinic Admin keeps the access they had to every
  announcement of the clinic, theirs included, and cannot hand one to
  another author. Platform announcements stay the Super Admin's: a doctor's
  matches none of the Super Admin's functions, and a platform one matches
  none of a doctor's policies. `tests/db/doctor-announcements.test.ts` holds
  each of these.

**Deployment fails closed.** `create-account` and `reset-account-password`
read the caller's clinic before creating or changing anything. Deployed
before migration 29, that read fails and the request is refused with nothing
created; registering and resetting patients does not need it and works
either way.

## The Super Admin

The Super Admin runs the platform - clinics, their Clinic Admins, platform
announcements and the platform's audit trail - and never patient care
(migrations 32 and 33).

**The role is given by one procedure, run by the database owner.**
`super_admin` (migration 32) is written to an account only by
`app_private.provision_super_admin`, which no API role can call: not `anon`,
not `authenticated`, not `service_role`. The account guard refuses the role
to every other writer, the service role and a direct owner write included,
and never changes a Super Admin's role afterwards. It is never given to an
existing account, so a patient's, doctor's or Clinic Admin's access never
comes with it. `app_private.revoke_super_admin` removes one, also owner-only.

**Every operation checks the caller again, in the database.** Each Super
Admin function is `SECURITY DEFINER` with an empty `search_path`, refused to
`anon`, and starts with `app_private.require_super_admin()`. It accepts a
caller only when all of these hold, read from Supabase Auth's own tables -
the token's claims alone are never enough:

| Requirement | Evidence |
| --- | --- |
| A `super_admin` account with its profile | `user_account.user_role`, `super_admin` |
| A sign-in that exists, is not deleted and is not banned | `auth.users` |
| The token's session is live and is the caller's | `auth.sessions`: the token's `session_id`, same `user_id`, before `not_after`; a signed-out session's row is gone |
| `aal2`, in the token and in the session | the `aal` claim and `auth.sessions.aal` |
| Raised with an authenticator app, in this session | a `totp` row in `auth.mfa_amr_claims` for the session |
| Using the caller's own verified TOTP factor | `auth.sessions.factor_id` names a `verified` `totp` factor whose `user_id` is the caller |

So calling the functions directly, without the website, gains nothing; nor
does a user id, role or clinic in the request, another user's session or
factor, an `aal1` token for a session raised since, or a stale one. A
Clinic Admin, doctor or patient is refused even with `aal2` and a verified
factor of their own. `public.super_admin_assured()` tells the console
whether to ask for an authenticator code, about the caller only.

**What a Super Admin reaches** - nothing but these functions:

- clinics: list (name, status, time zone, timestamps, Clinic Admin count),
  create (a validated, bounded name; a time zone PostgreSQL knows; the
  clinic's own default settings and nothing of another clinic's, in one
  transaction) and set status. `active` and `inactive` are the only states
  and each moves only to the other. An inactive clinic takes no new Clinic
  Admin; its people and records are untouched. No clinic is ever deleted.
- Clinic Admins: provisioned with `create-account` (below).
- platform announcements: write, edit, publish, withdraw and delete. A
  published one reaches every signed-in user, which is what migration 30's
  policy already said of an announcement with no clinic; a draft reaches no
  one through the table. A Clinic Admin cannot touch one, and no
  announcement's author or clinic can change.
- the platform audit trail: `platform` entries only - clinics, Super Admins,
  Clinic Admin provisioning and platform announcements - paged newest first.
  The filter is in the function, not the caller's request, and the table
  itself shows a Super Admin nothing. Of an entry's details it returns only
  the names of the fields an update changed - strings naming a real column -
  never a stored value: no created row, no before or after, nothing a
  function recorded (migration 35). The database drops them, not the page;
  `tests/db/platform-audit-field-names.test.ts` plants values in every part
  of an entry's details and finds none in what comes back.

A Super Admin has no admin, doctor or patient profile, so every existing
policy gives them nothing: `tests/db/super-admin.test.ts` counts every table
as a verified Super Admin and finds only their own account and profile and
published platform announcements. Every Clinic Admin function refuses them.

**The console, and its authenticator step.** A Super Admin signs in on the
same sign-in page as everyone else and lands on `/platform`: clinics and
their Clinic Admins, platform announcements and the platform audit log - the
functions above and nothing else. No clinic route renders for them, and no
clinic role reaches `/platform`. Before any console screen renders, the
navigation included, `SuperAdminAssuranceGate` asks for the authenticator:

| The session | The console shows |
| --- | --- |
| No verified TOTP factor | Setting one up: a QR code, the same secret as a setup key to type, then its first code |
| A verified TOTP factor, session `aal1` | A code, every sign-in |
| `aal2`, and `super_admin_assured()` is true | The console |
| `aal2`, but `super_admin_assured()` is false | Nothing: sign out and sign in again |
| Any of it unreadable | Nothing: an error, and sign out |

This is presentation; the database is the boundary. The gate never trusts
the token's `aal` alone - it asks `super_admin_assured()`, which reads the
same Supabase Auth tables as every Super Admin function - and its answer is
neither cached between sessions nor kept once the gate is gone. Each code is
checked with a fresh challenge. The only factors the website ever removes
are the person's own unfinished enrolments, which cannot be used to sign in,
so an abandoned QR code cannot be completed later. It never removes a
verified factor, and it offers no way to skip, defer or replace the code.

**A lost authenticator** is replaced by the platform owner, never through the
website:

1. Confirm who is asking by a channel that is not the account itself - in
   person, or a call to a number already on record. Email to the account's
   address proves nothing: whoever has the account may have the mailbox.
2. Remove the factor with Supabase Auth's admin API -
   `auth.admin.mfa.deleteFactor({ id, userId })` with the service key, run
   by the owner from their own machine, never from the website or an Edge
   Function. Removing it ends Super Admin access at once for every session
   it raised: the database's check joins the session to its factor, and
   finds none. (Supabase Auth itself only lowers the token's `aal` at the
   next refresh.)
3. The next time they sign in, the console asks them to set up a new
   authenticator.

Record that it was done, and why, outside RecoverEase: it is a change to
Supabase Auth, not a platform entry, so the platform audit log does not
show it.

**Adding a Clinic Admin hands over no password.** A Super Admin calls
`create-account` with `kind: 'clinic_admin'`, an email, names and the
clinic. The role is always Clinic Admin: the request has no field for it,
and `kind: 'super_admin'` is refused.

1. As the Super Admin, with their own token, the database checks their
   verified session and that the clinic exists and is active
   (`super_admin_check_clinic_for_admin`) - before any login exists.
2. The login is created with the service key: confirmed, with a 256-bit
   password nobody is told, and marked in `app_metadata` (which only the
   service key writes) as made for that clinic's administrator.
3. As the Super Admin again, `super_admin_attach_clinic_admin` makes the
   account and the Clinic Admin profile in one transaction, but only for a
   login marked for that clinic and with no account yet, and audits it as a
   platform entry with no name or email. If it refuses, `create-account`
   deletes the login.
4. Supabase Auth's own password-recovery email goes to the address, back to
   the website's `/reset-password`; the new Clinic Admin sets their own
   password there. If it cannot be sent the account still exists, the
   response says so, and "Forgot password" sends it again.

The response is the new ids and whether the email went: never a password,
link or token.

**The first Super Admin** is a deliberate, approved act, not an endpoint:

1. Create the person's sign-in in Supabase Auth (Authentication → Users),
   with an address that has no RecoverEase account, and with no password
   anyone else knows - an invitation does this. Confirm with a read-only
   query that it is the only sign-in with that address and has no
   `user_account` row: sign-up is open, so an address can already have one.
2. As the database owner, in the SQL editor:
   `select app_private.provision_super_admin('<auth user id>', '<first name>', '<last name>');`
3. They choose their own password with "Forgot password" on the website,
   sign in, and set up an authenticator app at `/platform` (Supabase Auth
   MFA, TOTP). Until they have, and in every session until they enter a
   code, the console shows nothing and every Super Admin operation refuses
   them. Nobody else ever holds their password or their authenticator.

TOTP MFA must be enabled for the project in Supabase Auth; it is on by
default, and checking it changes nothing.

**What the tests can and cannot show.** PGlite has no GoTrue, so the tests
build `auth.sessions`, `auth.mfa_factors` and `auth.mfa_amr_claims` with the
names, types and enum labels read from production, and write their rows the
way GoTrue does when a code is verified. That GoTrue really records
`sessions.factor_id` and the `totp` claim is its documented behaviour, not
something these tests can run; the first real enrolment should confirm it
with a read-only query before the Super Admin relies on it. If it did not,
the check would refuse - it fails closed.

## Column-level guards

RLS decides which *rows* a caller may touch; it cannot express "this role may
edit these *columns* but not those". Several columns RLS lets a user write are
the columns that decide their own privileges, so triggers close that gap:

| Guard | Prevents |
| --- | --- |
| `patient_guard_protected_columns` | A patient reassigning themselves to another doctor, or resetting their own status after discharge. `user_id` is immutable for everyone — re-pointing it would transfer an entire medical history to a different login. |
| `doctor_guard_protected_columns` | A deactivated doctor reactivating themselves, or changing their own licence number. |
| `doctor_guard_reminder_preference` | Anyone but the doctor - their clinic's administrator included - turning a doctor's appointment reminders off or on (migration 42). |
| `appointment_guard_patient_transitions` | A patient marking their own appointment `completed` (a clinical assertion), or moving its time instead of using the reschedule flow. |
| `medication_log_guard_slot` | Anyone moving when a dose was due, which would make the adherence history meaningless. |
| `user_account_guard_writes` | Any browser session writing an account — a role, a sign-in address, a login — even if a later policy allowed it; and anyone re-pointing an account at a different login. |
| `profile_matches_account_role` | A doctor or patient profile being created for an account of a different role — a doctor profile on a patient's account, a patient profile on an administrator's. Applies to the service role too. |
| `patient_guard_reassignment` | A patient being reassigned to a deactivated doctor, or to a doctor row whose account is not a doctor's, where no active clinician could see them. |
| `notification_assign_created_at` | A doctor dating a message to their patient in the past or the future through a direct Data API call, which would move it in the patient's newest-first list and misstate when it was sent. Every new notification is given the start of the inserting transaction, whatever the insert named - exactly what the column default gives, so the system's writers, none of which names a time, write what they always did. Insert only; no stored notification is changed (migration 44, `tests/db/notification-created-at.test.ts`). |

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
Clinics, Super Admins and their accounts, Clinic Admin provisioning and
platform announcements are `platform` (migration 33). A clinic's settings,
including its time zone (`clinic_settings`, migration 31), are
`administration`. Patients, prescriptions, treatment plans, appointments and
patients' accounts are `clinical`.

A Clinic Admin reads their own clinic's administration and clinical entries,
which is what an administrator saw before, within one clinic. Platform
entries are for the Super Admin, who reads nothing else
(`super_admin_list_audit`).
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

### The assistant can be switched off

The adviser's "AI Chatbot On/Off" is enforced by the server, not by hiding a
button (migration 38). Right after proving the conversation the caller's, and
before reading any of it or calling Gemini, `chatbot-reply` asks
`guidance_assistant_on_for_doctor()` - the platform's switch and the patient's
clinic's both on. Only an explicit yes goes ahead. An explicit no is refused
with `disabled`; an answer it cannot read is refused as `unavailable`, so a
switch meant to stop the assistant fails closed. No review is requested for
a refusal of this kind: the clinic or the platform chose to have no
assistant, rather than the assistant failing. The patient's history is
untouched and their care team still sees it.

Who may change each switch is the database's decision: the platform's only
an assured Super Admin, through its own functions, audited as a platform
entry; a clinic's only that clinic's Clinic Admin, through the settings
policies every clinic setting has. A Super Admin gains no access to any
clinic's data through it. What a patient's screen learns -
`guidance_assistant_available()` - is one boolean about their own clinic.

What the switch does not stop: a patient can still write a message into
their own conversation through the Data API while it is off - or from a page
that loaded before it went off. Nothing answers it, and no review is
requested for it, so the patient's page says it won't be answered and tells
them to contact their care team, rather than suggesting anyone will follow it
up. Their care team can read it in the conversation, as any message.

The security advisor's `authenticated_security_definer_function_executable`
count rises by three with this migration -
`guidance_assistant_available`, `super_admin_get_guidance_assistant` and
`super_admin_set_guidance_assistant` - each meant to be called by a signed-in
user and each deciding inside what that user may know or do.
`guidance_assistant_on_for_doctor` is granted to `service_role` only. The
advisor also reports, at INFO level, `rls_enabled_no_policy` for
`app_private.platform_setting`: intended, since the table is reached only
through those functions, with no policy and no grant.

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

On timeout, network error, non-2xx, rate limit or malformed output, nothing
the provider sent is forwarded to the client. Of a non-2xx body only the
machine-readable parts are logged: the status, Google's error code and status
name, `ErrorInfo` reasons and the request field paths a `BadRequest` names
(`providerErrorSummary` in `supabase/functions/_shared/reply-outcome.ts`) -
never its message or descriptions, since error bodies can quote the request,
which is the patient's conversation, and on some providers carry the key
itself. A successful response whose body stops arriving within the time
limit is reported as a timeout, like one whose headers never came; an error
response is reported by its status even if its body never finishes, and then
nothing of the body is logged. The patient's own message is persisted before
the provider is called and survives every failure path.

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
3. **`report_file_path` is never populated, and no document is stored.**
   The prescription, the treatment plan and the system-wide report download
   as files built in the browser - PDF with pdf-lib, the report also as an
   Excel workbook - from data the signed-in user's own access already
   returned, and are handed straight to the browser's download
   (`src/lib/documents/`). Nothing is uploaded, so a downloaded document can
   hold nothing its reader could not already see. Printing, through the
   browser's own pipeline, stays beside each download. Writing a rendered
   file to Supabase Storage remains the documented extension point,
   deliberately not faked with a URL that would 404. So the Reports page's
   **Recently generated reports** says that an earlier report's contents
   are not stored, offers nothing to download from it, and names who
   generated each one only from what RLS already returns: the reader's own
   reports by their name, a colleague's by the account's email address (a
   Clinic Admin reads their clinic's accounts, not other administrators'
   profiles), or "Not available" (`tests/db/report-creators.test.ts`).
4. **Reminder delivery is in-app only.** Medication reminders are dispatched
   on a pg_cron schedule and written to the `notification` table, which is
   what the ERD models. Email and push delivery are not implemented. While
   RecoverEase is open, the plan's 10-minute reminder card
   (`src/features/reminders/`) also shows a dose the server has just reminded
   the patient of, and an appointment about to start; it is a surface for
   those reminders, not a way to deliver them when the app is closed.
5. **A notification's addressee may update every column of it, not only
   its read state.** `notification_update_own` (migration 06) limits *which*
   rows - the signed-in user's own - and keeps `user_id`, but not *which
   columns*. The website only marks notifications read, yet a direct Data
   API call could re-date, reword or retype a notification addressed to the
   caller, or change its chat link. What changes is only the caller's own
   inbox: no other user reads those rows, and a chat link still opens only a
   conversation the reader's own access allows. Migration 44 dates a
   notification when it is written and does not touch updates. The fix is
   its own migration: revoke `update` on `notification` from `authenticated`
   and grant `update (notification_is_read)` back, so marking read is all a
   session can do.
