# Deployment

> **Status: deployed, smoke-tested and origin-migrated. Two items outstanding.**
>
> | | |
> | --- | --- |
> | Production URL | <https://recoverease-web.vercel.app> |
> | Supabase project ref | `kwsezszstdagzllbyjuk` (ap-southeast-1) |
> | Vercel project | `recovereasedev-7251s-projects/recoverease` |
> | Repository | `recovereasedev/RecoverEase` |
>
> 14 migrations applied, 20 tables, RLS on every one, 54 policies, 3 pg_cron
> jobs all confirmed to have actually executed, both Edge Functions ACTIVE at
> v3 with `verify_jwt`.
>
> Two older hostnames on the same Vercel project still resolve, and both are
> on the Edge Function CORS allow-list so nothing bookmarked breaks:
>
> | Hostname | Behaviour |
> | --- | --- |
> | `recovereasedev.vercel.app` | 307 → the canonical host |
> | `recoverease-zeta.vercel.app` | serves the same deployment directly |
>
> **The recovery guidance assistant is live.** `GEMINI_API_KEY` is set and a
> real Gemini request was verified end to end through the production UI:
> patient message → authenticated Edge Function → Google Gemini → structured
> output → Zod validation → database → rendered reply.
>
> Leaked-password protection cannot be enabled on the current Supabase plan;
> see `docs/security.md`.

## Prerequisites

| Tool | Needed for |
| --- | --- |
| Node 20+ | Build and tests |
| Supabase account | Database, Auth, Edge Functions |
| Supabase CLI | Applying migrations, deploying functions |
| Vercel account | Hosting the frontend |

The Supabase CLI is not required for local development or for the test suite —
the RLS tests run against PGlite in-process. It is required to deploy.

## 1. Create the Supabase project

Create a project in the Supabase dashboard, then note from
**Project Settings → API**:

- Project URL — `https://<ref>.supabase.co`
- Publishable (anon) key — safe for the browser
- Service-role key — **never** goes near the frontend

## 2. Apply the migrations

```bash
supabase link --project-ref <ref>
supabase db push
```

Migrations are applied in filename order and are the single source of truth
for the schema. Never edit a schema by hand in the dashboard: the next
`db push` will not know about it, and `docs/database.md` will be wrong.

Immediately afterwards, check the advisors:

```bash
supabase db advisors      # or the MCP get_advisors tool
```

Expect a clean security report. A table without RLS or a `SECURITY DEFINER`
function in an exposed schema is a finding to fix, not to note.

## 3. Create the first administrator

There is no bootstrap path in the application — no module grants anyone the
ability to create an administrator, so the first one is provisioned out of
band. In the SQL editor:

```sql
-- After creating the auth user in Authentication → Users
insert into public.user_account (user_id, user_email, user_role)
values ('<auth user id>', '<email lowercased>', 'admin');

insert into public.admin (user_id, admin_first_name, admin_last_name, clinic_id)
values ('<auth user id>', 'First', 'Last', (select clinic_id from public.clinic));
```

`user_email` must be lower case — a CHECK constraint enforces it. A Clinic
Admin must belong to a clinic (migration 29 creates the first one), so the
`clinic_id` is required.

From there the flow is entirely in-app: the administrator registers doctors,
and each doctor registers their own patients.

## 4. Seed the system settings

Optional. Settings belong to the clinic (migration 31), and the clinic's time
zone is the clinic's own: migration 29 creates the first clinic in
`Asia/Manila`. Without a grace period setting, the missed-dose job uses six
hours.

```sql
insert into public.system_setting (clinic_id, system_setting_key, system_setting_value)
values ((select clinic_id from public.clinic), 'medication.reminder_grace_hours', '6')
on conflict (clinic_id, system_setting_key) do nothing;
```

The time zone, the grace period and the chatbot guidance are all editable
from **Admin → System settings** (modules 14.1 and 8.7), each for the
administrator's own clinic.

## 5. Deploy the Edge Functions

```bash
supabase functions deploy create-account
supabase functions deploy chatbot-reply

supabase secrets set ALLOWED_ORIGINS="https://<your-app>.vercel.app"
supabase secrets set GEMINI_API_KEY="..."
```

`chatbot-reply` imports `zod` by its bare name, so it needs an import map.
Unless one is passed with `--import-map` or set in `config.toml`,
`supabase functions deploy` reads it from the function's own folder —
`supabase/functions/chatbot-reply/deno.json` — and never from
`supabase/functions/deno.json`; without the function's own copy the bundle
fails with `Relative import path "zod" not prefixed with /, ./, or ../`. The
root copy stays for editors and other local Deno tooling. The two must map
the same versions, and `tests/unit/edge-function-import-maps.test.ts` fails if
they drift or if any function imports a bare name its own `deno.json` does not
map.

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are
injected by the platform — do not set them yourself.

`ALLOWED_ORIGINS` matters. These functions hold the service-role key and
create accounts; defaulting CORS to `*` would let any site on the internet put
a request to them in front of a signed-in user's browser. Localhost origins
are always permitted and are not reachable from outside the developer's
machine.

If `GEMINI_API_KEY` is unset, `chatbot-reply` returns 503 and the UI says
the assistant is unavailable. Every other module works. That is a supported
configuration, not a broken one.

**`ALLOWED_ORIGINS` is no longer required for production.** The canonical
origins are checked into `supabase/functions/_shared/cors.ts` as
`PRODUCTION_ORIGINS`, because they are public URLs rather than secrets, and a
deployment that silently fails CORS until somebody remembers an environment
variable is a worse default than a hostname in source. `ALLOWED_ORIGINS` still
*extends* that list for staging or a future custom domain.

The original failure was worth recording: with an empty list the old code fell
back to `allowList[0]` — a localhost origin — so a production browser was
answered with `Access-Control-Allow-Origin: http://localhost:5173` and blocked
the response before the function's own clean 503 could be read. An origin that
is not on the list now receives **no** `Access-Control-Allow-Origin` header at
all, which is the honest form of a refusal. Verified live:

```
recoverease-web.vercel.app  -> Access-Control-Allow-Origin: recoverease-web.vercel.app
recovereasedev.vercel.app   -> Access-Control-Allow-Origin: recovereasedev.vercel.app
recoverease-zeta.vercel.app -> Access-Control-Allow-Origin: recoverease-zeta.vercel.app
evil.example.com            -> no header (refused)
```

**`GEMINI_API_KEY` is required and is not set.** It is the only AI provider
secret RecoverEase uses, and it must be added in exactly one place:

> **Supabase Dashboard → project `kwsezszstdagzllbyjuk` → Project Settings →
> Edge Functions → Secrets → Add new secret**
>
> Name: `GEMINI_API_KEY`
>
> <https://supabase.com/dashboard/project/kwsezszstdagzllbyjuk/settings/functions>

