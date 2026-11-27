# PayMongo sandbox staging

PayMongo sandbox testing happens in a separate Supabase staging project that
holds only synthetic records. It never happens in production. A sandbox
payment is never revenue (migration 69), but it still changes the paying
clinic's plan. Run against production, it would change Harborview's real
subscription.

Status (2026-11-27):
- **No staging project exists.** The Supabase org has only production
  (`kwsezszstdagzllbyjuk`) and no branches; branching needs the Pro plan.
- **Production:** 68 and 69 are applied, the two PayMongo functions are
  **not** deployed, and there are no `PAYMONGO_*` secrets.

The kit:

| File | What |
| --- | --- |
| `supabase/staging/00-default-privileges.sql` | Gives a new project production's default grants. It refuses unless `public` is empty. |
| `scripts/staging/apply-staging-migrations.ps1` | Applies the privileges file, then every migration production has (all but 34). It refuses the production ref and the production-linked main checkout. |
| `supabase/staging/seed-synthetic.sql` | Renames the clinic to "Staging Synthetic Clinic" and makes one Clinic Admin. It refuses any database with patients, doctors or other accounts. |
| `supabase/staging/verify-billing.sql` | Read-only billing state. `live_revenue_centavos` must stay 0. |
| `scripts/staging/paymongo-webhook-checks.ts` | Sends signed synthetic events to the staging webhook (signature, live mode, tampering, duplicates). It refuses the production ref. |
| `tests/db/staging-setup.test.ts` | Proves all of the above offline: production's migration set replays, the seed works, and every scenario ends as stated below. |

## Rules

- **Staging only.** Every staging command names the staging ref explicitly.
  Never run one from the main checkout: its Supabase link is production. Use
  a worktree.
- **No live values, no secrets in files.**
  - Use only `sk_test_…` keys (the code refuses `sk_live_…`) and the test
    webhook's `whsk_…` secret.
  - Type secrets into your own terminal. Never put one in a file, a commit, a
    chat or a `VITE_` variable.
- **Test from local dev, not a Vercel preview.** Previews talk to
  production Supabase.
- **Synthetic only.** No real person's name or email on staging; use
  `.test` addresses. Staging holds no patient or clinical record.

## 1. Create the staging project (you; nothing is created for you)

The org is a Vercel Marketplace org, so new projects are made from the
Vercel dashboard:

1. Go to Vercel → **Storage** → **Create Database** → **Supabase**.
2. Fill in:
   - Name: `recoverease-staging`
   - Region: **Southeast Asia (Singapore), ap-southeast-1**, the same as
     production.
   - Plan: **Free**. Check the screen shows no charge before you confirm.
     The Free org allows two active projects.
3. **Do not connect it to the `recoverease` Vercel project**; skip or
   untick every project. A connection would sync the staging URL and keys
   into the live website's environment variables.
4. In the new project's Supabase dashboard:
   - Note the **project ref**: 20 letters, from `https://<ref>.supabase.co`.
   - Note the **publishable (anon) key** from Project Settings → API.
   - Under **API Keys**, make sure the **legacy** anon and service_role keys
     are enabled. The Edge Functions read `SUPABASE_ANON_KEY` and
     `SUPABASE_SERVICE_ROLE_KEY`.
5. **Authentication → URL Configuration:** Site URL
   `http://localhost:5173`.
6. **Authentication → Users → Add user:**
   - Email `staging.clinic.admin@recoverease.test`
   - A password you choose (keep it in your password manager)
   - Auto-confirm on

## 2. Build the schema (migration compatibility)

Staging gets exactly production's migrations: all 55 files except 34
(`lift_single_clinic_gate`, held in production). That keeps the single-clinic
gate, as production has it. Migrations 68 and 69 are in the set.

