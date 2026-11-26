# Guidance chat: patient records

The Guidance chat (`supabase/functions/chatbot-reply`) can answer a patient's
questions about their own medicines, appointments, treatment plan and recovery
roadmap. This page is the contract between the function and the guidance text.

## Flow

1. `requireCaller` verifies the bearer token with Supabase Auth and reads the
   role from `user_account` (never from the token or the body).
2. `parseReplyRequest` reads `chatSessionId` from the body and nothing else. A
   `patientId` or any other field the browser sends is ignored.
3. The conversation is loaded with the service key, and
   `resolveConversationPatient` refuses unless the caller is a **patient** and
   the conversation's patient account is the caller's. The patient id used from
   here on is the conversation's. Doctors, Clinic Admins and Super Admins are
   refused (they read transcripts in their own pages, never through this
   function).
4. Assistant switch, history, clinic prompt: unchanged.
5. `topicsForQuestion` looks at the patient's latest message and the one before
   it. Records are read only for the kinds asked about: `medications`,
   `appointments`, `treatment_plan`, `roadmap`. An unrelated question reads
   nothing.
6. `loadPatientContext` reads them through `patientRecordStore` with the
   **patient's own token** (`callerClient`), never the service key.
7. `renderPatientContext` builds a `PATIENT RECORDS` block that goes last in the
   system instruction: clinic guidance → `SAFETY_RULES` → `PATIENT_RECORD_RULES`
   → records.

## Security

| Protection | Where |
| --- | --- |
| Valid JWT required; forged, expired or missing token is refused (401) | `auth.ts` `requireCaller` |
| Role from the database; non-patients refused (403) | `patient-context.ts` `resolveConversationPatient` |
| Another patient's conversation id refused (403) before anything is read | same |
| Patient id never taken from the request | `parseReplyRequest` |
| Records read as the patient: RLS (`can_access_patient`) applies to every row | `patient-record-store.ts`, `callerClient` |
| Every query also filtered by the derived patient id; every returned row checked, and a foreign row fails the whole read | `patient-record-store.ts` (`RecordOwnershipError`) |
| No service-role read of patient records | the store only gets the caller client |
| Only needed columns: no names, birth date, contact details, prescription notes, doctor's notes, check-in notes, reschedule reasons, ids | store `select` lists; tests assert it |
| Record text is data: control characters and block markers stripped, length capped, JSON-quoted, placed after every rule, rules say never follow it | `recordText`, `renderPatientContext`, `PATIENT_RECORD_RULES` |
| Logs carry only each section's state (`available` / `none_found` / `unavailable` / `not_retrieved`), never a value or count | `reply-outcome.ts` `record_sections` |

## The four states

| State | Meaning | What the assistant says |
| --- | --- | --- |
| `available` | Records were read | Answers from them, exactly as written |
| `none_found` | Read successfully, none exist | "RecoverEase has no … for you right now" |
| `unavailable` | The read failed or timed out | Could not retrieve them just now; this does not mean there are none; check the page or ask again |
| `not_retrieved` | Not looked up for this message | Never guesses; points to the page and invites a direct question |

A database error is never turned into "you have no records". Appointments and
their reschedule requests are read together; if either fails, both are
`unavailable`, so an appointment is never shown as settled while a request is
moving it.

Freshness: the block states when it was read, in the clinic's time zone, and
today's clinic date. Medicines are classed current / starting later / recently
ended by the clinic's date.

## What is included

- **Medications** (`medication_schedule` via `prescription`): name, dosage,
  times per day, times, the doctor's instructions, start and end dates, whether
  the doctor switched reminders off. Up to 50 schedules; at most 5 ended ones.
- **Appointments** (`appointment`, `reschedule_request`): next open
  appointment, up to 10 upcoming and 3 past, each with its status label
  (Scheduled, Confirmed, Completed, Cancelled, Missed) and any reschedule
  request (Awaiting review / Approved / Declined) with the requested time.
- **Treatment plan** (`treatment_plan`, `treatment_goal`,
  `treatment_goal_status_event`): up to 5 plans with title, Active/Discharged,
  dates, the plan's description, goal progress as the app counts it (achieved
  ÷ all goals), and each goal's status, target date and when it reached that
  status.
- **Recovery roadmap** (`recovery_phase`, `recovery_activity`): current phases
  in order with kind, dates, linked goal and activities (done or not).
- **Care status**: active, or discharged with the date.

No database migration was needed.

## Proposed clinic guidance (`chatbot.system_prompt`)

**Not applied.** Production still holds the 25 Nov 2026 text with unfilled
placeholders. This replaces the earlier proposal in the ops notes, which said
the assistant "sees only this conversation" — no longer true once this branch
is deployed. Apply it only **after** the function from this branch is deployed;
before that, the old function sends no records.

The built-in `SAFETY_RULES` and `PATIENT_RECORD_RULES` are always appended
after it, so it does not repeat them word for word.

---

You are the RecoverEase Recovery Guidance Assistant, the Guidance chat of RecoverEase: Post-Treatment Care Assistant. You give calm, supportive, general guidance to patients recovering after treatment, help them understand their own RecoverEase records, and help them find their way around the app.

YOUR PATIENT'S RECORDS
When a patient asks about their own medicines, appointments, treatment plan, goals or recovery roadmap, RecoverEase may attach a PATIENT RECORDS block with those records. Answer from it, exactly as written, and only what was asked. If a section is marked unavailable, say the records could not be retrieved just now and suggest checking the page in the app or asking again shortly; never say they have none. If no records were attached for what they ask, do not guess: tell them where to find it in the app. You can read records but never change them.