Get the key from Google AI Studio. It must never appear in React code, a
`VITE_` variable, the repository, a client request, browser storage, or these
docs. `VITE_`-prefixed variables are compiled into the browser bundle, so a
key placed there is public.

Until it is set, `chatbot-reply` returns 503 after authenticating and
authorising the caller, and the UI says the assistant is unavailable. Every
other module works. That is a supported configuration, not a broken one.

## 6. Deploy the frontend

```bash
vercel link
vercel env add VITE_SUPABASE_URL production
vercel env add VITE_SUPABASE_PUBLISHABLE_KEY production
vercel --prod
```

Add the same two variables to the Preview environment if preview deployments
are used.

`vercel.json` already configures:

- **SPA fallback** — any path that is not a real file serves `index.html`, so
  a deep link like `/doctor/patients/<id>` loads instead of 404ing. Vercel
  checks the filesystem before applying rewrites, so built assets are still
  served directly.
- **Content-Security-Policy** — `connect-src` limited to the app's own origin
  and Supabase, `frame-ancestors 'none'`, `object-src 'none'`.
  `style-src` includes `'unsafe-inline'` because React sets inline `style`
  attributes for the progress bars.
- **Immutable caching** for `/assets/*`, which are content-hashed.
- `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, HSTS.

## 7. Point Supabase Auth at the deployment

**Authentication → URL Configuration**:

- Site URL: `https://<your-app>.vercel.app`
- Redirect URLs: add `https://<your-app>.vercel.app/reset-password`

Without the redirect URL, password reset links will not return to the app.

## Clinic migrations (Phase A)

For a project that already has data, migrations 29 and 30 change who sees
what, so they go in a fixed order. Each is applied on its own with the
Supabase connector's `apply_migration` - never `db push` or history repair on
this project - and checked read-only before the next step:

1. **Apply migration 29** (`initial_clinic`). It creates the clinic, puts
   every doctor and Clinic Admin in it, and stops with nothing applied on any
   inconsistency.
2. **Deploy `create-account` and `reset-account-password`.** Deployed before
   step 1 they refuse to register or reset a doctor, with nothing created;
   patient registration and resets work either way.
3. **Apply migration 30** (`clinic_admin_scope`). It refuses to run before 29.
4. The website can be merged at any point. Its only new screen, "Reassign
   patients", needs migration 30, appears only for a deactivated doctor, and
   until then says the count could not be loaded.

Stopping after any step leaves the system working, and the single-clinic gate
holds throughout. Tested down-scripts are in `supabase/rollbacks/`: 30's
first, then 29's. A rollback is applied as a new migration, never by deleting
history.

Migration 31 (`clinic_settings`, per-clinic settings and time zone) goes in
after 30, in this order:

1. **Apply migration 31.** It refuses to run before 30, or if the
   `app.timezone` setting and the clinic's zone differ, and changes no
   setting's value. The website and `chatbot-reply` already deployed keep
   working: the settings screen still saves by key and edits the time zone
   through the `app.timezone` alias, and the chatbot still finds the one
   prompt there is.
2. **Deploy `chatbot-reply`.** It looks up the patient's clinic's prompt,
   which reads `system_setting.clinic_id`; deployed before step 1 it would
   use the built-in guidance for everyone.
3. **Merge the website.** Vercel deploys `main` on merge, so this comes
   after step 1: the new settings screen saves by clinic and key and sets the
   time zone through `admin_set_clinic_timezone`, both of which 31 adds.

`create-account`, `reset-account-password` and `complete-password-setup` read
no setting and need no redeploy. Stopping after any step leaves the system
working, and the single-clinic gate stays in place: it is lifted only by
migration 34, separately approved, after every reader of a setting is
verified clinic-aware.

### The Super Admin (migrations 32 to 34)

Each step is its own approval, in this order:

1. **Apply migration 32, then 33, straight after.** 32 only adds the
   `super_admin` role; 33 adds everything that uses it, and the guard that
   refuses the role to every writer but the owner-only procedure. Between the
   two, the service role could still write the value; 33 refuses to run if
   anything did. Nothing anyone sees changes: no account has the role.
2. **Deploy `create-account`.** It adds Clinic Admin provisioning for a
   Super Admin. Deployed before 33, that request is refused before any login
   is created; registering doctors and patients is unchanged either way.