From a worktree of this branch, run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/staging/apply-staging-migrations.ps1 -ProjectRef <staging ref>
```

It asks you to type the ref again, applies the privileges file and the 55
migrations one by one, and stops at the first failure. Never re-run an
applied file; the privileges step refuses a second run.

Compatibility evidence:
- **68 and 69** were applied to a restored copy of production's backup on
  local PostgreSQL 17, and then to production itself (68 at 2026-11-26
  22:48Z, 69 at 2026-11-27 04:33Z), with every check passing.
- **The full set without 34** replays cleanly in `tests/db/staging-setup.test.ts`.
- **The privileges file** reproduces production's `pg_default_acl` for anon,
  authenticated and service_role (checked on local PostgreSQL 17).
- **pg_cron:** available on Supabase, so staging schedules the same 8 jobs
  as production. With no patients they do nothing.

Then seed it. In the staging SQL editor, or from the worktree:

```powershell
npx supabase@2.121.0 db query --linked --project-ref <staging ref> -f supabase/staging/seed-synthetic.sql
```

The CLI links the folder it runs in; afterwards, `Remove-Item -Recurse supabase/.temp`.
After seeding, `verify-billing.sql` should show one active `free` plan for
"Staging Synthetic Clinic", no payments, `live_revenue_centavos` 0 and
`patients` 0.

## 3. Edge Functions and secrets (staging only)

Functions (deploy from this branch's worktree):

| Function | JWT verification | Command |
| --- | --- | --- |
| `paymongo-checkout` | **on** | `npx supabase@2.121.0 functions deploy paymongo-checkout --project-ref <staging ref> --use-api` |
| `paymongo-webhook` | **off** (PayMongo cannot send a Supabase JWT; the HMAC signature on the raw body replaces it) | `npx supabase@2.121.0 functions deploy paymongo-webhook --project-ref <staging ref> --use-api --no-verify-jwt` |

Environment variable names (values never written down):

| Name | Set by | Value shape |
| --- | --- | --- |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase, automatically | legacy keys must be enabled |
| `PAYMONGO_SECRET_KEY` | you, in step 4 (from a masked prompt, never typed on the command line) | `sk_test_…` only; anything else gives 503 "Online payment is not set up yet" |
| `PAYMONGO_WEBHOOK_SECRET` | you, after step 4 | `whsk_…`; anything else gives 503 |
| `ALLOWED_ORIGINS` | not needed | `http://localhost:5173` is always allowed |

Check names only: `npx supabase@2.121.0 secrets list --project-ref <staging ref>`
prints names and digests, never values.

## 4. PayMongo test-mode webhook

1. **Account:** in the PayMongo dashboard, switch to **Test mode** and copy
   the test secret key.
2. **Set the key and register the webhook** from your own terminal. The key
   goes in through a masked prompt, so it never appears on screen or in
   PowerShell's history:

   ```powershell
   $sk = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR((Read-Host 'sk_test_ key' -AsSecureString)))
   if ($sk -notlike 'sk_test_*') { throw 'Not a test key' }
   npx supabase@2.121.0 secrets set "PAYMONGO_SECRET_KEY=$sk" --project-ref <staging ref>
   $auth = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("${sk}:"))
   $body = '{"data":{"attributes":{"url":"https://<staging ref>.supabase.co/functions/v1/paymongo-webhook","events":["checkout_session.payment.paid","payment.failed"]}}}'
   $r = Invoke-RestMethod -Method Post -Uri https://api.paymongo.com/v1/webhooks -Headers @{ Authorization = "Basic $auth" } -ContentType 'application/json' -Body $body
   $r.data.id; $r.data.attributes.livemode   # expect wh_… and False
   ```

3. **Secret:** set the returned secret without printing it:
   `npx supabase@2.121.0 secrets set "PAYMONGO_WEBHOOK_SECRET=$($r.data.attributes.secret_key)" --project-ref <staging ref>`.
   Then clear it: `Remove-Variable sk, auth, r`.
4. **Events:** register only `checkout_session.payment.paid` and
   `payment.failed`. The webhook must report `livemode: false`.

## 5. Run the website against staging

In the worktree, create `.env.local` (gitignored) with
`VITE_SUPABASE_URL=https://<staging ref>.supabase.co` and
`VITE_SUPABASE_PUBLISHABLE_KEY=<staging publishable key>`. Then run
`npm run dev`, open `http://localhost:5173`, sign in as
`staging.clinic.admin@recoverease.test`, and go to **Settings →
Subscription**. Never put staging values in Vercel.

