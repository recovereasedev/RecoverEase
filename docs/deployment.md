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

To roll back 31, go the other way: the website from before 31, then
`chatbot-reply` from before 31, then `supabase/rollbacks/20260902100031_clinic_settings.down.sql`
as a new migration. It refuses while there is more than one clinic - two
clinics' settings cannot be folded into one - and writes the clinic's zone
back into the global `app.timezone` row so nothing that reads it moves.

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

The settings page from migration 37 on offers the lead time, and nothing reads
it until 37 is applied, so the release order is the usual one: apply and
verify 37, then merge the website change. Verify with the query above - the
new job is listed, `* * * * *`, active - and:

```sql
select count(*) from information_schema.columns
 where table_name = 'medication_log'
   and column_name = 'medication_log_pre_dose_sent_at';   -- 1
```

The job runs **every minute**, so there is no longer a minute without a
scheduled run. Each run is one short statement, idempotent, with its own
duplicate guard; a migration that changes `medication_log` waits at most for
the run in progress. Applying migrations only between scheduled runs is
therefore no longer possible as such, and how migrations are timed from then
on is a decision to make before 37 is applied.

To roll back: the website from before 37 first, then
`supabase/rollbacks/20260902100037_medication_pre_dose_reminders.down.sql` as a
new migration. It unschedules the job and removes the function, the guard and
the column. Every dose, every reminder already sent and each clinic's lead-time
setting stay; the follow-up reminder is untouched. Roll it back before 36's.

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
