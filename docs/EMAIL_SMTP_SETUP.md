# RecoverEase email delivery — architecture and setup

RecoverEase sends its authentication email through **Supabase Auth with a
custom SMTP provider**. There is no application-level mail code, no mail
library, and no SMTP credential anywhere in this repository or in Vercel.
Turning email on is a configuration change in the Supabase dashboard, not a
deployment.

This mirrors the architecture already proven in CampusWear, which runs the
same Supabase-Auth-plus-custom-SMTP path in production. What was reused is
the shape of the solution; none of its code, business logic or data model is
here, and RecoverEase keeps its own Supabase project, users, roles, routes,
templates and branding.

## Why this and not an email service in the application

The alternative — a `send-email` Edge Function calling a provider's API —
would mean RecoverEase owning an API key, a retry policy, a bounce webhook,
a template renderer, and a second source of truth for who gets which message.
It would also duplicate what Supabase Auth already does correctly: minting and
verifying single-use recovery tokens.

Supabase Auth already sends every message RecoverEase needs and already
handles the tokens in them. The only thing missing is a delivery route to
addresses outside the Supabase organisation.

## What is actually broken today

Not the code. RecoverEase's password reset is fully implemented:

| Piece | Where | State |
|---|---|---|
| Request form | `/forgot-password` | built |
| `resetPasswordForEmail(email, { redirectTo })` | `src/features/auth/api.ts` | built |
| Reset form, expired/used link handling | `/reset-password` | built |
| Post-reset sign-out and message | `reset-password-page.tsx` | built |

Without custom SMTP, Supabase Auth **refuses to deliver to any address that is
not a member of the project's organisation**, failing with *"Email address not
authorized"*. A real patient therefore never receives the message, while the
application correctly shows its privacy-preserving "if that address exists,
we've sent a link" acknowledgement. Enabling custom SMTP is the entire fix.

## Onboarding: which model RecoverEase should use

Three models were considered. This is a product decision, so it is recorded
rather than made silently.

| Model | What it is | Verdict |
|---|---|---|
| **A. Email invitation + setup link** | Account created, user emailed a link, sets their own password | **Later, not now.** It is the better long-term model, but it changes `create-account`, the forced-setup gate and the clinician's workflow, and it makes onboarding depend on deliverability. A patient sitting in front of the clinician cannot finish onboarding if the mail is in Spam. |
| **B. Email the temporary credential** | Account created, passphrase emailed | **No.** It puts a live credential in plain text in an inbox and in provider logs, and it is strictly worse than handing it over in person. It also adds delivery as a failure mode without removing any step. |
| **C. In-person credential handover** *(current)* | Clinician reads the passphrase to the patient, forced change at first sign-in | **Keep as the default.** It works with no email at all, the credential never leaves the room, and the forced gate guarantees it is replaced. |

**Decision: keep C for onboarding, and use SMTP to enable password *recovery*
(and, later, model A).** Recovery is where email earns its place — it is the
one flow with no in-person alternative once the person has gone home. This
also satisfies the instruction not to remove the temporary-credential
workflow until a replacement is proven: nothing about onboarding changes here.

Model A becomes worth revisiting once delivery has been observed to be
reliable for real recipients, and it should then be added *alongside* handover,
not instead of it.

## What the project owner must configure

Nothing in this list is a code change, and none of it belongs in Git or Vercel.

### 1. A sender the clinic controls

Use a single-purpose address, `no-reply@<clinic-domain>`. Verify the domain
with the provider and publish its SPF, DKIM and DMARC records. A verified
domain is what keeps a clinical message out of Spam, and it makes a later
provider change invisible to users.

Until a domain is available, a provider's single-sender verification works for
testing, with the deliverability caveat below.

### 2. An SMTP provider

Supabase Auth works with any SMTP service. Documented options include Resend,
AWS SES, Postmark, Twilio SendGrid, ZeptoMail and Brevo. Volume for a clinic
is small — a few messages per patient per year — so free or entry tiers are
sufficient. Check the provider's current terms before committing.

Create the SMTP credential in the provider's dashboard and paste it **directly
into Supabase**. Treat it as a password: never in chat, never in a file, never
in a `VITE_*` variable.

