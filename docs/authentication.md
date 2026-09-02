# Authentication

## There is no public sign-up

This is the single most consequential fact about the system, and it comes
straight from the module specification:

| Module | Patient | Doctor | Admin |
| --- | :---: | :---: | :---: |
| 1.1 Account Creation | | ✱ | ✱ |
| 1.2 Login / Logout | ✱ | ✱ | ✱ |
| 1.3 Reset Password | ✱ | ✱ | ✱ |
| 1.4 Role-Based Access Control | ✱ | ✱ | ✱ |
| 1.5 Capture Data Privacy Consent | ✱ | | |
| 2.1 Register Doctor Account | | | ✱ |
| 2.2 Register Patient Account | | ✱ | |

Administrators create doctor accounts; doctors create patient accounts.
Patients never create their own. Consequences that run through the whole
application:

- **No `/sign-up` route exists.** The landing page says so plainly, because a
  sign-up button that cannot work is worse than its absence.
- **Account creation needs the service-role key**, so it runs in an Edge
  Function, never the browser.
- **Sign-in failure copy points at the care team**, not at a registration
  link.
- **`patient.pat_consent_at` is captured on first sign-in** (module 1.5), not
  at registration — the patient was not present when their account was made.

## Provisioning flow

```
Administrator ──► create-account (kind: doctor)  ──► auth user + user_account + doctor
Doctor        ──► create-account (kind: patient) ──► auth user + user_account + patient
                                                      │
                                                      └─► invitation email
                                                            └─► patient sets own password
```

The Edge Function:

1. Verifies the caller's access token against Supabase Auth. The caller is
   never identified by a user id in the request body.
2. Reads their role from `user_account` — not from JWT metadata.
3. Enforces which role may create which: admin → doctor, doctor → patient.
4. Creates the auth user **without a password**. The account holder is invited
   and chooses their own, so a clinician never knows a patient's credentials
   and can never be asked to hand them over.
5. Takes the assigned doctor **from the verified caller**, never from the
   payload — otherwise one clinician could assign patients to another and gain
   a read path into their caseload.
6. Deletes the auth user if a later insert fails, so a failed attempt does not
   leave an email claimed by an account that can sign in but has no profile.

## Session resolution

`AuthProvider` resolves a Supabase session into an `AppUser`, and distinguishes
states that need different screens rather than collapsing them into "logged
out":

| State | Meaning | What the user sees |
| --- | --- | --- |
| `loading` | Session being resolved | A wait indicator — **never** a redirect. Redirecting here would bounce a signed-in user to the login page on every hard refresh. |
| `signed-out` | No session | Sign-in page, with the attempted path remembered |
| `signed-in` | Session and profile resolved | The application |
| `blocked: not-provisioned` | Authenticated but no `user_account` | "Your account is not set up yet", pointing at the care team |
| `blocked: doctor-deactivated` | Module 11.3 revoked the account | An explanation. The database already returns zero patients; this turns a confusing empty dashboard into a reason. |
| `blocked: profile-missing` | Role row absent | A data fault, named as one |
| `error` | The lookup failed | An error with a retry |

### Race protection

Auth events can arrive while a profile fetch is in flight — a token refresh
during initial load, for instance. Each resolution carries a sequence number
and only the most recent is allowed to land; otherwise a slower response can
overwrite a newer one and leave the app showing a stale identity.

`TOKEN_REFRESHED` is ignored entirely. It fires on a timer and does not change
who is signed in, so re-resolving on it would refetch the profile every hour
and could flash a loading state over a working screen.

### Sign-out clears locally first

The local state is cleared before the network call, so the UI never appears
signed in after the click even if the request is slow or fails.

## The consent gate

Module 1.5. Wraps **every** patient route rather than redirecting from the
dashboard, so it cannot be stepped over with a deep link. `pat_consent_at`
stays `NULL` until accepted.

There is deliberately no "decline and continue": consent to record health
information is either given or the account is not used. Signing out is offered
as the honest alternative.

## Password rules

`newPasswordSchema` requires **12 characters minimum** and nothing else.

Composition rules (one uppercase, one digit, one symbol) push people towards
`Password1!`, which is weaker than a longer passphrase and much harder to
remember. Current NIST guidance is to require length and screen against known
breached values rather than mandate character classes.

Sign-in validation only checks that a password was entered. Telling someone
their password is "too short" while they are trying to log in with a correct
old one is unhelpful, and enumerating the policy on a login form leaks it.

## Password reset

1. `/forgot-password` calls `resetPasswordForEmail`.
2. The confirmation is deliberately **ambiguous** — "if an account exists for
   that address" — so the page cannot be used to discover who is registered.
3. The emailed link lands on `/reset-password`, where Supabase has already
   exchanged the token for a recovery session. No session means an expired or
   used link, and the page says so instead of showing a form that cannot work.
4. After a successful change the recovery session is **ended**, so the new
   password is actually used rather than the user continuing on a session
   granted by an email link.

`/reset-password` is the one authenticated-ish route not wrapped in
`RedirectIfSignedIn` — it always carries a recovery session, so redirecting
"signed-in" users would make the link impossible to use.

## Route guards

| Guard | Behaviour |
| --- | --- |
| `RequireAuth` | Waits on `loading`, redirects on `signed-out`, explains on `blocked` |
| `RequireRole` | Sends a user on the wrong branch to **their own home**, not to an error page — landing on the wrong dashboard is a navigation mistake, and the database refuses the data regardless |
| `RedirectIfSignedIn` | Sends a signed-in user from the landing or sign-in page to their dashboard |

All are covered in `tests/unit/route-guards.test.tsx`.
