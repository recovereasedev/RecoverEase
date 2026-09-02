# Testing

```bash
npm test              # unit + database — 149 tests
npm run test:unit     # component and pure-function tests (jsdom)
npm run test:db       # schema and RLS tests (real PostgreSQL)
npm run test:e2e      # browser journeys — 42 tests (Playwright)
npm run verify        # lint + typecheck + test + build
```

## Two suites, two environments

Vitest is split into projects because the two kinds of test need different
worlds:

| Project | Environment | Tests |
| --- | --- | --- |
| `unit` | jsdom | Component behaviour, pure domain logic |
| `db` | node | Schema, constraints, RLS policies |

Playwright runs a third suite in a real browser; see *Browser journeys* below.

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
  select nullif(
    coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::json ->> 'sub',
    ''
  )::uuid
$$;

create role anon; create role authenticated; create role service_role;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
```

Note what is **not** granted: `SELECT` on `auth.users`. A signed-in role can
resolve its own id and nothing more, matching production.

### The `coalesce` is load-bearing, and was added after a real finding

An unauthenticated request leaves `request.jwt.claims` empty, and casting
`''` to `json` raises *invalid input syntax for type json*. That error
surfaced as a **thrown query** — which a denial-checking assertion happily
accepts as a refusal.

So every anonymous test had been passing without RLS refusing anything. The
policies were in fact correct, but the tests were not proving it. Returning
`NULL` cleanly forces the policies themselves to do the denying, which is
what those assertions were supposed to be checking all along.

It surfaced because a later suite ran an `UPDATE` whose audit trigger calls
`auth.uid()` outside a policy, where the same error was fatal rather than
conveniently interpreted as a denial.

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

### What the 89 database tests cover

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
| Medication reminders | One reminder per dose however often the scheduler fires; honours the opt-out and preferred time; reaches only the dose owner; slot generation idempotent; doses generated at clinic-local wall-clock time; the functions refuse `authenticated` and `anon` |

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

71 component and unit tests, chosen for logic that can be silently wrong rather than for
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

## Browser journeys (Playwright)

42 tests against a **production build** served by `vite preview` — not the dev
server. The dev server transforms modules on demand and chunks differently, so
testing it would leave the artefact that actually ships unexercised, including
the lazy route chunks where a code-splitting mistake shows up.

Two projects: `desktop` (Chrome) and `mobile` (Pixel 7). The mobile project
runs only `responsive.spec.ts`, and the desktop project explicitly ignores it —
asserting a bottom bar at desktop width would fail on something correctly
absent.

### What the browser suite covers

| Area | Examples |
| --- | --- |
| Public pages | Landing states there is no public sign-up and offers no sign-up link; unknown paths reach the not-found page |
| Sign in | Field-level validation; the failure message does not distinguish an unknown address from a wrong password; password reveal; landing on the correct role home |
| Route guards | Four protected paths redirect a signed-out visitor; a patient on an admin route is sent home; a signed-in user is moved off the landing page |
| Session | Survives a hard reload without bouncing to sign in; signing out locks the app again |
| Consent gate | Blocks a patient who has not consented, including via a deep link; releases once accepted |
| Patient | Logs a day and sees it in the journal; marks a dose taken; confirms an appointment; books a follow-up; requests a reschedule; Escape closes a dialog |
| Doctor | Caseload lists only their own patients; search; keyboard tab navigation on a patient record; writes a clinical note; registration dialog has no password field |
| Administrator | No patient section in navigation; dashboard shows counts and no patient name; audit log shows changed column names and not values; deactivates a doctor; cannot reach a patient screen by URL |
| Chatbot | With the Edge Function unavailable, the UI says so and keeps the patient's message rather than inventing a reply |
| Responsive | No horizontal scroll on a phone; bottom bar capped at five items; drawer opens and closes on Escape; tables become cards; touch targets clear 44px |

### What the browser suite deliberately does not test

**Authorization.** Supabase endpoints are intercepted and answered by a
PostgREST-shaped stub, so no policy is evaluated. That is not a shortcut, it
is the correct division: pointing a browser at a stub proves the interface
behaves; pointing SQL at PostgreSQL proves the data is protected. Testing
authorization through a stub would only prove the stub agrees with itself.

The stub answers *per principal* — a doctor's dataset contains only their own
patients, an administrator's contains no patient rows — so the browser tests
assert what each role is actually shown, without pretending to enforce it.

### Two real defects this suite found

Both were invisible to jsdom tests and to manual clicking.

1. **A missing timestamp blanked an entire route.** `date-fns` `format()`
   throws `RangeError` on an invalid date. Called during render, that reached
   the router's error boundary and replaced the whole screen. Every formatter
   in `src/lib/format.ts` now degrades to `—`: a clinician losing a patient
   record because one value was null is far worse than a dash where a time
   should be.

2. **A save confirmation could never appear.** The recovery entry form is
   keyed on the saved entry's id so its initial values come from props rather
   than an effect. A successful save assigns that id, which changed the key
   and remounted the component — wiping the local "Saved." flag before it
   rendered. The confirmation now lives with the mutation that owns it.

## Defects that only the live database found

Two bugs survived every local suite and were caught by running against a real
Supabase project. Both are the same shape: a behaviour that is only wrong when
two clocks, or two engines, disagree — and the local harness had neither
disagreement.

1. **Doses generated eight hours early.** A schedule of 08:00 and 20:00 with
   `app.timezone = Asia/Manila` materialised at 00:00 and 12:00 Manila.
   `generate_series(date, date, interval)` resolves to the **timestamptz**
   overload, so the series value was already zone-aware and `AT TIME ZONE`
   converted *out* of the zone instead of into it. PGlite resolved the overload
   differently, so the assertion passed locally and failed on real PostgreSQL.
   Fixed by casting the series value to `date` (migration 13). The test now
   asserts the full set of dose times rather than only the earliest.

2. **Patients could not log their recovery entry for eight hours a day.**
   Saving the daily entry returned `23514` — "A recovery log cannot be dated in
   the future" — for any patient logging between midnight and 08:00 local. The
   database runs in UTC; the browser sends the patient's *local* date on
   purpose; the guard compared the two. For the first eight hours of every
   Manila day they disagreed and the guard read the patient's own today as
   tomorrow. This broke the single most important daily action in the product,
   during the morning, which is when a recovery app is most used. Fixed by
   resolving every calendar date through `public.app_today()` (migration 14).

Why no local suite could have caught the second one: every test ran the
database and the assertions on one clock and built dates with `current_date`,
so client and server always agreed — which is precisely the condition under
which the bug does not exist. `tests/db/application-timezone.test.ts` now pulls
the clocks apart deliberately, pinning the server to `Pacific/Niue` (UTC-11)
and the clinic to `Pacific/Kiritimati` (UTC+14). That 25-hour spread is wider
than a day, so the clinic's date is strictly ahead of the server's at *every*
instant — the mismatch is exercised on every run rather than during a lucky
window. The tests were confirmed to fail against the pre-fix schema and pass
against the fixed one.

The general lesson is not that the tests were weak. It is that a compatibility
layer can differ from the engine on overload resolution, and that a suite whose
clocks all agree cannot test clock disagreement. Both are reasons live
verification is a separate phase rather than a formality.

## What is not covered

Stated plainly rather than implied:

- **The Edge Functions have no automated tests.** They need a Deno runtime and
  live credentials. Their logic is deliberately thin — verify caller, check
  role, write, audit — with the real rules in the database. Both functions were
  confirmed to boot and to reject unauthenticated calls in production, but the
  guidance-chatbot model path has never been executed: it needs
  `ANTHROPIC_API_KEY` and `ALLOWED_ORIGINS`, neither of which is set.
- **The browser suite runs against a stub, not a server.** Playwright drives a
  local production build with Supabase intercepted, so it tests the client's
  behaviour and not the database's. Anything enforced by a trigger or a policy
  is invisible to it — which is why it could not have found either defect
  above.
- **Load, concurrency and long-horizon scheduling are untested.** The pg_cron
  jobs have been confirmed to be registered and the dose generator to be
  idempotent on a second run, but no test covers a month of accumulated
  scheduling or simultaneous writers beyond the single duplicate-guard case in
  the reminder tests.