3. **Apply migration 34**, which lifts the single-clinic gate and drops the
   key-only settings index. Only once `chatbot-reply` v15 and a website that
   saves settings by clinic and key (PR #40) are live. It creates no clinic.
4. **Merge the console (PR 5).** Vercel deploys `main` on merge. It can go
   before or after the steps above: until 33 no account can be a Super Admin,
   so nothing reaches `/platform`, and the console asks the database before
   it shows anything. It changes no clinic screen.
5. **Make the first Super Admin**, with the owner-only procedure in
   `docs/security.md`, once the person is chosen and steps 1, 2 and 4 are
   live. First confirm, read-only, that TOTP enrolment and verification are
   enabled in the project's Supabase Auth settings (Multi-Factor); they are
   on by default. Then confirm, read-only, that their first code was recorded as
   the database's check expects - `auth.sessions.factor_id` set and a `totp`
   row in `auth.mfa_amr_claims` for that session - before relying on it.

Rollback goes the other way: 36's and 35's down-scripts first, where they
are applied (below), then `supabase/rollbacks/20260902100034_lift_single_clinic_gate.down.sql`
(refused once a second clinic exists - clinics are never deleted), then
`…100033_super_admin_platform.down.sql` (refused while a Super Admin or a
platform announcement exists). Migration 32's enum value stays, unused:
PostgreSQL cannot drop one. `tests/db/super-admin-rollback.test.ts` proves
both return the schema to exactly what 32 left, with every row kept.

### The platform audit trail's field names (migration 35)

Migration 35 changes one function, `super_admin_list_audit`, so that the
Super Admin's audit read returns only the names of the fields an update
changed and never a stored value. It needs migration 33, and refuses to run
without it; it needs nothing else.

1. **Apply migration 35** on its own, with approval, before or after 34. The
   two touch nothing in common: `tests/db/platform-audit-field-names.test.ts`
   applies 35 and then 34, as production will have them, and ends with the
   same schema as the repository's order. Production records each migration
   under the time it was applied, not its file number, so 35 can be there
   before 34. The single-clinic gate stays until 34 is separately approved.
2. **Nothing else.** The function keeps its arguments and columns and the
   console already shows only field names, so the website deployed now works
   before and after, and no Edge Function changes. No audit entry is
   rewritten.

Its down-script, `supabase/rollbacks/20260902100035_platform_audit_field_names.down.sql`,
restores migration 33's function - values included - and goes before 34's
and 33's.

### Doctors' announcements (migration 36)

Migration 36 lets a doctor write announcements for their own patients. It
needs migration 33 and refuses to run without it; it is independent of 34
and 35 (`tests/db/doctor-announcements.test.ts` applies it after 33 and 35
with 34 unapplied, as production has them). It adds `announcement.doc_id`
and `app_private.current_assigned_doctor_id()`, widens the one-author and
clinic rules to a doctor, and replaces the announcement policies with ones
that keep every Clinic Admin condition and add the doctor's and the
patient's. A Clinic Admin's and a platform announcement reach exactly whom
they reached before, and no row changes. The website deployed before it
keeps working once it is applied: that website sends no `doc_id`.

**The website from PR #47 depends on migration 36 for reading, not only for
writing.** Every announcement list - the patient's, the doctor's and the
Clinic Admin's - reads each announcement with its doctor author
(`doctor ( doc_first_name, doc_last_name )`, through `announcement.doc_id`).
Without migration 36 that relationship does not exist, so the request fails
with HTTP 400 and the page shows its error instead of any announcement. A
doctor's new announcement, sent with `doc_id`, is refused as well.

This happened on 2026-10-18. PR #47 was merged at 20:09Z and deployed before
migration 36 was applied, and the patient Announcements page failed - three
HTTP 400 responses, observed in production - until 36 was applied at
20:23Z. The doctor's and the Clinic Admin's pages make the same request and
were expected to fail the same way; they were not checked live.

The release order, each step its own approval:

1. **Review the change** - the PR and its migration.
2. **Approve migration 36**, separately.
3. **Apply and verify migration 36 in production** - its history entry, the
   schema and the policies - before anything is merged.
4. **Only then approve merging the website PR.** Vercel deploys `main` on
   merge, so approving the merge is approving the deployment.
5. **Verify the production deployment** - the announcement pages load, with
   no HTTP 400.

Migration 34 is not part of this. It stays separate and optional, and 36
leaves the single-clinic gate in place.

Its down-script, `supabase/rollbacks/20260902100036_doctor_announcements.down.sql`,
returns the table and its policies to what 33 left and drops the helper 36
added. It refuses while any doctor's announcement exists, and goes before
35's, 34's and 33's. Rolling 36 back under the website from PR #47 would
break the announcement lists in the same way, so the website goes back
first.

To roll back 31, go the other way, newest first. Each later migration is
rolled back with its own down-script, applied as a new migration, and where
deployed code depends on it, that code goes back first:

1. **39**: `supabase/rollbacks/20260902100039_platform_setting_audit_field_names.down.sql`.
   No code goes back: the website and the Edge Functions work with either
   version.
2. **38**: `chatbot-reply` and the website from before migration 38, then
   `supabase/rollbacks/20260902100038_guidance_assistant_switch.down.sql`.
   33's down-script refuses while 38 is installed.
3. **37**: the website from before PR #49, then
   `supabase/rollbacks/20260902100037_medication_pre_dose_reminders.down.sql`.
4. **36**: the website from before PR #47, then
   `supabase/rollbacks/20260902100036_doctor_announcements.down.sql`, which
   refuses while any doctor's announcement exists.
5. **35**: `supabase/rollbacks/20260902100035_platform_audit_field_names.down.sql`.
   No code goes back: the website and the Edge Functions work with either
   version.
6. **34**, where it is applied:
   `supabase/rollbacks/20260902100034_lift_single_clinic_gate.down.sql`,
   which refuses once a second clinic exists. No code goes back.
7. **33**: `supabase/rollbacks/20260902100033_super_admin_platform.down.sql`,
   which refuses while 34 is applied or a Super Admin or platform announcement
   exists. No code goes back: with no Super Admin nothing reaches the
   console, and `create-account` refuses Clinic Admin provisioning before any
   login is created.
8. **31**: the website from before 31, then `chatbot-reply` from before 31
   (it reads `system_setting.clinic_id`), then
   `supabase/rollbacks/20260902100031_clinic_settings.down.sql`. It refuses
   while there is more than one clinic - two clinics' settings cannot be
   folded into one - and writes the clinic's zone back into the global
   `app.timezone` row so nothing that reads it moves.

31's down-script also refuses, naming each one to roll back, while 37, 36 or
33 is still installed: 37's reminder job reads `system_setting.clinic_id`,
which 31's rollback removes; 36's doctors' announcements keep their author
through `announcement_guard_author`, which it drops; and 33's
`super_admin_create_clinic` writes `system_setting.clinic_id`, while 33's
audit functions and author guard would be rewritten or dropped. What that
check cannot do:

- **It reads only the database's schema markers.** It cannot tell which
  website or `chatbot-reply` version is deployed, so the code steps above
  are the operator's to do and verify.
- **It has no marker for 34.** 34 is covered through 33: 34 refuses to run
  without 33, and 33's down-script refuses while 34 is applied, so 34 cannot
  be installed once 33 is gone.
- **It has no marker for 38 either.** 38 is covered through 33 the same way:
  38 refuses to run without 33, and 33's down-script refuses while 38 is
  installed.
- **Its refusal leaves everything as it was only if execution stops at the
  error.** The check runs first and changes nothing itself; whether the
  statements after it run is up to the runner. The runner documented for
  this project, the Supabase connector's `apply_migration`, sends the script
  to Supabase's Management API in one request, and neither documents whether
  that request runs as one transaction or stops at the first error. After a
  refusal, confirm read-only that `system_setting.clinic_id` is still there
  and that no new migration was recorded. No other runner is documented
  here. With `psql`, the script must run as
  `psql -v ON_ERROR_STOP=1 --single-transaction -f <file>`: without
  `ON_ERROR_STOP`, psql reports the refusal and goes on to run the statements
  after it, and `--single-transaction` undoes the whole script if a later
  statement fails.

## Scheduled jobs

Migration `…100009_scheduled_jobs.sql` registers three pg_cron jobs,
`…100018_appointment_reminders.sql` a fourth and
`…100037_medication_pre_dose_reminders.sql` a fifth. Each block is guarded on
`pg_cron` being available, so it is a no-op where the extension is absent
(including the PGlite test harness) rather than aborting the migration.

| Job | Cadence | Purpose |
| --- | --- | --- |
| `recoverease-extend-medication-slots` | `0 1 * * *` | Extends dose slots for every live schedule |
| `recoverease-medication-pre-dose-reminders` | `* * * * *` | Reminds patients of a dose before it is due, by the clinic's lead time (plan section 5; migration 37) |
| `recoverease-medication-reminders` | `*/15 * * * *` | Chases doses that came due unrecorded (modules 4.2, 4.7) |
| `recoverease-mark-overdue-doses` | `5 * * * *` | Writes off doses past the grace period |
| `recoverease-appointment-reminders` | `0 * * * *` | Reminds patient and doctor of an appointment 24 hours ahead (migration 18) |

`cron.schedule(name, …)` replaces a job of the same name, so re-running the
migration does not accumulate duplicates.

Confirm after deploying:

```sql
select jobname, schedule, active from cron.job
 where jobname like 'recoverease-%';
```

**If pg_cron is unavailable** the migrations log a notice and skip. Call the
same functions from any external scheduler, at the same cadences, using the
service role — they are the entire contract, and each is idempotent:

```sql
select public.extend_all_medication_log_slots(30);
select public.dispatch_medication_pre_dose_reminders();
select public.dispatch_medication_reminders(30);
select public.mark_overdue_medication_logs(6);
select public.dispatch_appointment_reminders(24);
```

The 6 is a fallback, not the grace period itself. `mark_overdue_medication_logs`
uses the **Missed dose grace period** setting (`medication.reminder_grace_hours`)
whenever it holds a whole number of hours from 1 to 24, and its argument only
when the setting is missing or unusable. Change the grace period from
**Admin → System settings**, not in the job.

The reminder before a dose takes no argument: its lead time is each clinic's
**Medication reminder lead time** setting (`medication.reminder_lead_minutes`)
when that is 5, 10, 15 or 30 minutes, and ten minutes otherwise. Change it from
**Admin → System settings**.

Reminders are delivered as in-app notifications, which is what the ERD's
`notification` table models. Email or push delivery would be a further step
and is not implemented.

### The reminder before each dose (migration 37)

**Applied on 2026-10-19 at 14:25:02Z** (`medication_pre_dose_reminders`,
history version `20261019142502`). The points below are the results the
operator's report gave for that day. They are historical evidence, not a
fresh check of the current production state: check that read-only before
relying on it.

- **The application.** Applied once, inside the agreed window
  (14:18-14:27Z), after a fresh read-only preflight passed, with the reviewed
  SQL: MD5 `8426de1d15eb6bf9b7e4f498dea37097`, 11,575 bytes.
- **History.** One entry, `20261019142502 medication_pre_dose_reminders`:
  one statement whose MD5 and length equal the reviewed file's.
- **Schema and privileges.** The column and the enabled guard trigger on
  `medication_log`. No `PUBLIC`, `anon` or `authenticated` EXECUTE on either
  function; `service_role` can execute the dispatcher, which is
  `SECURITY DEFINER` with an empty `search_path`.
- **Job.** `recoverease-medication-pre-dose-reminders`: `* * * * *`, active,
  owned by `postgres`, running the dispatcher.
- **Runs.** The first two, at 14:26Z and 14:27Z, succeeded. By 14:45Z the
  job had run 20 times, all successfully, and none of the five jobs had a
  failed run since the application.
- **Security advisor.** The same findings as the baseline recorded before
  applying, none naming either new function.

No lead time had been set, so the ten-minute default applied.

**Smoke test, 2026-10-19** (same report; a production write the owner
approved). On the demonstration doctor and patient accounts (see
"Demonstration accounts"), the doctor added a clearly fictional test
medicine, "Reminder test tablet", for that day only, with one dose at 22:50
Asia/Manila (14:50Z):

- At about 22:40 Manila (14:40:00Z), ten minutes before the dose, the job
  stamped it and created one in-app notification: "Your Reminder test tablet
  (1 tablet) is due at 22:50."
- The patient's Notifications page showed it after a reload.
- Three further runs, at 22:41, 22:42 and 22:43 Manila, created no second
  reminder for that dose.
- The test dose was then marked taken, and that notification marked read.
- The test schedule, its dose and the notification remain in production.
  They were not deleted.

This covers the in-app notification on that one test account, which is the
only delivery there is (see "Scheduled jobs"). It says nothing about any
other patient.

**Historical snapshot: before applying, as of 2026-10-19** (main `5c5119c`;
read-only production check at about 10:43Z). Recorded before migration 37
was applied and kept as the record of that check; it is not the current
production state:

- The website half, PR #49, was merged and deployed: Admin → System settings
  offers the **Medication reminder lead time**. It works against the schema
  without migration 37 - the setting is saved like any other, and nothing
  reads it.
- PR #50's rollback guard was merged and deployed too. It makes migration 31's
  rollback refuse while migration 37 is installed.
- The read-only check observed migration 37 absent - no history entry and
  none of its objects - with migration 36, version `20261018202321`
  (`doctor_announcements`), as the newest history entry.

At that point migration 37 was a separate database operation that had **not
been approved**. Until it was applied no reminder was sent before a dose (the
follow-up after an unrecorded dose was unaffected), and a lead time a Clinic
Admin saved in the meantime would take effect the moment 37 was applied.

The procedure below is the one followed on 2026-10-19. It does not authorize
applying 37 anywhere: any further application - to another project, or again
after a rollback - needs its own approval. Immediately before it, rerun the
read-only preflight below, and review any migration-history entry or schema
state that differs from what the preflight expects before going on.

Pre-dose reminders respect the patient's preferred contact time, as decided
by the owner: a reminder whose send time falls before the patient's preferred
time of day is not sent (`tests/db/medication-pre-dose-reminders.test.ts`, the
preferred-time case).

#### Before applying - read-only

1. **The file is the reviewed one.** In a checkout of `main`:

   ```bash
   md5sum supabase/migrations/20260902100037_medication_pre_dose_reminders.sql
   wc -c supabase/migrations/20260902100037_medication_pre_dose_reminders.sql
   ```

   The reviewed artifact is MD5 `8426de1d15eb6bf9b7e4f498dea37097`,
   11,575 bytes. Check the file itself before relying on these values: if it
   no longer matches, it changed after review - stop. A match confirms this is
   the file artifact that was reviewed; it does not replace reviewing what the
   migration contains. The text passed to `apply_migration` must have the same
   checksum and length.
2. **History.** On 2026-10-19, `list_migrations` ended with
   `20261018202321 doctor_announcements` (migration 36), and no entry was named
   `medication_pre_dose_reminders`. Check it again now: if any entry is newer,
   review what it changed before going on; if one is named
   `medication_pre_dose_reminders`, 37 is already applied - stop.
3. **Schema.** 37 is absent, and what it needs is present:

   ```sql
   select
     (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'medication_log'
         and column_name = 'medication_log_pre_dose_sent_at')                    as pre_dose_column,   -- 0
     to_regprocedure('public.dispatch_medication_pre_dose_reminders()') is not null as dispatcher,      -- false
     to_regprocedure('public.medication_log_guard_pre_dose_mark()') is not null     as guard_function,  -- false
     (select count(*) from pg_trigger
       where tgrelid = 'public.medication_log'::regclass
         and tgname = 'medication_log_guard_pre_dose_mark')                      as guard_trigger,     -- 0
     (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'system_setting'
         and column_name = 'clinic_id')                                          as setting_clinic_id; -- 1
   ```

4. **Scheduler.** pg_cron is installed; the four existing jobs are active,
   owned by `postgres`, running successfully on their own cadences and not
   failing; and there is no pre-dose job yet. `cron.job` and
   `cron.job_run_details` show each database user only their own jobs, so run
   these as their owner, `postgres` (as the connector's SQL does):

   ```sql
   select extversion from pg_extension where extname = 'pg_cron';  -- one row

   select j.jobname, j.schedule, j.active, j.username,
          count(*) filter (where d.status = 'succeeded')          as succeeded_24h,
          max(d.start_time) filter (where d.status = 'succeeded') as last_succeeded,
          count(*) filter (where d.status = 'failed')             as failed_24h
     from cron.job j
     left join cron.job_run_details d
       on d.jobid = j.jobid and d.start_time > now() - interval '24 hours'
    where j.jobname like 'recoverease-%'
    group by 1, 2, 3, 4
    order by 1;
   ```

   Expect four rows, none named `recoverease-medication-pre-dose-reminders`,
   each active, owned by `postgres`, with `failed_24h` 0, and successful runs
   that match its own cadence - not one number for all of them:

   | Job | Cadence | `succeeded_24h` | `last_succeeded` |
   | --- | --- | --- | --- |
   | `recoverease-appointment-reminders` | `0 * * * *` | about 24 | within the last hour |
   | `recoverease-extend-medication-slots` | `0 1 * * *` | 1 | the most recent 01:00 UTC |
   | `recoverease-mark-overdue-doses` | `5 * * * *` | about 24 | within the last hour |
   | `recoverease-medication-reminders` | `*/15 * * * *` | about 96 | within the last 15 minutes |

   A run at the edge of the 24-hour window can add or drop one. On 2026-10-19
   the read-only check observed 24, 1, 24 and 96 runs, all succeeded.

5. **Security advisor.** Record its findings (`get_advisors`, security). The
   baseline observed on 2026-10-19 was 19
   `authenticated_security_definer_function_executable` warnings, all on
   functions meant to be called by signed-in users, and
   `auth_leaked_password_protection`.
6. **Window.** An agreed window. 37 is applied before its job exists, so the
   current practice still holds: away from the existing jobs' runs at :00,
   :05, :15, :30, :45 and 01:00 UTC, with two minutes either side - the
   windows :08-:12, :18-:27, :33-:42 and :48-:57 UTC - starting at the
   beginning of one.

#### After applying - read-only

1. **History.** One entry for the migration. Its version is the time it was
   applied, not `20260902100037`:

   ```sql
   select version, name, cardinality(statements) as statements,
          md5(array_to_string(statements, '')) as md5,
          octet_length(array_to_string(statements, '')) as bytes
     from supabase_migrations.schema_migrations
    where name = 'medication_pre_dose_reminders';
   -- one row; with the script stored as one statement, md5 and bytes equal
   -- the reviewed file's - anything else means a different text was applied
   ```

2. **Schema and privileges.** The column, the guard trigger and both
   functions exist; nobody but `service_role` can execute the dispatcher,
   and nobody calls the trigger function directly. `PUBLIC` is a
   pseudo-role rather than a real role, so its grant is read straight from
   each function's ACL: grantee `0` is `PUBLIC`, and a function whose ACL is
   empty (`proacl` null) has the default one, in which `PUBLIC` may
   execute - hence `acldefault('f', proowner)`:

   ```sql
   select
     (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'medication_log'
         and column_name = 'medication_log_pre_dose_sent_at')                  as pre_dose_column,          -- 1
     (select count(*) from pg_trigger
       where tgrelid = 'public.medication_log'::regclass
         and tgname = 'medication_log_guard_pre_dose_mark'
         and tgenabled <> 'D')                                                 as guard_trigger,            -- 1
     (select count(*)
        from pg_proc p,
             aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       where p.oid = 'public.dispatch_medication_pre_dose_reminders()'::regprocedure
         and a.grantee = 0 and a.privilege_type = 'EXECUTE')                  as dispatcher_public_grants, -- 0
     has_function_privilege('anon',          'public.dispatch_medication_pre_dose_reminders()', 'execute') as dispatcher_anon,          -- false
     has_function_privilege('authenticated', 'public.dispatch_medication_pre_dose_reminders()', 'execute') as dispatcher_authenticated, -- false
     has_function_privilege('service_role',  'public.dispatch_medication_pre_dose_reminders()', 'execute') as dispatcher_service_role,  -- true
     (select count(*)
        from pg_proc p,
             aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       where p.oid = 'public.medication_log_guard_pre_dose_mark()'::regprocedure
         and a.grantee = 0 and a.privilege_type = 'EXECUTE')                  as guard_public_grants,      -- 0
     has_function_privilege('anon',          'public.medication_log_guard_pre_dose_mark()', 'execute')     as guard_anon,               -- false
     has_function_privilege('authenticated', 'public.medication_log_guard_pre_dose_mark()', 'execute')     as guard_authenticated,      -- false
     (select prosecdef || ' ' || array_to_string(proconfig, ',') from pg_proc
       where oid = 'public.dispatch_medication_pre_dose_reminders()'::regprocedure) as dispatcher_definer; -- true search_path=""
   ```

3. **Job.** Scheduled every minute, active, owned by `postgres`. pg_cron
   keeps the command exactly as written between the migration's `$job$`
   markers, with a space either side - as the four existing jobs' commands
   are - so compare it trimmed, as here, or go by the job's name, cadence,
   active state and owner. Surrounding whitespace is not a mismatch:

   ```sql
   select jobname, schedule, active, username, btrim(command) as command
     from cron.job
    where jobname = 'recoverease-medication-pre-dose-reminders';
   -- one row: * * * * *, true, postgres,
   -- select public.dispatch_medication_pre_dose_reminders()
   ```

4. **Runs.** At least two minutes after applying, at least two successful
   runs since then and no failed one - and the scheduler query above still
   shows the other four jobs active with no failures:

   ```sql
   select d.status, count(*) as runs, min(d.start_time) as first, max(d.start_time) as last
     from cron.job_run_details d
     join cron.job j on j.jobid = d.jobid
    where j.jobname = 'recoverease-medication-pre-dose-reminders'
      and d.start_time > timestamptz '<the time 37 was applied>'
    group by d.status;
   -- 'succeeded' with runs >= 2, and no 'failed' row
   ```

5. **Security advisor.** The same findings as the baseline recorded before
   applying, and none naming `dispatch_medication_pre_dose_reminders` or
   `medication_log_guard_pre_dose_mark`.

These checks show the migration is installed, locked down, scheduled and
running without errors. They do not show a reminder reaching a patient: that
needs a test dose on a `@smoke.invalid` account, a production write with its
own approval.

**If applying fails, or only part of it seems to have run, stop.** Gather
read-only evidence - the error, whether a history entry exists, and which of
the column, trigger, functions, grants and job are present - and report it.
Do not retry, re-apply, repair the migration history or roll back without a
separate decision. `apply_migration`'s transaction behaviour is not
documented (see "To roll back 31" above), so a failure may leave part of the
script applied.

#### Migration timing and run history

- **How migrations are timed now that the job runs every minute: accepted by
  the owner on 2026-10-19.** There is no minute without a scheduled run. Keep
  routine maintenance windows chosen around the heavier jobs (as above), and
  start future migrations that take locks on tables the jobs use with a
  3-second `lock_timeout`, so a migration that cannot get its lock fails
  quickly rather than holding the website up behind it. Pause the pre-dose
  job (`cron.alter_job`) only for a change to its own logic or schema, or a
  long operation on `medication_log`, and confirm it is active again
  afterwards. This is the operator's convention for applicable migrations
  from here on; nothing in the repository enforces it. Migration 37 itself
  was applied exactly as reviewed, without a `lock_timeout`, and its file,
  checksum and length are unchanged.
- **How long `cron.job_run_details` keeps run history: deferred by the
  owner.** pg_cron never removes it. The four existing jobs add about 145
  rows a day; the pre-dose job adds 1,440 more, roughly 0.3 MB a day or
  110 MB a year, against a 15 MB database (observed 2026-10-19). The
  proposal: keep successful runs for 14 days and failed runs for 90, removed
  by a daily purge job added in its own, separately reviewed migration. No
  purge job exists and no scheduler setting has been changed. The proposal
  stays deferred: it is not adopted policy and is not implemented.

To roll back: the website from before PR #49 first, then
`supabase/rollbacks/20260902100037_medication_pre_dose_reminders.down.sql` as a
new migration. It unschedules the job and removes the function, the guard and
the column. Every dose, every reminder already sent and each clinic's lead-time
setting stay; the follow-up reminder is untouched. Newest first, 37 goes
before 36's rollback where 36 is rolled back too, and before 31's: since
PR #50, 31's down-script refuses while 37 is installed (see "To roll back 31"
above, including when that refusal leaves everything as it was).

### The guidance assistant switch (migration 38)

The adviser's "AI Chatbot On/Off": a platform switch for the Super Admin and
a `chatbot.enabled` setting for each clinic, both enforced by `chatbot-reply`
before anything reaches Gemini. It needs migrations 33 and 31 and refuses to
run without them; it is independent of 34 (`tests/db/guidance-assistant-switch.test.ts`
applies it after 37 with 34 unapplied, as production has them). Every switch
starts unset, which is on, so applying it changes nothing anyone sees -
unless a clinic's `chatbot.enabled` was saved before it, below.

**Where it stood on 2026-10-21** (read-only checks of production that day;
a dated snapshot, not the current state - check again before relying on it):

- **Step 1 is done.** Migration 38 is in the history as version
  `20261020154726` (`guidance_assistant_switch`). What it adds is there, and
  the bodies of its six functions, `audit_scope_for` included, match this
  file byte for byte (MD5 and length). `app_private.platform_setting` has row
  level security on, no grant to `anon` or `authenticated`, and both
  triggers. `guidance_assistant_on` is executable by its owner only and
  `guidance_assistant_on_for_doctor` by `service_role` only;
  `guidance_assistant_available` and the two `super_admin_*_guidance_assistant`
  functions by `authenticated` and `service_role`. All are
  `SECURITY DEFINER` with an empty `search_path`.
- **The security advisor** shows 22
  `authenticated_security_definer_function_executable` warnings - the 19 of
  the 2026-10-19 baseline and this migration's three - and
  `auth_leaked_password_protection`. It also shows, at INFO level,
  `rls_enabled_no_policy` for `app_private.platform_setting`. That is
  intended: the table is reached only through the functions above, so it
  has no policy and no grant. Do not "fix" it by adding a policy.
- **Every switch is unset, so on:** no row in `app_private.platform_setting`
  and no clinic `chatbot.enabled` row.
- **Step 2 is deployed, not smoke-tested.** `chatbot-reply` v17
  (2026-10-20 18:04Z) is this branch's function, byte for byte: commit
  `3a39b06`, the switch check and the 30 s limit to Gemini. No smoke test of
  the switch on it is recorded - turning a switch off and seeing `disabled`
  is a production write and needs its own approval - and replies were
  reported running into the 30 s limit against Gemini.
- **Step 3 is not done:** `main` does not have this change, so its website
  has no switches and its `reply-failure.ts` knows no `disabled` code. Until
  it does, turning a switch off reaches patients as "not available" with
  Try again, and 33's rollback must be taken from this branch: this one
  refuses while 38 is installed, and `main`'s does not. 31's is the same on
  both and has no check for 38 of its own; it relies on 33's and 37's
  refusing first.

The two switches do not depend on 38 in the same way:

- The Super Admin's switch exists only in 38. It is read and changed through
  `super_admin_get_guidance_assistant()` and
  `super_admin_set_guidance_assistant()`, which check for a Super Admin;
  before 38 its card on the Clinics page shows an error and saves nothing.
- The Clinic Admin's is an ordinary clinic setting, saved through
  `system_setting` like every other, and that table takes any key. It saves
  before 38, and the card shows the saved choice, but nothing reads it: the
  `chatbot-reply` deployed before this change ignores it.
- Only once 38 and this `chatbot-reply` are both live does the server
  enforce either switch. A clinic's Off saved before then takes effect at
  that moment, without anyone changing it.

The release order, each step its own approval, with the website last:

1. **Apply migration 38 and verify it**, with the read-only checks before
   and after that 37 had: history, the objects it adds, and the security
   advisor - expect three more
   `authenticated_security_definer_function_executable` warnings, for
   `guidance_assistant_available`, `super_admin_get_guidance_assistant` and
   `super_admin_set_guidance_assistant` (`docs/security.md`).
2. **Deploy `chatbot-reply`.** It asks `guidance_assistant_on_for_doctor()`
   before every reply and refuses when it cannot get an answer.
3. **Merge the website.** It adds both switches and the patient's "turned
   off" notice. It reads `guidance_assistant_available()` and treats an
   unreadable answer as unknown, so where 38 is missing patients' chat works
   as it did before.

Out of order, patients see the difference:

- **`chatbot-reply` before 38:** it cannot read the switches, so every
  guidance reply, in every clinic, is refused as unavailable until 38 is
  applied. The patient's message is saved; no answer comes.
- **The website before 38:** patients' chat is unchanged, but a Clinic Admin
  can turn the assistant Off, see it saved, and the assistant keeps
  answering their patients; when 38 and the function arrive, that Off takes
  effect unannounced. The Super Admin's switch cannot be used.
- **The website after 38 but before the function:** a patient's page hides
  the message box once a switch is off, but the server does not enforce it,
  so a page that has not yet re-read the switch, or any direct request,
  still gets an answer.
- **The function without the website:** with every switch unset nothing
  changes. A switch turned off some other way reaches patients as the
  assistant being unavailable, with an offer to try again, rather than as
  turned off.

Its down-script, `supabase/rollbacks/20260902100038_guidance_assistant_switch.down.sql`,
removes both readers and the platform's table and puts back migration 33's
audit classifier; each clinic's `chatbot.enabled` row stays, read by
nothing. Roll `chatbot-reply` and the website back first. 38 goes before 37's
and before 33's: since this change, 33's down-script refuses while 38 is
installed, because 38's switch is changed only through the Super Admin checks
33 removes.

### The platform switch's field names in the audit trail (migration 39)

Migration 35 keeps, of an audit entry's details, only the names of changed
fields that are columns of a table in `public`. Migration 38 put the
platform's switch in `app_private.platform_setting`, so the Super Admin's
audit read, `super_admin_list_audit`, returns every change of that switch
with no field names: the entry is there, but nothing says what changed, and
the console's label for `platform_setting_value` ("on or off") never shows.
No value leaks; the entry is incomplete.

Migration 39 changes one function, `app_private.audit_changed_field_names`,
so that it also keeps the names of the columns of
`app_private.platform_setting`. That table is the only `app_private` table
it names: an explicit allow-list, not the whole schema. It needs 35 and 38
and refuses to run without them. It is independent of 34
(`tests/db/platform-setting-audit-field-names.test.ts` applies it after 38
with 34 unapplied, as production has them, and ends with the repository's
schema once 34 follows). `super_admin_list_audit`, its grants and every audit
row stay as they are. An entry written before 39 is read through the same
function, so the switch's earlier changes show their field names too. The
switch's values, `true` and `false`, never come back: the test turns the
switch off and on through `super_admin_set_guidance_assistant` and looks for
them in what the Super Admin's read returns.

**Not applied.** Applying 39 to production is a separate, approved step. It
also has no code half. The website already labels the field "on or off"
(it came with the switch, #59), but until 39 is applied the label never
shows, because the field's name never comes back. No Edge Function changes,
so 39 can go in at any time.

The release order, each step its own approval:

1. **Review the change**: the migration, its down-script and its test.
2. **Approve migration 39**, separately.
3. **Apply and verify migration 39 in production**, on its own, with
   `apply_migration` and the read-only checks below.
4. **Nothing else.** No website merge or Edge Function deploy depends on it.

#### Before applying - read-only

1. **The file is the reviewed one.** In a checkout of the reviewed commit:

   ```bash
   md5sum supabase/migrations/20260902100039_platform_setting_audit_field_names.sql
   wc -c supabase/migrations/20260902100039_platform_setting_audit_field_names.sql
   ```

   The file as proposed for review is MD5 `2aa8a8779b4c6b002920323118f67202`,
   5,044 bytes. If review changes it, record the new values here before
   applying. A match confirms the file is the one that was reviewed; it does
   not replace reviewing what the migration contains. The text passed to
   `apply_migration` must have the same checksum and length.
2. **History.** `list_migrations` has migration 38's entry,
   `guidance_assistant_switch` (version `20261020154726`, above), and none
   named `platform_setting_audit_field_names`. If there is one, 39 is
   already applied: stop. If any entry is newer than 38's, review what it
   changed before going on.
3. **Schema.** 38's table is there, and both functions are migration 35's
   as this repository replays it:

   ```sql
   select
     to_regclass('app_private.platform_setting')::text as platform_setting,  -- app_private.platform_setting
     (select md5(prosrc) || ' ' || octet_length(prosrc) from pg_proc
       where oid = 'app_private.audit_changed_field_names(jsonb)'::regprocedure)
                                                       as helper_body,       -- 734b46ad0294aeaad3a60e3328ab348a 1114
     (select md5(prosrc) || ' ' || octet_length(prosrc) from pg_proc
       where oid = 'public.super_admin_list_audit(integer, timestamptz, uuid)'::regprocedure)
                                                       as list_body;         -- 62bad1035013fa2ca35c936c790dc440 901
   ```

   A different `helper_body` means the function is not 35's: stop and review
   it before replacing it.
4. **What the Super Admin is shown now.** The switch's entries, through the
   function the Super Admin's read uses, so this prints field names and
   never a value:

   ```sql
   select l.audit_log_action as action,
          app_private.audit_changed_field_names(l.audit_log_details) as names
     from public.audit_log l
    where l.audit_log_entity = 'platform_setting'
    order by l.audit_log_timestamp, l.audit_log_id;
   -- before 39: every row's names is null; no rows if the switch was never changed
   ```

5. **Security advisor.** Record its findings (`get_advisors`, security), as
   the baseline. 39 adds no function and changes no grant, so it should not
   change them.
6. **Window.** An agreed window, chosen around the heavier jobs as above.
   39 replaces one function that no job, trigger or policy calls, and takes
   no lock on a table, so the 3-second `lock_timeout` convention for
   migrations that lock the jobs' tables does not apply to it.

#### After applying - read-only

1. **History.** One entry for the migration. Its version is the time it was
   applied, not `20260902100039`:

   ```sql
   select version, name, cardinality(statements) as statements,
          md5(array_to_string(statements, '')) as md5,
          octet_length(array_to_string(statements, '')) as bytes
     from supabase_migrations.schema_migrations
    where name = 'platform_setting_audit_field_names';
   -- one row; with the script stored as one statement, md5 and bytes equal
   -- the reviewed file's - anything else means a different text was applied
   ```

2. **Schema and privileges.** The helper's body is 39's. It is still no API
   role's to call, still `SECURITY INVOKER` with an empty `search_path`.
   `super_admin_list_audit` is unchanged:

   ```sql
   select
     (select md5(prosrc) || ' ' || octet_length(prosrc) from pg_proc
       where oid = 'app_private.audit_changed_field_names(jsonb)'::regprocedure)
                                                       as helper_body,           -- eaec81759c4ff4e250e4c2fbb98c7325 1309
     (select prosecdef || ' ' || array_to_string(proconfig, ',') from pg_proc
       where oid = 'app_private.audit_changed_field_names(jsonb)'::regprocedure)
                                                       as helper_definer,        -- false search_path=""
     (select count(*)
        from pg_proc p,
             aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       where p.oid = 'app_private.audit_changed_field_names(jsonb)'::regprocedure
         and a.grantee = 0 and a.privilege_type = 'EXECUTE')  as helper_public_grants,  -- 0
     has_function_privilege('anon',          'app_private.audit_changed_field_names(jsonb)', 'execute') as helper_anon,          -- false
     has_function_privilege('authenticated', 'app_private.audit_changed_field_names(jsonb)', 'execute') as helper_authenticated, -- false
     has_function_privilege('service_role',  'app_private.audit_changed_field_names(jsonb)', 'execute') as helper_service_role,  -- false
     (select md5(prosrc) || ' ' || octet_length(prosrc) from pg_proc
       where oid = 'public.super_admin_list_audit(integer, timestamptz, uuid)'::regprocedure)
                                                       as list_body,             -- 62bad1035013fa2ca35c936c790dc440 901
     has_function_privilege('anon',          'public.super_admin_list_audit(integer, timestamptz, uuid)', 'execute') as list_anon,          -- false
     has_function_privilege('authenticated', 'public.super_admin_list_audit(integer, timestamptz, uuid)', 'execute') as list_authenticated; -- true
   ```

3. **The filter, on a literal.** It changes nothing and reads no row:

   ```sql
   select app_private.audit_changed_field_names(
     '{"changed_columns": ["platform_setting_updated_at", "platform_setting_value", "true", "false", "guidance_assistant.enabled"]}'::jsonb
   );
   -- {"changed_columns": ["platform_setting_updated_at", "platform_setting_value"]}
   ```

4. **What the Super Admin is shown now.** Rerun check 4 from before
   applying: each `update` row's names include `platform_setting_value`,
   each `insert` row's are null, and no row shows `true` or `false`. There
   are still no rows if the switch was never changed.
5. **Security advisor.** The same findings as the baseline recorded before
   applying.

These checks show the function is installed, locked down and returns names
only. They do not show the Super Admin's page itself: that needs a Super
Admin's session, and a fresh entry needs the switch changed, which is a
production write with its own approval.

**If applying fails, or only part of it seems to have run, stop.** Gather
read-only evidence (the error, whether a history entry exists, and the
helper's body and grants) and report it. Do not retry, re-apply, repair the
migration history or roll back without a separate decision.
`apply_migration`'s transaction behaviour is not documented (see "To roll
back 31" above).

To roll back: `supabase/rollbacks/20260902100039_platform_setting_audit_field_names.down.sql`
as a new migration. It restores migration 35's function and comment, so the
switch's changes are listed with no field names again, and changes no row.
No code goes back. It refuses where 39 is not applied. It goes before 38's
and 35's. 35's down-script drops the helper, taking 39 with it, and 38's
leaves 39's helper naming a table that is gone. That does no harm, but the
schema is then not exactly what 37 left.

## Bundle budget

Measured on the built output, gzipped, for a first-time visitor to the landing
page:

| Chunk | Gzipped |
| --- | ---: |
| react | 57 kB |
| supabase | 54 kB |
| router | 31 kB |
| query | 10 kB |
| app shell + CSS | 29 kB |
| **Total first load** | **181 kB** |

Role screens load on demand — a patient never downloads the administrator's
audit-log page.

The document downloads (prescription, treatment plan, system-wide report)
load their libraries only when a file is asked for: pdf-lib is a chunk of its
own, about 177 kB gzipped, and the Excel writer with fflate about 7 kB. Neither
is referenced by `index.html`.

Two findings worth keeping in mind when changing `vite.config.ts`:

1. **Naming a chunk in `manualChunks` pins it into the entry's preload
   graph.** Grouping Zod and React Hook Form into a `forms` chunk moved 31 kB
   from the sign-in route onto the landing page — the opposite of the
   intention. Only name dependencies that are genuinely needed at boot.
2. **`src/lib/env.ts` is on the boot path.** The Supabase client imports it,
   so anything it imports is downloaded before first paint. That is why its
   validation is hand-rolled rather than using Zod.

Re-measure after dependency changes:

```bash
npm run build          # then check what index.html references
```

## Demonstration accounts

The production database contains exactly three accounts, and no others:

| Email | Role | Name |
| --- | --- | --- |
| `patient@smoke.invalid` | patient | Alice Santos |
| `doctor@smoke.invalid` | doctor | Dr Alan Cruz |
| `admin@smoke.invalid` | admin | Ada Reyes |

They were created to smoke-test the live deployment and they are also the only
data that makes it demonstrable — there is no separate "real" set behind them.
Deleting them would leave the system with no users at all, so they were kept
and their credentials rotated instead.

**The password these accounts were originally seeded with no longer works.**
It was rotated, verified dead against the live sign-in page, and later replaced
with a value chosen by the project owner. That value is deliberately not
recorded here — a credential that works against a public URL does not belong in
a repository. Sessions and refresh tokens were cleared during the rotation.

A note worth keeping: the first attempt to set a password through the Supabase
dashboard was applied to a **different project**, so it silently had no effect
here. Sign-in kept failing with `invalid_credentials` while the dashboard
showed success. If credentials ever behave that way, check the project ref in
the dashboard URL against `kwsezszstdagzllbyjuk` before debugging anything
else.

To use them again, set a password of your choosing. Either **Authentication →
Users → … → Reset password** in the dashboard, or run this in the SQL editor,
substituting your own value:

```sql
update auth.users
   set encrypted_password = extensions.crypt('<choose-a-password>',
                                             extensions.gen_salt('bf'))
 where email = 'admin@smoke.invalid';
```

Rotation did not touch any application data. All records survive — one
patient, one doctor, one treatment plan, one prescription, 64 dose slots, one
recovery log, one clinical note, one appointment — and every authorization
boundary was re-verified afterwards: the doctor still sees their one patient,
the administrator still sees zero patient rows, and the patient still sees
zero clinical notes.

Note on `.invalid`: it is a reserved TLD that can never resolve, so these
addresses cannot receive password-reset email. That is deliberate for test
fixtures, but it does mean self-service recovery is not available for them —
use the dashboard or the SQL above. Real accounts get a working address and
the invitation flow in `create-account`.

## Pre-deployment checklist

- [ ] `npm run verify` passes (lint, typecheck, 164 tests, build)
- [ ] `npm run test:e2e` passes (42 browser tests)
- [ ] Migrations applied; `db advisors` reports no security findings
- [ ] Every migration a website change depends on is applied and verified
      **before** that change is merged - Vercel deploys `main` on merge
      (see "Doctors' announcements (migration 36)")
- [ ] First administrator provisioned
- [ ] Clinic time zone checked (Admin → System settings)
- [ ] Edge Functions deployed with `ALLOWED_ORIGINS` set
- [ ] Vercel env vars set for Production (and Preview if used)
- [ ] Supabase Site URL and `/reset-password` redirect configured
- [ ] Sign in as each role and confirm routing
- [ ] Confirm an administrator sees **no** patient records
- [ ] Confirm a doctor sees only their own patients
- [ ] `git log` shows the expected author on every commit
