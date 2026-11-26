# Proposed patient disclosure: the Guidance chat and OpenAI

**Status: PROPOSAL ONLY. Not applied.** The consent screen
(`src/features/auth/components/consent-gate.tsx`) and the Guidance chat page
are unchanged. Every point marked **[OWNER]** needs the owner's decision, and
every point marked **[LEGAL]** needs whoever advises RecoverEase on privacy
law. Nothing here is a claim that RecoverEase complies with any law.

## Why

The consent screen today says what RecoverEase records and that "You, and the
doctor assigned to your care" can see it. It does not say that:

- Guidance chat messages are sent to an outside AI company (OpenAI) to write
  the reply. This is already true in production: `chatbot-reply` v31 has
  called OpenAI since 2026-11-12. Before that it called Google Gemini, which
  the screen did not mention either.
- With PR #93, some of the patient's own records (medicines, appointments,
  treatment plan, recovery roadmap) are sent too, when a question is about
  them.
- OpenAI may keep that data for a time.

## Facts the wording relies on

Checked against the code in PR #93 and OpenAI's "your data" page (read
26 Nov 2026). If any of these change, the wording must change.

| Fact | Source |
| --- | --- |
| Sent: the conversation's latest 40 messages; for record questions, the medicine names, dosages, times and instructions, appointment times and statuses, plan and goal text, roadmap phases and activities, and whether care is active or ended | `assistant.ts`, `patient-context.ts` |
| Not sent: name, birth date, contact details, address, account or record ids, prescription notes, doctor's notes, daily check-in notes, reschedule reasons, other patients' data | `patient-context.ts`, `patient-record-store.ts`, tests |
| OpenAI does not store the reply for later retrieval (`store: false`) | `assistant.ts` |
| OpenAI keeps API data in abuse-monitoring logs for up to 30 days, unless the organisation has approved Zero Data Retention | OpenAI "your data" page |
| OpenAI does not use API data to train its models unless the organisation opts in | OpenAI "your data" page |
| The assistant cannot change records, book appointments or message the doctor | code; `SAFETY_RULES`, `PATIENT_RECORD_RULES` |
| When a reply raises a concern, or no reply could be given, the patient's doctor gets an alert and can read the conversation | `critical-escalation.ts`, `escalation.ts` |

**[OWNER]** Confirm whether the OpenAI organisation has Zero Data Retention.
If it does, the 30-day sentence below should be replaced with what the ZDR
agreement actually says. Do not write "deleted immediately" without that.

## Proposed text: consent screen

A new section, after "Who can see it":

> **The guidance assistant**
>
> The Guidance chat uses an AI service from OpenAI, an outside company, to
> write its replies. When you send a message, RecoverEase sends OpenAI your
> recent messages in that chat. If you ask about your own medicines,
> appointments, treatment plan or recovery roadmap, it also sends those
> details so the answer can be about you. It does not send your name,
> contact details or date of birth.
>
> OpenAI uses this only to write the reply. It does not use it to train its
> AI, and RecoverEase asks it not to keep the reply. OpenAI may still keep
> the information for up to 30 days to check for misuse, and then deletes it.
>
> The assistant gives general guidance. It is not a doctor, cannot change
> your treatment, and cannot contact your doctor for you. You do not have to
> use it: everything else in RecoverEase works without it.

And one sentence added to "Who can see it":

> Your doctor can also read your Guidance chat conversations, and is alerted
> when the assistant thinks they should know about something you wrote.

**[OWNER]** Check that the doctor-alert sentence matches what doctors are
shown in practice before using it.

## Proposed text: Guidance chat page

Replace the current notice ("This assistant offers general guidance…") with:

> This assistant uses an AI service (OpenAI) to give general guidance about
> your recovery. It does not diagnose conditions and cannot change your
> treatment. Your messages, and your records when you ask about them, are
> sent to OpenAI to write the reply.
>
> **Need a person?** Contact your doctor or clinic directly, or book an
> appointment in **Appointments**. If you feel very unwell or it is an
> emergency, call **911** or go to the nearest emergency room now.

Footer line under the message box (unchanged in meaning, shorter):

> General guidance only · Your care team makes decisions about your treatment

**[OWNER]** 911 is what the proposed clinic guidance already uses; confirm it
is right for every clinic on the platform.

## Decisions before any of this ships

1. **[OWNER]** Whether patients who already agreed must agree again.
   Consent is recorded once (`patient.pat_consent_at`), so new text is only
   seen by new patients unless consent is reset or a separate notice is
   shown. A one-time notice on the Guidance chat page, before the first
   message, would reach existing patients without blocking the rest of the
   app.
2. **[OWNER]** Whether patients can use the rest of RecoverEase without the
   assistant (they can today, functionally), and whether to say so, as
   drafted.
3. **[LEGAL]** Obligations under applicable privacy law for sending health
   information to a provider outside the Philippines: whether consent,
   notice, a data processing agreement with OpenAI, or registration is
   required, and what the notice must say. This document does not answer
   that.
4. **[LEGAL]** Whether a data processing agreement with OpenAI is in place.
5. **[OWNER]** Whether to apply for OpenAI Zero Data Retention for this
   organisation.
6. **[OWNER]** Whether the disclosure ships before, or together with, the
   PR #93 deploy. The production chatbot already sends conversations to
   OpenAI today, so the gap exists now, not only after PR #93.
