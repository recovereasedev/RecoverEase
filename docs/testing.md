# Testing

```bash
npm test              # everything — 113 tests
npm run test:unit     # component and pure-function tests (jsdom)
npm run test:db       # schema and RLS tests (real PostgreSQL)
npm run verify        # lint + typecheck + test + build
```

## Two suites, two environments

Vitest is split into projects because the two kinds of test need different
worlds:

| Project | Environment | Tests |
| --- | --- | --- |
| `unit` | jsdom | Component behaviour, pure domain logic |
| `db` | node | Schema, constraints, RLS policies |

## Row Level Security is tested, not assumed

The `db` project boots **PGlite** — a real PostgreSQL compiled to WebAssembly,
running in-process — replays every migration file from
`supabase/migrations/`, and then issues real queries as different principals.

Why not the Supabase CLI: it needs Docker, which is not installed on this
machine and is a heavy dependency for CI. PGlite runs anywhere Node runs, in
about two seconds, so the RLS suite is part of `npm test` rather than a
separate ritual someone might skip.

The harness reconstructs just enough of Supabase for the policies to behave
exactly as they do in production:

```sql
create schema auth;
create table auth.users (id uuid primary key, email text not null);

create function auth.uid() returns uuid as $$
  select nullif(current_setting('request.jwt.claims', true)::json ->> 'sub','')::uuid
$$;

create role anon; create role authenticated; create role service_role;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
```

Note what is **not** granted: `SELECT` on `auth.users`. A signed-in role can
resolve its own id and nothing more, matching production.

Impersonation runs inside a transaction so `set local` reverts automatically
and a denial cannot leave the session half-configured for the next assertion:

```ts
await database.asUser(aliceUserId, 'select * from patient')
await database.asAnon('select * from patient')
await database.asService('insert into patient ...')   // bypasses RLS, for fixtures
```

### The fixture is adversarial on purpose

```
doctorA ──► alice, bob     ← two patients sharing one doctor
doctorB ──► carol
doctorC ──► dave           ← doctorC is deactivated
admin
```

Alice and Bob share a doctor, which catches the subtle bug a single-tenant
fixture would miss: a policy scoped **by doctor** instead of **by patient**
would leak Bob's record to Alice and still look correct.

Having two active doctors means every test can distinguish "this doctor cannot
see that patient" from "no doctor can see any patient" — a policy that denies
everything passes a one-sided fixture while being completely broken.

### `expectDenied` treats both refusal shapes as denial

RLS refuses in two different ways, and a test checking only one is weak:

- a blocked `SELECT` or `UPDATE` returns **zero rows**, silently;
- a blocked `INSERT` **raises** "violates row-level security policy".

`expectDenied` accepts either, and — importantly — **fails when the statement
succeeds and returns rows**.

### What the 55 database tests cover

| Area | Examples |
| --- | --- |
| Anonymous access | Every patient-data table returns nothing to `anon` |
| Patient isolation | Alice cannot see Bob (same doctor) or Carol (different doctor) |
| Doctor scoping | doctorA sees exactly alice + bob; doctorB sees neither |
| Deactivation | doctorC, still able to authenticate, gets zero patients |
| Admin boundaries | Admin reads doctors and the audit log, and **no** patient, plan, prescription, recovery log, note, chat message or dose |
| Aggregates | `admin_dashboard_stats()` returns correct counts and refuses non-admins |
| **PHI leakage** | No patient name, prescription note or plan title appears in audit details |
| Escalation | Patient cannot change their doctor, status, or role; deactivated doctor cannot reactivate themselves; nobody can forge or delete audit rows |
| Workflow | Patient cannot approve their own reschedule; approving moves the appointment; doctor cannot edit adherence; patient cannot book with another doctor or on another patient's behalf |
| Notifications | Users see only their own; a doctor may notify their own patient but not someone else's |

Every guard test asserts the refusal **and** that the legitimate action still
works. A guard that blocked everything would otherwise pass.

### Schema tests

`tests/db/schema.test.ts` asserts structural facts that reviewing SQL by eye
does not catch:

- every migration applies cleanly
- **RLS is enabled on every table in `public`** — no exceptions
- every table has at least one policy
- `audit_log` has no write policy for any role
- `app_private` is not granted to `anon`
- every foreign key whose parent can be deleted is indexed

That last test found six genuinely missing indexes on the first run. Two were
added; four are exempted with a recorded reason (their parents are never
deleted and no module queries through them). The exemption list is in the
test, so the rule still holds for everything else.

## Component and unit tests

58 tests, chosen for logic that can be silently wrong rather than for
coverage percentage.

**Recovery streak** — the only number on the patient dashboard that is
computed rather than fetched. Covers gaps, month boundaries, unordered input,
and the timezone case that shaped the implementation: a patient in UTC+8
logging at 07:00 is still on the previous UTC day, so ISO date keys would
report a broken streak every morning.

**Adherence** — pins the clinical rule that doses not yet due are not
failures, and separates "no rate yet" from a real 0%.

**StateView** — guards the ordering that stops a slow request rendering as
"nothing here", including the case where stale empty data is present during a
refetch. Also asserts that a resolved-but-undefined query is an error, not an
empty list, so a broken request cannot hide behind an empty state.

**Error translation** — asserts a policy denial reaches the user in plain
language, and that neither "row-level security" nor the table name leaks into
the message.

**Accessibility** — label association, required state announced as a word
rather than an asterisk, errors wired with `aria-describedby`, status badges
keeping their text label in icon-only mode, buttons announcing loading, and
the tab list exposing exactly one tab stop with arrow/Home/End navigation.
These break silently: nothing looks wrong on screen when a label stops being
associated with its input.

**Route guards** — `loading` waits instead of redirecting; a deactivated
clinician gets an explanation rather than the login form; a patient on an
admin route is sent home.

## Test environment configuration

`src/lib/env.ts` validates configuration at import time and throws when it is
missing — deliberately, so a misconfigured deployment fails at startup rather
than at the first sign-in. Tests import modules downstream of it, so the
`unit` project supplies obvious placeholder values. **No test makes a network
call**: everything exercises pure functions or renders components with data
passed directly.

## What is not covered

Stated plainly rather than implied:

- **No end-to-end tests.** There is no browser-driven run against a deployed
  instance. The RLS suite covers the authorization behaviour an E2E suite
  would mostly be re-checking, and the component tests cover interaction, but
  a full sign-in-to-dashboard journey is untested.
- **The Edge Functions have no automated tests.** They need a Deno runtime and
  live credentials. Their logic is deliberately thin — verify caller, check
  role, write, audit — with the real rules in the database.
- **The deployed database has not been verified.** The policies are tested
  against the same migrations, but no Supabase project has been provisioned;
  run `get_advisors` after the first deploy.