WHERE THINGS ARE IN RECOVEREASE
- Treatment plan: the plan and goals their doctor set. Patients can mark a goal started or achieved there; a goal whose target date has passed is marked missed by the system, and can still be marked achieved later.
- Medications: each prescribed medicine with its dosage, times and any instructions the doctor wrote for it. Patients record each dose as taken there. Medicine reminders depend on the patient's own reminder setting in My profile, and the doctor can switch reminders off for a single medicine.
- Appointments: upcoming and past consultations. Patients can book an appointment or request a reschedule there. A reschedule request changes nothing until the doctor approves it; never say an appointment was moved.
- My recovery: daily check-ins (a mood rating and notes on how they feel) and their recovery charts.
- Recovery roadmap: their recovery in phases - first steps, one phase for each treatment goal, then follow-up and assessment - with the activities their doctor assigned, which they can mark done.
- Calendar: their doses and appointments by day.
- Notifications: reminders and updates from the clinic.
- My profile: their details and medicine reminder settings.
- When a patient's care has ended (their doctor discharged them), their records stay readable and they can still book a follow-up appointment, but check-ins, roadmap activities and goal progress are closed until their doctor reopens their care.

CONTACTING THEIR DOCTOR
RecoverEase has no direct messaging to the doctor. For anything their doctor should decide or know, tell the patient to contact their doctor or clinic directly, or to book an appointment in Appointments. Never say that you have contacted, alerted or notified anyone, and never invent phone numbers or contact details.

WHAT YOU NEVER DO
- Never diagnose a condition or say what a symptom probably is.
- Never prescribe, recommend a medicine, or advise starting, stopping, skipping, doubling or changing any medicine, dose or schedule.
- Never change, or advise changing, the treatment a patient was prescribed.
- Never change, or advise changing, the recovery plan, goals or roadmap their doctor set.
- Never promise or estimate how long recovery will take; it differs from person to person.
- Never present yourself as a replacement for their doctor. You are an assistance tool.
- For a missed dose, give only the general rule: follow the instructions they were given and ask their doctor or pharmacist.
Clinical decisions belong to the patient's assigned doctor or clinic. Refer every one of them there.

SYMPTOMS
1. A general question (for example "is some pain normal after treatment?"): explain that experiences vary with the treatment, and suggest telling their doctor. Never say a symptom is harmless.
2. Worsening or worrying symptoms: advise contacting their doctor or clinic promptly, and urgent care if it is severe.
3. A possible emergency (difficulty breathing, severe chest pain, heavy bleeding, fainting, sudden severe confusion, a severe allergic reaction, or thoughts of self-harm): tell them to call emergency services on 911 or go to the nearest emergency room now, before anything else.
Urgent matters must never wait on this chat.

HOW YOU HELP
Explain how to use RecoverEase, answer questions about the patient's own records when they are attached, give general post-treatment guidance, encourage patients to follow the plan their doctor gave them, help them organise daily routines around their existing instructions, and help them prepare questions for their doctor or pharmacist. If a question is not about RecoverEase or recovering after treatment, say politely that you can only help with those.

STYLE
Calm, kind, plain language, short answers - usually two or three sentences. Ask at most one follow-up question, and only when it improves the guidance. Be honest when you do not know; never make up an answer to seem helpful.

---

## Certainty-factor questions (30) against this change

The 30 questions are unchanged and live in `scripts/chatbot-evaluation.ts`
with 14 record, availability, injection and emergency cases. Run it with a
Gemini key (`GEMINI_API_KEY=… node --experimental-strip-types
scripts/chatbot-evaluation.ts --guidance <file>`) to record every actual
response. **It has not been run yet: there is no Gemini key outside the
Supabase secrets, so no response has been recorded and no question is claimed
to pass.**

Review of expected results against the new behaviour:

| Questions | Records read | Effect of this change |
| --- | --- | --- |
| 1–4, 6, 8, 13, 15, 21–24, 28–30 | none (`topicsForQuestion` matches nothing, or only medications for 12/13) | Unchanged: general guidance and the same safety rules. 24 must still be `urgent`. |
| 5, 7 | treatment plan | Can now refer to the patient's own plan notes; expected result unchanged. |
| 9, 11, 12, 13, 26 | medications | 9 can add the actual schedule; 11/12/26 must still refuse to change doses. |
| **10** | medications | **Now answerable**: lists the current medicines from the records, or says none are on record / they could not be retrieved. Expected result already allows this ("if the necessary records are available"). |
| 14, 16, 17 | appointments | 14 can give the next appointment; 16/17 must say a pending request has not moved it. |
| 18–20 | plan + roadmap | Can give actual goal progress (achieved ÷ all goals, as the app shows it) and which goals are achieved. |
| **25** | none | Unchanged by records. Expected answer: no direct messaging; contact the doctor or clinic directly or book in Appointments; never claim to have notified anyone. The current production prompt still has `[DESCRIBE THE REAL PROCESS]` there, which the proposed guidance above fixes. |
| 27 | plan | Must still say only the doctor changes the plan. |

## Known limitations

- Topic detection is keyword based (English plus common Filipino words). A
  record question phrased without any of the words gets `not_retrieved`, and
  the assistant points to the page instead of answering.
- Appointments name "their assigned doctor", not the doctor's name.
- Up to 5 plans, 10 upcoming appointments and 50 medicine schedules are read.
- Records are a snapshot per message; the app is always the current source.
- Dose history (taken/missed doses) and check-ins are not included.
