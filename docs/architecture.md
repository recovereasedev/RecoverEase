# Architecture

## What RecoverEase is

A recovery management platform for a clinic. Patients record how their
recovery is going and track their medication; doctors set treatment plans,
issue prescriptions and review progress; administrators manage accounts and
system configuration.

The scope comes from two source documents, treated as the specification:

- **List of Modules** (University of Cebu, College of Computer Studies,
  Table 31) — 14 modules as a per-role permission matrix.
- **User Interface Design** — the visual system.

Where those documents were silent, the assumption made is recorded in
[`database.md`](./database.md) or in the migration that implements it.

## The shape of the system

```
Browser (React SPA, Vercel)
  │
  ├── @supabase/supabase-js ──► PostgREST ──► PostgreSQL
  │                                             ▲
  │                                             └── Row Level Security
  │                                                 decides every read/write
  │
  └── supabase.functions.invoke ──► Edge Functions (Deno)
                                      • create-account   (service role)
                                      • chatbot-reply    (provider key)
```

There is no application server. The browser talks to PostgREST directly, and
the database decides what it is allowed to see. Two operations cannot work
that way and run in Edge Functions instead:

- **Account creation** needs the service-role key, which bypasses RLS.
- **The guidance chatbot** needs a provider credential, an administrator-set
  system prompt that the client must not be able to replace, and a
  critical-concern check the patient's browser must not be able to skip.

### Why not Next.js

The obvious alternative was Next.js with server routes on Vercel. It was
rejected because it produces **two backends**: Vercel functions for the
handful of privileged operations, plus Supabase for everything else — two
deployment targets, two secret stores, two places to look when a permission
is wrong. Putting the privileged code in Edge Functions keeps it next to the
data and the policies it depends on.

The cost is that there is no server-side rendering. For an application that
is entirely behind a login and holds no public content, that costs nothing;
the only public page is the landing page, which is static.

## Stack

| Concern | Choice | Why this one |
| --- | --- | --- |
| UI | React 19 + TypeScript (strict) | The team's stack; strict mode is non-negotiable for a system holding patient data |
| Build | Vite 8 | Fast, and its lazy-import splitting maps cleanly onto the role boundary |
| Styling | Tailwind CSS v4, CSS-first tokens | `@theme` puts the design tokens in one file that maps 1:1 onto the UI Design document |
| Server state | TanStack Query | Caching, invalidation and request states without hand-rolling them per page |
| Forms | React Hook Form + Zod | Uncontrolled inputs keep long clinical forms fast; Zod gives one schema for validation and types |
| Backend | Supabase | PostgreSQL, Auth, Edge Functions and Storage from one project |
| Authorization | PostgreSQL RLS | See [`security.md`](./security.md) |
| Tests | Vitest, RTL, PGlite | PGlite runs real PostgreSQL in-process, so RLS is tested rather than assumed |

## Directory layout

```
src/
├── app/                    Application wiring
│   ├── providers.tsx       Query client + auth provider
│   ├── router.tsx          The route table
│   └── routes/
│       ├── guards.tsx      RequireAuth, RequireRole, RedirectIfSignedIn
│       ├── lazy-pages.ts   Every route component, lazily imported
│       └── navigation.ts   Role-aware navigation config
├── components/
│   ├── ui/                 Primitives: Button, Field, Card, Dialog, Tabs…
│   ├── layout/             AppShell, PageHeader, brand mark
│   └── feedback/           StateView and the loading/empty/error states
├── features/               One directory per feature area
│   └── <feature>/
│       ├── api.ts          Typed Supabase queries
│       ├── hooks.ts        TanStack Query wrappers
│       ├── components/     Feature-specific components
│       └── pages/          Route components
├── lib/                    env, supabase client, format, status, utils
└── types/                  Generated database types
```

