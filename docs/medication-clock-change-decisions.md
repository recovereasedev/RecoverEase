# Medication clock-change decisions (migration 48)

> **Status: every decision below is PENDING.** None has clinical adviser
> approval. What migration 48 implements for A and B (holding the dose time
> for the treating doctor's review) is a **provisional safe default**, not an
> approved clinical policy. Migration 48 must not be applied to production,
> and its conflict workflow must not run there, until every decision the
> deployed behaviour relies on is approved and recorded here with its
> evidence.

The adviser's briefing, with an example, the patient and doctor impact, the
safety considerations and the exact question for A–G, is the "Clock-Change
Dose Decisions" document (shared privately by Kean). This file is the record
of the answers.

Nothing in RecoverEase may suggest a medicine, a dose, a time or a change to
a prescription, whatever the answers. A conflict is never reminded, never
marked missed, never counted as taken, and never deleted.

## How to record an approval

1. Fill in **Final approved value** with the adviser's answer in their words.
2. Fill in **Approval date** and **Evidence** (for example: "email from the
   adviser, 2026-11-20, saved in the capstone folder as …", or a signed form).
3. If the answer differs from what migration 48 implements, the change is a
   new reviewed migration (for A and B: `app_private.medication_clock_policy`)
   or a website change, with its own tests, before production.
4. Change the status line at the top only when every decision is approved.

## Decision matrix

| | Decision | Behaviour in migration 48 (provisional) | Technical implications | Patient impact | Doctor impact | Needs adviser approval | Final approved value | Approval date | Evidence |
|---|---|---|---|---|---|---|---|---|---|
| **A** | A dose time that does not exist on a spring-forward day (02:30 when 02:00 jumps to 03:00) | Held for the treating doctor as a `nonexistent_local_time` conflict. Never moved forward automatically. | `app_private.medication_clock_policy('nonexistent_local_time')` returns `hold_for_review`; another rule needs a new migration. | In-app notice; no reminder until the doctor decides. | One review per affected dose time, about once a year in daylight-saving clinics. | Yes | **PENDING** | — | — |
| **B** | A dose time that happens twice on a fall-back day (01:30 when 02:00 goes back to 01:00) | Held as an `ambiguous_local_time` conflict. PostgreSQL alone would choose the second 01:30; that is not used without approval. | As A (`ambiguous_local_time`). The doctor's time picker offers both moments (before / after the clocks go back). | As A. The interval to the neighbouring doses differs by an hour depending on which 01:30. | Chooses the exact moment. | Yes: one platform-wide rule, or hold | **PENDING** | — | — |
| **C** | The treating doctor's options | "Set a time for this dose" (same clinic-local date, in the future, at no other dose's moment of the same medicine) or "No separate dose". A reason (1–1,000 characters) is required for both. Nothing is suggested. Another date is refused. Final once made. | `doctor_resolve_medication_conflict`; treating, active doctor only; locked per schedule; audited (clinical, without the reason's text). | Gets an ordinary dose with ordinary reminders, or sees the recorded outcome. | A dialog with no default choice and an empty time. | Yes: options, reason rule, same-date limit | **PENDING** | — | — |
| **D** | Telling the patient | An in-app notice only (Medications page): "…is awaiting your doctor's review because of a clock change." No push notification, no take/skip wording. | No notification row for the patient. | Informed without an instruction. | Patients may ask the clinic. | Yes: channel and wording | **PENDING** | — | — |
| **E** | Alerting the doctor | One notification when found, one more 24 hours before it if still unresolved (only when the first came earlier than that). Only the treating doctor, only while their account is active. Deduplicated. | `dispatch_medication_conflict_alerts` every 15 minutes; stamps on the conflict. | Better chance of a decision in time. | At most two alerts per conflict. | Yes | **PENDING** | — | — |
| **F** | Adherence | Conflicts are not in the adherence figure. Shown beside it: "Awaiting doctor review", "Not scheduled: unresolved clock-change review", "Doctor decided: not given separately", "Course ended before review". A rescheduled dose counts as an ordinary dose. | `summariseAdherence` unchanged; `summariseConflicts` beside it on the patient page, the doctor's patient page and the printed report. | Never penalised for a dose they were not asked to take. | Sees what was not scheduled, separately. | Yes: treatment and labels | **PENDING** | — | — |
| **G** | A clinic changing time zone | Existing doses keep their exact moments. Only days not yet scheduled follow the new zone. A new day's dose at an existing dose's moment is held as a `same_moment_collision` conflict, under C–F. | Dose identity (schedule, date, wall-clock time) stops duplicates. | For up to 30 days, doses already scheduled keep their old-zone moments. | A few reviews once, about 30 days after a change. | Yes, including the 30-day transition | **PENDING** | — | — |
| **H** | A schedule ended while a conflict after its end date is unresolved | Closed as `course_ended`, recorded, never deleted. Shown to patient and doctor. Extending the course afterwards does not reopen it. | `medication_schedule_close_ended_doses`. | Sees "Course ended before review". | Nothing to decide. | Yes | **PENDING** | — | — |
| **I** | The treating doctor's account is deactivated | No alert is sent to anyone; the conflict stays visible. (Overlaps PR #62's open question about held alerts.) | Alerts require `doc_is_active`. | Unchanged notice. | A reassigned doctor sees the conflicts on the patient. | Yes: who, if anyone, is told | **PENDING** | — | — |
| **J** | Whether a reason is required | Required for both options, 1–1,000 characters. | Database check. | — | One more field. | Yes | **PENDING** | — | — |
| **K** | Wording of the time picker for a repeated time | "Before the clocks go back (GMT-04:00)" / "After the clocks go back (GMT-05:00)", neither selected. | Website only. | — | Must choose explicitly. | Yes: wording | **PENDING** | — | — |

## Not clinical decisions (technical, for Kean)

- A schedule's times, frequency, start date and prescription cannot be
  edited (end it and add a new one, as the website already does).
- A schedule cannot list the same time twice.
- Conflicts are readable by the patient and their treating doctor only,
  exactly as doses are (not by the Clinic Admin).
