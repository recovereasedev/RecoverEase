# Project map

A one-page guide to where things are and how work moves through this
repository. It points into the detailed documents rather than repeating them;
when the two disagree, the detailed document and the code win.

Checked against `main` at `7d6e60d` (2026-11-04). Production state (which
migrations are applied, which function versions are deployed) changes too
often for this page and is recorded in [`deployment.md`](./deployment.md).

## What RecoverEase is

A clinician-provisioned recovery management platform: patients, doctors and
clinic administrators, plus a platform-level Super Admin. There is no public
sign-up. Scope comes from the University of Cebu "List of Modules" (14
modules, Table 31); see the [README](../README.md#what-it-does) and
[`adviser-checklist.md`](./adviser-checklist.md).

| Layer | Choice |
| --- | --- |
| UI | React 19, TypeScript (strict), Vite 8, single-page app |
| Styling | Tailwind CSS v4, CSS-first tokens (`src/index.css`) |
| Server state | TanStack Query, keys in `src/lib/query-keys.ts` |
| Forms | React Hook Form + Zod |
| Backend | Supabase: PostgreSQL, Auth, Edge Functions (Deno). No application server |
| Authorization | PostgreSQL Row Level Security |
| AI assistant | Google Gemini, called only from the `chatbot-reply` Edge Function |
| Documents | `pdf-lib` (PDFs) and `fflate` (spreadsheet export), both client-side, in `src/lib/documents/` |
| Tests | Vitest (jsdom + node), React Testing Library, PGlite, Playwright, axe |
| Lint | oxlint |
| Hosting | Vercel (frontend), Supabase (everything else) |

Why there is no Next.js or server layer: [`architecture.md`](./architecture.md#why-not-nextjs).

## Repository layout

```
src/
  app/            providers, router, routes/ (guards, lazy pages, navigation)
  components/     ui/ primitives, layout/ shell, feedback/ states
  features/       one folder per feature: api.ts, hooks.ts, components/, pages/
  hooks/          shared React hooks
  lib/            env, supabase client, query keys, format, documents, PWA
  types/          generated database types (npm run db:types)
supabase/
  migrations/     schema, applied in filename order (single source of truth)
  rollbacks/      <migration>.down.sql for migrations 29 onward
  functions/      Edge Functions + _shared/
tests/
  unit/           component and unit tests (Vitest, jsdom)
  db/             schema and RLS tests against real PostgreSQL (PGlite)
e2e/              Playwright journeys; support/ holds the PostgREST stub,
                  preview/ the local Super Admin console preview
scripts/          generate-db-types.ts, vercel-headers.ts, check-preview-build.ts
public/           manifest, service worker, offline page, icons
docs/             the documents listed at the end of this page
```

Feature folders under `src/features/`: announcements, appointments,
audit-logs, auth, calendar, chat, dashboard, doctor-notes, marketing,
medications, notifications, patients, platform (Super Admin console),
recovery-logs, recovery-progress, reminders, reports, system-settings,
treatment-plans. Module-to-folder mapping:
[`architecture.md`](./architecture.md#where-the-module-list-is-implemented).

## Roles and routes

| Role (`user_role`) | Home | Scope |
| --- | --- | --- |
| `patient` | `/patient` | Their own records |
| `doctor` | `/doctor` | Their assigned patients |
| `admin` (Clinic Admin) | `/admin` | Their clinic's accounts and settings; **cannot read patient records** |
| `super_admin` | `/platform` | Platform overview (platform totals only), clinics (`/platform/clinics`, with search and a status filter), a clinic's details (`/platform/clinics/:clinicId`: its information, its Clinic Admins, editing its name and time zone), Clinic Admins, platform announcements and audit; never patient care; behind an authenticator-app (TOTP) gate |

Guards live in `src/app/routes/guards.tsx` and decide what is rendered. RLS
decides what is readable: a user who bypasses a redirect still gets no rows.

## Authentication, roles and RLS

- **Provisioning.** Clinic Admins create doctors and doctors create patients
  through `create-account`, which issues a temporary credential; the holder
  must change it (`complete-password-setup`) before using the app. The first
  Clinic Admin and every Super Admin are provisioned out of band by the
  database owner. See [`authentication.md`](./authentication.md).
- **Roles come from `public.user_account`**, never from JWT metadata. No
  browser session can write that table (migration 27).
- **RLS helpers** live in the unexposed `app_private` schema with `EXECUTE`
  revoked from `PUBLIC`.
- **Clinics** (migrations 28 to 31) scope Clinic Admin access; the Super Admin
  (32, 33, 38, 46 and 47) works through `SECURITY DEFINER` functions that re-check the
  caller in the database.
- **Audit log** is append-only for every role and records which columns
  changed on patient tables, never their values.

Full model, access matrix and known limitations: [`security.md`](./security.md).

## Database and migrations

- Schema and every deviation from the ERD: [`database.md`](./database.md).
- Files are `supabase/migrations/20260902100NNN_<name>.sql`. Number `NNN` is the
  migration's identity; the timestamp prefix is fixed, not the date written.
- Numbers 39 and 40 are taken by the open PRs that introduced them; check open
  PRs before choosing the next number.
- Migrations from 29 onward ship a rollback in `supabase/rollbacks/`, except
  32 (PostgreSQL cannot remove an enum value). Migrations 41 onward set
  `lock_timeout = '3s'` so they stop rather than queue behind live traffic.
- After changing a migration run `npm run db:types`; it applies the committed
  migrations to an in-process PostgreSQL and regenerates `src/types/`.
- Applying to production is a separate step that needs the project owner's
  explicit approval, timed away from the `pg_cron` jobs' run times, and
  verified read-only afterwards.
  Setup steps and the per-migration release notes, including apply order and
  rollback order: [`deployment.md`](./deployment.md).

## Edge Functions

All in `supabase/functions/`, sharing code from `_shared/` (auth, CORS,
caller checks, assistant, escalation).

| Function | Does | Key |
| --- | --- | --- |
| `create-account` | Creates doctor and patient accounts with a temporary credential | service role |
| `reset-account-password` | Reissues a temporary credential (Clinic Admin for their doctors, doctor for their patients) | service role |
| `complete-password-setup` | Sets the new password and clears the forced-change flag in one call | service role |
| `chatbot-reply` | The patient guidance assistant: clinic prompt, assistant switch, critical-concern escalation, validated reply | Gemini key |

Secrets are set as Edge Function secrets, never in the client. Variable names
(no values) are in the [README](../README.md#environment-variables) and
`.env.example`; only `VITE_` variables reach the browser.

## Frontend architecture

- Features own their data access: a page uses its own feature's `api.ts` and
  `hooks.ts`; other features' data goes through their exported hooks.
- Queries do not repeat authorization filters; RLS scopes the rows.
- The query cache is per account: every key starts with the account id and the
  cache is cleared when the signed-in account changes.
- Routes are lazy-loaded on the role boundary.
- PWA: installable, with an offline page only; clinical data is never cached.

Details: [`architecture.md`](./architecture.md). Visual system, contrast and
accessibility rules: [`ui-design.md`](./ui-design.md).

## Testing

| Command | Runs |
| --- | --- |
| `npm run verify` | lint + typecheck + all Vitest tests + build (run before any PR) |
| `npm run test:unit` | Vitest `unit` project (jsdom) |
| `npm run test:db` | Vitest `db` project: every migration into PGlite, then RLS checks as real principals |
| `npm run test:e2e` | Playwright against a production build (`vite preview`), projects `desktop`, `mobile`, `desktop-pdf-viewer` |
| `npm run preview:super-admin` | The Super Admin console in a local browser against the stub, built to reach no Supabase project (`PREVIEW_SMOKE=1` clicks through it headless) |

Playwright talks to a PostgREST-shaped stub (`e2e/support/supabase-stub.ts`),
never to a real Supabase project; RLS is proven by the `db` suite instead. No
Docker is needed. Strategy and what is not covered: [`testing.md`](./testing.md).

## Deployment

- **Frontend:** Vercel builds from git. Every pushed branch gets a preview
  deployment; `main` deploys to production at <https://recoverease-web.vercel.app>.
  `vercel.json` sets SPA rewrites, the Content-Security-Policy, security
  headers and immutable asset caching. Nothing is deployed by hand.
- **Preview deployments use the production Supabase project.** Do not sign in
  to or submit data on a preview.
- **Database and Edge Functions:** applied and deployed separately, each with
  explicit approval. A migration a website change depends on is applied before
  that change merges.
- Email delivery setup: [`EMAIL_SMTP_SETUP.md`](./EMAIL_SMTP_SETUP.md).

## Git and pull requests

- Repository `recovereasedev/RecoverEase`; PRs target `main`.
- Commits authored as the individual developer, configured per repository
  ([README](../README.md#git-workflow)).
- Conventional prefixes (`feat:`, `fix:`, `docs:`, `test:`, `chore:`,
  `perf:`); the body says why.
- One feature per branch; never commit to `main` directly.
- No force pushes and no rewriting shared history. Merges need the project
  owner's explicit approval.

## Safety rules

- **Production holds real accounts.** Only data owned by the
  `@smoke.invalid` demonstration accounts may be changed during testing, and
  only with approval.
- **Never run the Supabase CLI from a checkout linked to production**; target
  a project explicitly.
- **Never commit or print secrets.** `.gitignore` blocks every `.env*` file
  except `.env.example`.
- **Never edit the schema in the dashboard.** Every change is a migration.
- **Never put video, recording or design-reference files in the repository.**

## Documents

| Document | Covers |
| --- | --- |
| [README](../README.md) | Overview, setup, scripts, environment variable names |
| [`architecture.md`](./architecture.md) | System shape, stack decisions, layout, data flow, PWA |
| [`authentication.md`](./authentication.md) | Provisioning, sessions, consent gate, passwords |
| [`database.md`](./database.md) | Schema and deviations from the ERD |
| [`security.md`](./security.md) | RLS model, access matrix, Super Admin, limitations |
| [`testing.md`](./testing.md) | Test strategy and gaps |
| [`deployment.md`](./deployment.md) | Setup, migration releases, scheduled jobs, production status |
| [`ui-design.md`](./ui-design.md) | Design tokens, contrast, accessibility |
| [`adviser-checklist.md`](./adviser-checklist.md) | Module checklist status |
| [`EMAIL_SMTP_SETUP.md`](./EMAIL_SMTP_SETUP.md) | Email delivery |
