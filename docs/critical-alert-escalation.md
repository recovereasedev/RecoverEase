# Critical alerts when the patient's doctor is deactivated

**Status: not in the coming release.** Option C is recommended and built on
this branch, but the product owner has not confirmed it, and on 2026-10-21
kept it out of the release. The three
[open questions](#open-questions-for-the-product-owner) below are release
blockers: it does not go out until each is decided. Nothing is applied or
deployed. Migration 40 and the `chatbot-reply` change each need their own
approval before they go out (see [Release](#release)).

## The gap

When a reply from the guidance assistant raises a critical concern (modules
8.2 and 8.3), `chatbot-reply` flags the conversation and sends a
`chat_critical` notification to the patient's assigned doctor. It looked up
that doctor's account **without checking `doc_is_active`**. The
review-request path in the same function, used when the assistant fails to
answer, does check it.

Decision D8 (migration 30) says that deactivating a doctor withdraws their
access at once, and their patients stay assigned to them until a Clinic Admin
moves them. In that window:

- the alert went to a doctor who can no longer open the conversation, so in
  practice it reached no clinician;
- the patient's chat page said: *"Something you raised in this conversation
  was flagged for your doctor, and they have been notified."* That was false
  in this window. It was also false whenever the notification insert failed,
  because the failure was only logged.

## Rules every option has to keep

- **No patient text in logs.** Log lines carry an outcome and a request id,
  never the message or the reply.
- **No clinical detail in a notification row.** An administrator in
  particular must learn nothing about a patient from one. Administrators
  cannot read patient records. The database enforces that, and a
  notification must not get around it.
- **Review requests stay deduplicated:** one unread request per conversation.
- **Only active clinicians see patient data.** No option may open a
  conversation to someone the access model would refuse.
- **Never tell the patient something that did not happen.**

## Options

### A. Notify the clinic's administrators

When the doctor is inactive, send each of the clinic's Clinic Admins a
`chat_critical` notification. It names no patient, says nothing about the
concern, and links to no conversation.

- **For:** immediate. Changes only the edge function, with no migration.
- **Against:** a Clinic Admin cannot read the conversation and cannot act
  clinically. Their only useful move is D8: reassign the patients, or
  reactivate the doctor. After they do, **the new doctor is never told**. The
  conversation is flagged, but nothing puts it in their *Needs attention*
  worklist. The notification is also transient: once it is marked read,
  nothing records that a concern is still waiting. If the clinic has no
  administrator, nobody is told at all.

### B. Hold the alert as undelivered, shown on an admin screen

Record against the conversation that its alert is waiting for a clinician.
Show the count against the deactivated doctor on the Doctor accounts screen,
beside the *Reassign patients* button.

- **For:** durable. The count stays until the alert is delivered. It sits
  where the fix is, and it can drive delivery (see C).
- **Against:** passive. Nobody hears about it until someone opens that
  screen, so a concern could wait days.

### C. Both, with delivery on hand-over (recommended)

1. **Doctor active:** the alert goes to them, as before.
2. **Doctor deactivated:**
   - the alert is **held** against the conversation, once, however many
     replies raise a concern;
   - every Clinic Admin of the patient's clinic is **notified once per held
     conversation**: *"An alert from the guidance chat could not reach a
     clinician because the patient's doctor is deactivated. Reassign that
     doctor's patients, or reactivate the account, so it can be
     delivered."* The row names no patient, links to no conversation, and
     says nothing about what was raised. On the admin's notifications page it
     links to Doctor accounts;
   - the **Doctor accounts** screen shows, against that doctor, how many
     alerts are waiting. That is a count, as D8 already shows counts, never a
     conversation or a patient.
3. **Hand-over:** when the patients are moved to an active doctor (D8), or
   their doctor is reactivated, the database **delivers every held alert to
   the clinician who can now open it**. It goes out as an ordinary
   `chat_critical` notification, linked to the conversation, so it lands in
   that doctor's *Needs attention* worklist. Then the hold is cleared. Who
   moves the patients, and how, makes no difference: the delivery is a
   trigger, not a step in the reassignment screen.
4. **If the hold cannot be recorded** (the database refuses, or migration 40
   is not applied yet), the administrators are told anyway. Telling them on
   every such reply is better than telling nobody.

- **For:** the concern always ends up with a clinician who can open it. The
  administrators hear at once, with the one action that unblocks it. Nothing
  depends on anyone remembering, and nothing new is revealed to anyone.
- **Against:** the most work: a migration, an admin-screen change, and the
  edge function. The administrator notification is a small disclosure that
  options B, D and E avoid: a patient of a deactivated doctor triggered a
  chat alert. It names no patient and no concern. The clinic's usage counts
  already report flagged conversations, but not this.

### Considered and rejected

- **D. Route the alert to another active doctor in the clinic.** That would
  open a patient's conversation to a clinician the access model does not
  allow, and it makes the system choose who treats the patient. D8 leaves
  that choice to a person.
- **E. Escalate to the Super Admin.** The Super Admin runs the platform and
  never patient care. They hold no clinic's records and cannot reassign
  patients.
- **F. Only tell the patient that their doctor is unavailable.** The patient
  needs honest copy whichever option is chosen (below). But on its own this
  leaves the care team unaware of the concern.

## Recommendation: C

Only C closes the loop. A tells someone who cannot act clinically and then
forgets. B remembers but tells no one. C uses B's record to deliver the
alert to the next clinician, and A's notification to make sure the hand-over
happens soon.

### What the patient is told

The banner was driven by `chat_session_has_critical_flag`, and the claim
"they have been notified" could not be kept by any option. It now reads:

> Something you raised in this conversation has been flagged for your care
> team. If you feel unwell or it's urgent, don't wait to hear from them:
> contact your doctor or emergency services now.

It claims only what the flag means, and it is true whether the alert was
delivered, held or failed. The history badge reads *Flagged for your care
team*. The assistant's own reply already gives the safety advice for the
concern.

Telling the patient that their doctor is inactive was considered and left
out. They can already see their doctor's status. The message would be about
the clinic's administration rather than their care, and it would be one more
claim that could go stale.

## What was built

| Piece | Where |
| --- | --- |
| Who gets the alert, and the fallback to the administrators | `supabase/functions/_shared/critical-alert.ts` (pure, unit tested) |
| The database side, wired to the reply | `supabase/functions/chatbot-reply/index.ts` (`criticalAlertStore`) |
| The hold, delivery on hand-over, the admin counts | `supabase/migrations/20260902100040_held_chat_alerts.sql` |
| Its rollback | `supabase/rollbacks/20260902100040_held_chat_alerts.down.sql` |
| The count beside the doctor | `src/features/patients/pages/admin-doctors-page.tsx` |
| The admin notification's link | `src/features/notifications/pages/notifications-page.tsx` |
| The patient's copy | `src/features/chat/flag-notice.ts`, `patient-chat-page.tsx` |

Tests:

- `tests/unit/chatbot-critical-alert.test.ts` covers the rules against a fake
  store, and checks in source order that `chatbot-reply` raises the alert
  only after the flag is set, through the store, with no patient text.
- `tests/db/held-chat-alerts.test.ts` covers the hold, both hand-overs, the
  clinic-scoped counts, who may call what, the migration's order and its
  down-script.

## Release

Each step needs its own approval:

1. Review this document and the branch, and **confirm option C**, or choose
   another option.
2. **Approve migration 40**, then apply and verify it.
3. **Approve deploying `chatbot-reply`.** If it is deployed before 40, every
   critical alert in the window still reaches the administrators, but nothing
   is held or delivered on hand-over, and they are told on every such reply.
4. **Approve merging the website.** The Doctor accounts screen shows no
   counts until 40 is applied, and works either way.

`docs/deployment.md` has the details and the rollback order.

## Open questions for the product owner

Release blockers (decision of 2026-10-21): each needs an answer before this
goes out.

- **Assistant failures in the same window.** If the assistant fails to
  answer, the review request still goes to nobody when the doctor is
  deactivated (`no_doctor`). It carries no concern, so it is left as it was.
  The same hold could carry it later.
- **Unread alerts sent before deactivation.** These stay in the deactivated
  doctor's inbox and do not move with the patients. Moving them on hand-over
  is a separate change.
- **A clinic with no Clinic Admin.** The alert is held and logged as
  `held_no_admin`, but nobody is told until an administrator exists and
  opens Doctor accounts.
