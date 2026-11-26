# PayMongo sandbox subscriptions

Clinics move to Basic (PHP 999/month) or Premium (PHP 2,499/month) through a
PayMongo **test-mode** Checkout Session. No real money moves. Free needs no
payment. Enterprise is custom-priced and has no online checkout: its agreed
price is stored on the clinic's subscription, and its payments are recorded
by an operator.

Facts about PayMongo below come from its official documentation
(docs.paymongo.com, read 2026-11-27): Checkout Sessions, Webhooks ("Securing
a webhook"), and Payment acceptance testing.

## How it works

1. The Clinic Admin picks Basic or Premium on **Settings → Subscription**.
   The browser sends only `{ action: 'create', plan }` to the
   `paymongo-checkout` Edge Function. JWT verification is on for this function.
2. The function confirms the caller is a Clinic Admin of an active clinic,
   reads that clinic from the database, and reads the price from
   `subscription_plan` (`billing_checkout_quote`). It then creates a Checkout
   Session (`POST /v1/checkout_sessions`, one line item in centavos, card
   payments). It records the checkout as a **pending** `subscription_payment`,
   priced again by the database, and returns only PayMongo's
   `checkout_url`. The browser goes to `checkout.paymongo.com`.
3. PayMongo signs and sends `checkout_session.payment.paid` (or
   `payment.failed`) to `paymongo-webhook`, which has JWT verification off.
   The webhook checks the signature over the raw body, then calls
   `billing_handle_webhook_event`. In one transaction, that function records
   the event id (a repeat is a no-op), checks the amount and currency against
   the pending row, marks it **paid**, and activates the plan for one month.
   Paying again for the same plan extends the period by a month. Paying for
   the other plan replaces the current plan.
4. PayMongo returns the browser to `/admin/settings?billing=success` or
   `?billing=cancelled`. That parameter is only a cue. The page asks
   `paymongo-checkout` to `check` or `cancel`, and the function reads the
   session back from PayMongo with the secret key. It applies the payment only
   if PayMongo lists a paid payment. If the session is unpaid and the action
   is `cancel`, it expires the session at PayMongo and records the payment as
   **cancelled**.
5. A job (`expire_lapsed_subscriptions`, pg_cron, every 15 minutes) moves a
   lapsed Basic or Premium period to `expired` and puts the clinic back on
   Free.

Recurring automatic charges are **not** used. Checkout Sessions are one-time,
and PayMongo's Subscriptions API needs account enablement by PayMongo. Each
month is a new one-time checkout ("Renew for one more month").

## Secrets (names only)

| Name | Where | Value shape |
| --- | --- | --- |
| `PAYMONGO_SECRET_KEY` | Edge Function secret | `sk_test_…` (a live `sk_live_…` key is refused by the code) |
| `PAYMONGO_WEBHOOK_SECRET` | Edge Function secret | `whsk_…`, returned when the webhook is created |

Never put either one in a `VITE_` variable, `.env.example` values, the repo or
a document. The browser never needs a PayMongo key.

## Sandbox setup

Every step below is a production configuration step and **needs Kean's
approval first**. Migration 68 must be applied before the functions are
deployed.

1. Create or sign in to a PayMongo account. In the dashboard, switch to
   **Test mode** and copy the test secret key (`sk_test_…`).
2. Set the secret:
   `npx supabase@2.121.0 secrets set PAYMONGO_SECRET_KEY=<sk_test_…> --project-ref <ref>`
   Type the value into your own terminal, never into a file or a chat.
3. Deploy the functions:
   - `npx supabase@2.121.0 functions deploy paymongo-checkout --project-ref <ref> --use-api`
   - `npx supabase@2.121.0 functions deploy paymongo-webhook --project-ref <ref> --use-api --no-verify-jwt`
4. Create the test-mode webhook (`POST https://api.paymongo.com/v1/webhooks`
   with Basic auth `sk_test_…:`). Use the URL
   `https://<ref>.supabase.co/functions/v1/paymongo-webhook` and the events
   `checkout_session.payment.paid` and `payment.failed`. Copy the
   `data.attributes.secret_key` (`whsk_…`) from the response, then run
   `secrets set PAYMONGO_WEBHOOK_SECRET=<whsk_…>`.

## Testing success, failure and cancellation

Use PayMongo's published test cards with any future expiry and any 3-digit CVC:

| Outcome | Card |
| --- | --- |
| Success | `4343434343434345` (Visa) or `5123000000000002` (Mastercard) |
| Success with 3-D Secure | `4120000000000007`, then choose **Authorize** |
| Failure, 3-D Secure | `4120000000000007`, then choose **Fail** |
| Declined | `4111111111111111` (generic decline), `5100000000000198` (insufficient funds) |

- **Success:** pay, and you return to Settings, which shows "Payment
  successful". The Super Admin overview counts the clinic under the plan, and
  the revenue figures rise by the plan's price.
- **Failure:** use a decline card. The payment shows **Failed**. The plan does
  not change and revenue does not move. You can retry on the same checkout.
- **Cancellation:** use the checkout's back or cancel link. Settings shows
  "Payment cancelled", the session is expired at PayMongo, and the payment
  shows **Cancelled**.
- **Abandoned:** close the tab. The payment stays **Pending** and never
  counts. PayMongo does not expire sessions on its own and sends no event when
  one expires.

## Verifying webhook delivery

- PayMongo dashboard (test mode): Developers → Webhooks → the endpoint's
  delivery log shows each event and the HTTP status. Expect 200; a 401 means
  the signature was rejected, which usually means the wrong `whsk_` secret.
- Supabase: Edge Function logs for `paymongo-webhook` show one line per
  event, with the event type and result only (`activated`, `duplicate`,
  `marked_failed`, `amount_mismatch`, `livemode_not_accepted`, …).
- Database (read-only):
  `select event_type, processing_status, processing_result, event_processed_at from public.paymongo_webhook_event order by event_received_at desc limit 20;`

PayMongo retries a failed delivery up to 12 times. It disables a webhook
after three consecutive events exhaust their retries, and it never re-sends
missed events. If the webhook is down, the return page's `check` still
confirms a paid checkout from PayMongo directly.

## Resetting sandbox test data safely

Only with approval, only test-mode rows, and after a dump of the four tables.
Paid rows are revenue history. Delete them only in a test project, never in a
database with real clinics:

```sql
begin;
delete from public.paymongo_webhook_event;
delete from public.subscription_payment;
-- Put every clinic back on Free (one active row per clinic).
update public.clinic_subscription set subscription_status = 'expired'
 where subscription_status = 'active' and plan_code <> 'free';
insert into public.clinic_subscription (clinic_id, plan_code, subscription_status, subscription_billing_interval)
select c.clinic_id, 'free', 'active', 'forever' from public.clinic c
 where not exists (select 1 from public.clinic_subscription s
                    where s.clinic_id = c.clinic_id and s.subscription_status = 'active');
commit;
```

## Switching to live credentials later (separate, not part of this work)

Going live is its own change and needs its own approval. Live mode is
blocked in code today: `isTestSecretKey` refuses `sk_live_` keys,
`verifyWebhookSignature` checks only the `te` (test) signature, and the
database refuses any event with `livemode = true`. A live switch therefore
needs a code change that accepts live keys, compares `li` for live events and
accepts live events in `billing_handle_webhook_event`. It also needs a live
webhook with its own `whsk_` secret, PayMongo account activation, and a
review of refunds, receipts and the grace period (decision 11).