### 3. Supabase dashboard settings

Project `kwsezszstdagzllbyjuk`.

| Location | Setting |
|---|---|
| Authentication → Email → SMTP Settings | Enable custom SMTP. Host, port (typically 587), username, password from the provider. Sender name: `RecoverEase`. |
| Authentication → URL Configuration | **Site URL:** `https://recoverease-web.vercel.app`. **Redirect URLs:** `https://recoverease-web.vercel.app/reset-password`, plus the same path on `recovereasedev.vercel.app` and `recoverease-zeta.vercel.app` while those aliases still serve. |
| Authentication → Rate Limits | Supabase drops to **30 emails/hour** automatically when custom SMTP is enabled. Keep a limit; raise it deliberately after watching real usage. Do not set it to unlimited. |
| Authentication → Providers → Email | Keep password recovery enabled. |
| Authentication → Attack Protection | Consider CAPTCHA before any public-facing form. RecoverEase has no public sign-up, so `/forgot-password` is the only unauthenticated form that triggers mail. |

The redirect allow-list matters: `requestPasswordReset` sends
`` `${window.location.origin}/reset-password` ``, so whichever host the user
opened is the host Supabase is asked to redirect to. An origin missing from
the allow-list produces a link that refuses to complete.

### 4. Environment variables

**None.** RecoverEase needs no new environment variable for email, in Vercel
or anywhere else. If a change to this document ever introduces one, that is a
signal the architecture has drifted.

Existing variables are unchanged: `VITE_SUPABASE_URL` and
`VITE_SUPABASE_PUBLISHABLE_KEY` are public by design; the service-role key and
the Gemini key stay in Supabase Edge Function secrets and are never exposed to
the browser.

### 5. Migrations

**None.** Email delivery touches no table, policy, trigger or function.

## Email templates

Templates live in **Authentication → Email Templates**. Keep them plain,
short and free of marketing. The audience includes elderly patients reading on
a phone.

Suggested **Reset password** body — the only template this change relies on:

> **Subject:** Reset your RecoverEase password
>
> Hello,
>
> Someone asked to reset the password for your RecoverEase account.
>
> **[ Choose a new password ]**  ← `{{ .ConfirmationURL }}`
>
> This link works once and expires in one hour.
>
> If you did not ask for this, you can ignore this email — your password will
> not change.
>
> RecoverEase

Rules for any template here:

- one action per message, as a clearly labelled link;
- say what the link does and how long it lasts;
- say what to do if it was not them;
- no clinical content, no patient name, no appointment or medication detail —
  email is not a private channel;
- no medical claims, no promotional content.

## Verifying it works

Do these against real, team-owned inboxes before telling anyone the feature
exists. Delivery is not proven by the absence of an error.

1. Request a reset from `/forgot-password` for a real address.
2. Confirm the provider's dashboard records the message as **delivered**, not
   merely accepted.
3. Open the link. It must land on `/reset-password` with a working form.
4. Set a new password; confirm the sign-in page then says the password is
   saved and that the new password works.
5. Re-open the **same** link. It must refuse — a used link is a dead link.
6. Wait for a link to expire and confirm it refuses in the same way.
7. Check Spam. A new sending domain often lands there first; that is a
   deliverability problem to solve with DNS records, not a code problem.
8. Confirm Supabase Auth logs show `user_recovery_requested` with status 200.

## Rollback

Disable custom SMTP in Authentication → Email → SMTP Settings. Delivery
returns to the default restricted mailer and the application behaves exactly as
it does today — recovery requests are accepted and never arrive for anyone
outside the organisation. No deployment, no revert, no data change.

Because none of this is in the application, an SMTP problem can never break
sign-in, the forced password gate, or in-person onboarding.

## What this does not solve

- **Deliverability is external.** A verified domain with SPF, DKIM and DMARC
  is the difference between the Inbox and Spam, and neither RecoverEase nor
  Supabase controls it.
- **Onboarding still requires a person.** Model A is not implemented.
- **No email is sent on account creation.** The registration dialog says so
  plainly, and that copy must stay accurate until model A actually ships.
