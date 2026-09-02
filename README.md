# RecoverEase

A recovery management platform that connects patients with their care team
through treatment plans, medication tracking, appointment management and daily
recovery monitoring.

RecoverEase is **clinician-provisioned**. Administrators create doctor
accounts, doctors create patient accounts, and there is no public sign-up.

---

## Contents

- [What it does](#what-it-does)
- [Roles](#roles)
- [Stack](#stack)
- [Getting started](#getting-started)
- [Environment variables](#environment-variables)
- [Supabase setup](#supabase-setup)
- [Scripts](#scripts)
- [Testing](#testing)
- [Security](#security)
- [Deployment](#deployment)
- [Git workflow](#git-workflow)
- [Documentation](#documentation)

---

## What it does

Fourteen modules, taken from the program specification (University of Cebu,
College of Computer Studies, Table 31):

| # | Module | Patient | Doctor | Admin |
| --- | --- | :---: | :---: | :---: |
| 1 | Authentication & user access | ● | ● | ● |
| 2 | Registration & account management | ● | ● | ● |
| 3 | Treatment plan | ● | ● | |
| 4 | Medication | ● | ● | |
| 5 | Recovery monitoring | ● | ● | |
| 6 | Appointment management | ● | ● | |
| 7 | Notification & communication | ● | ● | |
| 8 | AI chatbot support | ● | ● | ● |
| 9 | Reports & analytics | | ● | ● |
| 10 | Admin dashboard | | | ● |
| 11 | Doctor account management | | | ● |
| 12 | System announcements | | | ● |
| 13 | Audit logs | | | ● |
| 14 | System settings | | | ● |

## Roles

**Patient** — records daily recovery progress and mood, follows their
treatment plan and goals, tracks medication and marks doses taken, books and
confirms appointments, requests reschedules, asks the guidance chatbot
questions, and manages their reminder preferences.

**Doctor** — sees the patients assigned to them, creates treatment plans and
goals, issues prescriptions and medication schedules, reviews recovery history
and adherence, writes clinical notes, decides reschedule requests, and
generates recovery reports.

**Administrator** — manages doctor accounts, posts announcements, reviews the
audit log, configures system settings, and sees system-wide counts.
**Administrators cannot read patient records** — this is enforced by the
database, not by the interface. See [`docs/security.md`](./docs/security.md).

## Stack

| Layer | Choice |
| --- | --- |
| UI | React 19, TypeScript (strict), Vite 8 |
| Styling | Tailwind CSS v4 with CSS-first design tokens |
| Server state | TanStack Query |
| Forms | React Hook Form + Zod |
| Backend | Supabase — PostgreSQL, Auth, Edge Functions |
| Authorization | PostgreSQL Row Level Security |
| Testing | Vitest, React Testing Library, PGlite |
| Hosting | Vercel |

## Getting started

```bash
npm install
cp .env.example .env.local     # then fill in your Supabase values
npm run dev
```

The app expects a Supabase project with the migrations applied — see
[Supabase setup](#supabase-setup). The **test suite needs no configuration**
and runs immediately: `npm test`.

## Environment variables

Copy [`.env.example`](./.env.example) to `.env.local`.

| Variable | Where | Notes |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | Browser | Project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Browser | Publishable (anon) key. Public by design — RLS is what protects the data. |
| `SUPABASE_SERVICE_ROLE_KEY` | Edge Function secrets | **Never** `VITE_`-prefixed, never in client code, never committed. Bypasses RLS entirely. |
| `ANTHROPIC_API_KEY` | Edge Function secrets | Guidance chatbot. Without it the chatbot returns 503 and the UI says so; everything else works. |
| `ALLOWED_ORIGINS` | Edge Function secrets | CORS allowlist for the functions. |

Anything prefixed `VITE_` is compiled into the browser bundle.
`src/lib/env.ts` declares only the two publishable values, so a service key
cannot be read from client code even by accident.

`.gitignore` blocks all `.env*` files with an explicit exception for
`.env.example`.

## Supabase setup

```bash
supabase link --project-ref <ref>
supabase db push                       # apply migrations
supabase db advisors                   # expect no security findings

supabase functions deploy create-account
supabase functions deploy chatbot-reply
supabase secrets set ALLOWED_ORIGINS="https://your-app.vercel.app"
```

The first administrator is provisioned out of band — no module grants anyone
the ability to create one. Full steps, including seeding system settings and
wiring the scheduled jobs, are in
[`docs/deployment.md`](./docs/deployment.md).

### Migrations

Migrations in [`supabase/migrations/`](./supabase/migrations) are applied in
filename order and are the single source of truth for the schema. Never edit a
schema by hand in the dashboard.

After changing a migration, regenerate the types:

```bash
npm run db:types
```

This applies the committed migrations to an in-process PostgreSQL and
introspects the result, so the generated types cannot drift from the schema.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Dev server |
| `npm run build` | Type-check and produce a production build |
| `npm run typecheck` | Type-check without emitting |
| `npm run lint` | oxlint |
| `npm test` | All 136 tests |
| `npm run test:unit` | Component and unit tests |
| `npm run test:db` | Schema and RLS tests, against real PostgreSQL |
| `npm run test:coverage` | Coverage report |
| `npm run db:types` | Regenerate database types from migrations |
| `npm run verify` | lint + typecheck + test + build |

## Testing

136 tests in two suites:

- **78 database tests** run every migration into a real PostgreSQL (PGlite,
  in-process, no Docker) and then issue queries as different principals to
  verify the Row Level Security policies actually hold — cross-tenant
  isolation, doctor scoping, administrator boundaries, privilege escalation,
  workflow integrity and the medication reminder scheduler's idempotency.
- **58 component and unit tests** cover the logic that can be silently wrong:
  streak calculation across timezones, adherence maths, loading/empty/error
  ordering, error translation, accessibility wiring and route guards.

See [`docs/testing.md`](./docs/testing.md), including an honest list of what
is **not** covered.

## Security

Authorization lives in the database. The React route guards decide what is
*rendered*; Row Level Security decides what is *readable*. A patient who
bypasses a redirect still gets zero rows.

Highlights:

- Roles are read from a table, never from user-writable JWT metadata.
- RLS helpers live in a private, unexposed schema with `EXECUTE` revoked from
  `PUBLIC`.
- Deactivating a doctor revokes their data access at the database.
- Doctors cannot edit medication adherence; patients cannot read clinical
  notes; administrators cannot read patient records.
- The audit log is append-only for every role, and records only *which*
  columns changed on patient tables — never their values, because
  administrators can read it and must not learn patient data from it.

Full model, including known limitations, in
[`docs/security.md`](./docs/security.md).

## Deployment

Vercel for the frontend, Supabase for everything else.
[`vercel.json`](./vercel.json) configures SPA routing, a Content-Security-
Policy, immutable asset caching and the usual security headers.

**Not yet deployed.** See [`docs/deployment.md`](./docs/deployment.md) for the
full procedure and the pre-deployment checklist.

## Git workflow

Repository: **`recovereasedev/RecoverEase`**

Commits are authored by the individual developer, not the organisation
account. Configure this **per repository**, never globally:

```bash
git config --local user.name "Kean Caballero"
git config --local user.email "keancaballero147@gmail.com"
```

Verify before pushing:

```bash
git config --local user.name
git config --local user.email
git remote -v
git log -5 --format="%h | %an | %ae | %s"
```

Conventions:

- Small, logical commits — one concern each.
- Conventional prefixes: `feat:`, `fix:`, `chore:`, `test:`, `docs:`, `perf:`.
- The message body explains **why**, not what the diff already shows.
- No force pushes, no rewriting shared history.
- Scan for secrets before pushing.

## Documentation

| Document | Covers |
| --- | --- |
| [`architecture.md`](./docs/architecture.md) | System shape, stack decisions, directory layout, data flow |
| [`database.md`](./docs/database.md) | Schema, every deviation from the ERD, assumptions, indexes |
| [`authentication.md`](./docs/authentication.md) | Provisioning, session states, consent gate, password rules |
| [`security.md`](./docs/security.md) | RLS model, access matrix, column guards, PHI handling, limitations |
| [`testing.md`](./docs/testing.md) | Test strategy, the RLS harness, what is not covered |
| [`deployment.md`](./docs/deployment.md) | Setup, secrets, scheduled jobs, bundle budget, checklist |
| [`ui-design.md`](./docs/ui-design.md) | Design tokens, contrast ratios, accessibility, responsive rules |

## Licence

Unlicensed. All rights reserved.
