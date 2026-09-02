# RecoverEase

A recovery management platform that connects patients with their care team
through treatment plans, medication tracking, appointment management and
recovery monitoring.

RecoverEase is a **clinician-provisioned** system. Administrators create doctor
accounts, doctors create patient accounts, and there is no public sign-up path.

## Status

Under active rebuild. See [`docs/`](./docs) for architecture, database, security
and deployment documentation.

## Stack

| Layer          | Choice                                        |
| -------------- | --------------------------------------------- |
| UI             | React 19, TypeScript (strict), Vite 8          |
| Styling        | Tailwind CSS v4 (CSS-first design tokens)      |
| Server state   | TanStack Query                                 |
| Forms          | React Hook Form + Zod                          |
| Backend        | Supabase (PostgreSQL, Auth, Edge Functions)    |
| Authorization  | PostgreSQL Row Level Security                  |
| Testing        | Vitest, React Testing Library, PGlite for RLS  |

## Getting started

```bash
npm install
cp .env.example .env.local   # then fill in your Supabase values
npm run dev
```

## Scripts

| Script                  | Purpose                                        |
| ----------------------- | ---------------------------------------------- |
| `npm run dev`           | Start the dev server                           |
| `npm run build`         | Type-check and produce a production build      |
| `npm run typecheck`     | Type-check without emitting                    |
| `npm run lint`          | Lint with oxlint                               |
| `npm test`              | Run all tests                                  |
| `npm run test:unit`     | Component and unit tests only                  |
| `npm run test:db`       | Schema and RLS policy tests (real Postgres)    |
| `npm run verify`        | lint + typecheck + test + build                |

## Environment

See [`.env.example`](./.env.example). Only `VITE_`-prefixed values reach the
browser, and only publishable credentials belong there. The service-role key is
never used in client code — it lives in Supabase Edge Function secrets.

## Licence

Unlicensed. All rights reserved.