Features own their data access. A page imports its own feature's `api.ts` and
`hooks.ts`; it does not reach into another feature's internals. Cross-feature
data (a doctor's page showing recovery logs) goes through the owning
feature's exported hooks.

### What is deliberately not in here

- **No global client-state store.** Almost all state in this application is
  server state, which TanStack Query owns. The rest is local to a component.
  Adding Zustand or Redux would create a second place for the same data to
  live and go stale.
- **No repository/service layer over Supabase.** `api.ts` files call the
  typed client directly. An abstraction over PostgREST would hide the query
  shape without removing the dependency.

## Data flow

```
Component
  └─ useQuery(queryKeys.x.y, fetchX)   ← hooks.ts
       └─ supabase.from('table').select()   ← api.ts
            └─ PostgREST → RLS policy → rows
```

Query keys are declared centrally in `src/lib/query-keys.ts`. Keys written ad
hoc at each call site are how cache invalidation quietly stops working: one
file writes `['patients']`, another `['patient','list']`, and a mutation
invalidates half the screens showing that data.

**Queries do not repeat the authorization filter.** `fetchMyPatients` has no
`.eq('doc_id', me)` because the RLS policy already scopes the rows. Repeating
it would suggest the client is what protects the data, and would drift
silently if a policy changed.

## Rendering decisions

- **Route-level code splitting on the role boundary.** A patient never
  downloads the administrator's audit-log screen.
- **The landing page and auth pages are lazy too**, which keeps Zod and React
  Hook Form off first paint. See [`deployment.md`](./deployment.md) for the
  measured payload.
- **Forms take their initial values from component keys, not effects.**
  Copying server data into form state with `useEffect` renders an empty form
  first and can discard what the user typed in between.

### Installable app (PWA)

RecoverEase can be installed as an app (group QA 9/12/26, "Integrate PWM",
confirmed to mean a progressive web app). It is a thin layer over the same
site, not an offline copy of it.

- **Manifest.** `public/manifest.webmanifest` names the app "RecoverEase",
  with `start_url` and `scope` of `/`, `display: standalone`, theme colour
  `#004269`, background `#f9f9ff`, and 192 px, 512 px and 512 px maskable
  icons in `public/icons/`. It also declares a `related_applications` entry
  for itself — `platform: webapp`, pointing at the production manifest — which
  is the only thing a browser will match when asked whether RecoverEase is
  installed. `prefer_related_applications` is deliberately absent: it would
  tell the browser to offer that application instead of installing this one.
  `index.html` links the manifest, along with the theme colour and an Apple
  touch icon.
- **Service worker.** `public/sw.js`, registered by
  `src/lib/register-service-worker.ts` in production builds only, after the
  page has loaded, with `updateViaCache: 'none'` so the browser checks for a
  newer worker on every visit. A failed registration is ignored: the site
  works exactly as it does without one.
- **Offline behaviour.** Page loads always go to the network. Only when the
  network cannot be reached does the worker answer with `public/offline.html`,
  a self-contained page with no scripts, no external resources and no care
  information. That page is the only thing the worker stores.
- **Clinical data is never cached.** Requests to Supabase, sign-in and the
  app's own code are not intercepted, and no response is stored, so no
  patient record, token or session can end up in a cache. An installed app
  therefore still needs a connection to show any data.
- **Standalone installation.** With the manifest and worker in place, Chrome
  offers to install the site, which then opens in its own window without the
  browser's address bar. This was confirmed on a real installation in Chrome.
- **Offering it.** RecoverEase asks in its own popup rather than leaving the
  offer to the browser's own bar (`src/components/layout/install-app-prompt.tsx`,
  with the detection in `src/lib/pwa-install.ts`). The popup appears a moment
  after the page has loaded, on the way in only — the landing page and the
  auth pages, where the `PublicEntry` layout route mounts it — and never over
  a clinical screen or in a window that already is the installed app. Before
  it appears it also asks `navigator.getInstalledRelatedApps()`, which is what
  catches the person who installed RecoverEase and later opened the website in
  an ordinary tab: a window cannot see its own installation from the outside,
  but Chromium can. Every other browser has no such method, and every failure
  — a refusal, a rejected promise, an answer in an unexpected shape — is read
  as "not installed", so the offer behaves exactly as it did before. Pressing
  Install triggers the browser's installation and nothing else: it uses the
  `beforeinstallprompt` event the browser handed over, held from before the
  first render because Chrome offers it once and early. Chromium also decides
  for itself *when* to offer it, so an Install pressed before one has arrived
  waits `INSTALL_PROMPT_GRACE_MS` for it rather than concluding anything —
  treating "not here yet" as "cannot install" is what once put an installable
  Chrome in front of instructions it did not need. Only when no event is
  coming does the popup fall back, and to the true one of three: Share then
  Add to Home Screen on iPhone and iPad; the browser's own menu where the
  browser has the event but has not offered one here, which is what Chromium
  does once the app is installed; and "this browser cannot install
  RecoverEase" only where the browser has no installation of any kind. It
  never imitates an installation that is not happening. "Maybe Later" is
  remembered in `sessionStorage`, so the offer is answered for the visit and
  comes back on the next one; nothing about it is stored where it would
  outlive the visit.
- **Updates.** A changed `sw.js` (its `VERSION`) installs a new worker, which
  takes over immediately and deletes the previous worker's stored offline
  page. Because pages are never cached, a deployment is visible on the next
  load either way.

Covered by `tests/unit/pwa-manifest.test.ts`,
`tests/unit/service-worker.test.ts`,
`tests/unit/register-service-worker.test.ts`,
`tests/unit/pwa-install.test.ts`,
`tests/unit/install-app-prompt.test.tsx`, `e2e/pwa.spec.ts` and
`e2e/install-prompt.spec.ts`.

## Where the module list is implemented

| Module | Lives in |
| --- | --- |
| 1. Authentication & user access | `features/auth/` |
| 2. Registration & account management | `features/patients/`, `supabase/functions/create-account/` |
| 3. Treatment plan | `features/treatment-plans/` |
| 4. Medication | `features/medications/` |
| 5. Recovery monitoring | `features/recovery-logs/`, `features/doctor-notes/` |
| 6. Appointment management | `features/appointments/` |
| 7. Notification & communication | `features/notifications/` |
| 8. AI chatbot support | `features/chat/`, `supabase/functions/chatbot-reply/` |
| 9. Reports & analytics | `features/reports/` |
| 10. Admin dashboard | `features/dashboard/pages/admin-dashboard.tsx` |
| 11. Doctor account management | `features/patients/pages/admin-doctors-page.tsx` |
| 12. System announcements | `features/announcements/` |
| 13. Audit logs | `features/audit-logs/` |
| 14. System settings | `features/system-settings/` |