## 6. Sandbox tests

After each test, run `supabase/staging/verify-billing.sql` on staging.
`live_revenue_centavos` must stay **0** and `patients` **0** throughout.
Test cards are the ones in `docs/paymongo-sandbox.md`.

| # | Test | How | Expected on staging |
| --- | --- | --- | --- |
| 1 | Successful Basic | Subscribe to Basic; pay with `4343434343434345` | Return page "Payment successful"; plan `basic`, one month; a `paid` payment of 99900 with `payment_livemode` false; event `processed/activated`; **revenue 0** |
| 2 | Successful Premium | Subscribe to Premium; pay with `5123000000000002` | Plan `premium` (Basic `replaced`); paid 249900; **revenue 0** |
| 3 | Failed payment | Subscribe; pay with `4111111111111111` (decline) | Payment `failed` (event `payment.failed` → `marked_failed`); plan unchanged |
| 4 | Cancelled | Subscribe; use the checkout's back/cancel link | "Payment cancelled"; payment `cancelled`; session expired at PayMongo; plan unchanged |
| 5 | Abandoned | Subscribe; close the PayMongo tab | Payment stays `pending`; no event; plan unchanged |
| 6 | Invalid signature | `paymongo-webhook-checks.ts` (below) | HTTP 401 for no signature, a wrong secret, a live-only signature and a body changed after signing; nothing recorded |
| 7 | Amount tampering | the same script, on a pending checkout | HTTP 200; event `ignored/amount_mismatch`; plan unchanged. The browser cannot send an amount at all: `paymongo-checkout` reads only `{ action, plan }` and prices from the database. |
| 8 | Duplicate webhook | the same script with `--activate`, or resend a delivered event from PayMongo's webhook log | First `activated`, then `duplicate`; one paid row, one activation |

For tests 6–8, start a checkout and close the tab (test 5) to get a pending
checkout id and amount from `verify-billing.sql`, then run:

```powershell
$env:STAGING_PROJECT_REF = '<staging ref>'
$env:PAYMONGO_WEBHOOK_SECRET = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR((Read-Host 'whsk_ secret' -AsSecureString)))
node --experimental-strip-types scripts/staging/paymongo-webhook-checks.ts --checkout <cs_…> --amount <centavos>
```

It prints one PASS/FAIL line per check and never prints the secret. Add
`--activate` for test 8: it activates the plan on the synthetic clinic
without PayMongo charging a card.

## 7. Why test payments never reach live revenue or Harborview

- **Revenue:**
  - The overview counts a payment only when it is `paid` and
    `payment_livemode` is true (migration 69). Nothing writes true.
  - The webhook refuses live-mode events (`livemode_not_accepted`).
  - The code refuses `sk_live_` keys and checks only the test-mode (`te`)
    signature.
- **Harborview is in another project.** Staging's clinic is migration 29's
  row in a different database, renamed "Staging Synthetic Clinic". A
  staging checkout can only reach staging's database: the function uses
  staging's own `SUPABASE_URL` and service key, and takes the clinic from
  the signed-in staging Clinic Admin.
- **Production cannot take a checkout today:**
  - `paymongo-checkout` and `paymongo-webhook` are not deployed there
    (functions: complete-password-setup, create-account, chatbot-reply,
    reset-account-password).
  - It has no `PAYMONGO_*` secret (checked 2026-11-27), so even a deployed
    function would answer 503.
- **Remaining gap:** nothing in code stops someone deploying the sandbox
  functions to production with an `sk_test_` key. That would let a test
  card change Harborview's plan (not revenue). Until live payments are
  designed, the rule is: never deploy `paymongo-*` to production.

## 8. Teardown

Use the reset SQL in `docs/paymongo-sandbox.md` on staging only, or delete
the staging project from its dashboard (Settings → General → Delete
project). Delete the staging webhook in the PayMongo dashboard (test mode)
too.
