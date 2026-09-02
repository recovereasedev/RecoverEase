# Deployment

> **Status: not yet deployed.** Everything below has been written and the
> build verified locally, but no Supabase project has been provisioned and no
> Vercel deployment exists. Nothing in this document should be read as
> "already done".

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

insert into public.admin (user_id, admin_first_name, admin_last_name)
values ('<auth user id>', 'First', 'Last');
```

`user_email` must be lower case — a CHECK constraint enforces it.

From there the flow is entirely in-app: the administrator registers doctors,
and each doctor registers their own patients.

## 4. Seed the system settings

Optional but recommended. Without `app.timezone`, medication dose slots are
generated in UTC.

```sql
insert into public.system_setting (system_setting_key, system_setting_value)
values
  ('app.timezone', 'Asia/Manila'),
  ('medication.reminder_grace_hours', '6')
on conflict (system_setting_key) do nothing;
```

These are also editable from **Admin → System settings** (module 14.1).

## 5. Deploy the Edge Functions

```bash
supabase functions deploy create-account
supabase functions deploy chatbot-reply

supabase secrets set ALLOWED_ORIGINS="https://<your-app>.vercel.app"
supabase secrets set ANTHROPIC_API_KEY="sk-ant-..."
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are
injected by the platform — do not set them yourself.

`ALLOWED_ORIGINS` matters. These functions hold the service-role key and
create accounts; defaulting CORS to `*` would let any site on the internet put
a request to them in front of a signed-in user's browser. Localhost origins
are always permitted and are not reachable from outside the developer's
machine.

If `ANTHROPIC_API_KEY` is unset, `chatbot-reply` returns 503 and the UI says
the assistant is unavailable. Every other module works. That is a supported
configuration, not a broken one.

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

## Scheduled jobs

Migration `…100009_scheduled_jobs.sql` registers three pg_cron jobs. The whole
block is guarded on `pg_cron` being available, so it is a no-op where the
extension is absent (including the PGlite test harness) rather than aborting
the migration.

| Job | Cadence | Purpose |
| --- | --- | --- |
| `recoverease-extend-medication-slots` | `0 1 * * *` | Extends dose slots for every live schedule |
| `recoverease-medication-reminders` | `*/15 * * * *` | Chases doses that came due unrecorded (modules 4.2, 4.7) |
| `recoverease-mark-overdue-doses` | `5 * * * *` | Writes off doses past the grace period |

`cron.schedule(name, …)` replaces a job of the same name, so re-running the
migration does not accumulate duplicates.

Confirm after deploying:

```sql
select jobname, schedule, active from cron.job
 where jobname like 'recoverease-%';
```

**If pg_cron is unavailable** the migration logs a notice and skips. Call the
same three functions from any external scheduler using the service role —
they are the entire contract, and each is idempotent:

```sql
select public.extend_all_medication_log_slots(30);
select public.dispatch_medication_reminders(30);
select public.mark_overdue_medication_logs(6);
```

Reminders are delivered as in-app notifications, which is what the ERD's
`notification` table models. Email or push delivery would be a further step
and is not implemented.

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

## Pre-deployment checklist

- [ ] `npm run verify` passes (lint, typecheck, 136 tests, build)
- [ ] Migrations applied; `db advisors` reports no security findings
- [ ] First administrator provisioned
- [ ] `app.timezone` set
- [ ] Edge Functions deployed with `ALLOWED_ORIGINS` set
- [ ] Vercel env vars set for Production (and Preview if used)
- [ ] Supabase Site URL and `/reset-password` redirect configured
- [ ] Sign in as each role and confirm routing
- [ ] Confirm an administrator sees **no** patient records
- [ ] Confirm a doctor sees only their own patients
- [ ] `git log` shows the expected author on every commit
