# Medication clock-change decisions (migration 48)

> **Status: every decision below is OWNER-ACCEPTED, not clinically
> approved.** On 2026-11-09 Kean (project owner) decided to skip the clinical
> adviser review for this Capstone 2 project and to accept what migration 48
> implements, as written below, as the project's behaviour. No clinical
> adviser has reviewed or approved any of it. RecoverEase runs on Philippine
> time (Asia/Manila): no daylight saving and no planned time zone change, so
> A, B, G, G1 and K cannot arise in this deployment. If the project is used
> beyond the capstone, put these decisions to a clinical adviser first.

The adviser package below was prepared but **not sent** (owner's decision,
2026-11-09). The adviser's briefing, with an example, the patient and doctor impact, the
safety considerations and the exact question for A–G, is the "Clock-Change
Dose Decisions" document (shared privately by Kean). It covers A–G only; the
complete document for the adviser, covering all fifteen decisions here, is
`docs/clinical-adviser-review-migration-48.md`. This file is the record of
the answers.

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
4. Change the status line at the top only when every decision is approved,
   including the open questions F1, G1, H1 and J1 below.

## Decision matrix

| | Decision | Behaviour in migration 48 (provisional) | Technical implications | Patient impact | Doctor impact | Needs adviser approval | Final approved value | Approval date | Evidence |
|---|---|---|---|---|---|---|---|---|---|
| **A** | A dose time that does not exist on a spring-forward day (02:30 when 02:00 jumps to 03:00) | Held for the treating doctor as a `nonexistent_local_time` conflict. Never moved forward automatically. | `app_private.medication_clock_policy('nonexistent_local_time')` returns `hold_for_review`; another rule needs a new migration. | In-app notice; no reminder until the doctor decides. | One review per affected dose time, about once a year in daylight-saving clinics. | Yes | **OWNER-ACCEPTED** as implemented; not applicable in Asia/Manila | 2026-11-09 | Kean's instruction in the Claude Code session, 2026-11-09: adviser review skipped (Capstone 2); not clinically approved |
| **B** | A dose time that happens twice on a fall-back day (01:30 when 02:00 goes back to 01:00) | Held as an `ambiguous_local_time` conflict. PostgreSQL alone would choose the second 01:30; that is not used without approval. | As A (`ambiguous_local_time`). The doctor's time picker offers both moments (before / after the clocks go back). | As A. The interval to the neighbouring doses differs by an hour depending on which 01:30. | Chooses the exact moment. | Yes: one platform-wide rule, or hold | **OWNER-ACCEPTED** as implemented; not applicable in Asia/Manila | 2026-11-09 | Kean's instruction in the Claude Code session, 2026-11-09: adviser review skipped (Capstone 2); not clinically approved |
| **C** | The treating doctor's options | "Set a time for this dose" (same clinic-local date, in the future, at no other dose's moment of the same medicine) or "No separate dose". A reason (1–1,000 characters) is required for both. Nothing is suggested. Another date is refused. Final once made. | `doctor_resolve_medication_conflict`; treating, active doctor only; locked per schedule; audited (clinical, without the reason's text). | Gets an ordinary dose with ordinary reminders, or sees the recorded outcome. | A dialog with no default choice and an empty time. | Yes: options, reason rule, same-date limit | **OWNER-ACCEPTED** as implemented | 2026-11-09 | Kean's instruction in the Claude Code session, 2026-11-09: adviser review skipped (Capstone 2); not clinically approved |
| **D** | Telling the patient | An in-app notice only (Medications page): "…is awaiting your doctor's review because of a clock change." No push notification, no take/skip wording. | No notification row for the patient. | Informed without an instruction. | Patients may ask the clinic. | Yes: channel and wording | **OWNER-ACCEPTED** as implemented | 2026-11-09 | Kean's instruction in the Claude Code session, 2026-11-09: adviser review skipped (Capstone 2); not clinically approved |
| **E** | Alerting the doctor | One notification when found, one more 24 hours before it if still unresolved (only when the first came earlier than that). Only the treating doctor, only while their account is active. Deduplicated. | `dispatch_medication_conflict_alerts` every 15 minutes; stamps on the conflict. | Better chance of a decision in time. | At most two alerts per conflict. | Yes | **OWNER-ACCEPTED** as implemented | 2026-11-09 | Kean's instruction in the Claude Code session, 2026-11-09: adviser review skipped (Capstone 2); not clinically approved |
| **F** | Adherence | Conflicts are not in the adherence figure. Shown beside it ("Not counted in the adherence figure above"), and as the heading of each patient notice, in the doctor's list and in the printed report, with one label each: "Awaiting doctor review", "Not scheduled: unresolved clock-change review", "Rescheduled by the doctor", "Doctor decided: not given separately", "Course ended before review". (A sixth label, "Rescheduled, then the course ended before it", is F1's wording.) A rescheduled dose counts as an ordinary dose. | `summariseAdherence` unchanged; `summariseConflicts` beside it on the patient page, the doctor's patient page and the printed report. | Never penalised for a dose they were not asked to take. | Sees what was not scheduled, separately. | Yes: treatment and labels | **OWNER-ACCEPTED** as implemented | 2026-11-09 | Kean's instruction in the Claude Code session, 2026-11-09: adviser review skipped (Capstone 2); not clinically approved |
| **G** | A clinic changing time zone | Existing doses keep their exact moments. Only days not yet scheduled follow the new zone. A new day's dose at an existing dose's moment is held as a `same_moment_collision` conflict, under C–F. | Dose identity (schedule, date, wall-clock time) stops duplicates. | For up to 30 days, doses already scheduled keep their old-zone moments. | A few reviews once, about 30 days after a change. | Yes, including the 30-day transition | **OWNER-ACCEPTED** as implemented; not applicable in Asia/Manila | 2026-11-09 | Kean's instruction in the Claude Code session, 2026-11-09: adviser review skipped (Capstone 2); not clinically approved |
| **H** | A schedule ended while a conflict after its end date is unresolved | Closed as `course_ended`, recorded, never deleted. Shown to patient and doctor. Extending the course afterwards does not reopen it. | `medication_schedule_close_ended_doses`. | Sees "Course ended before review". | Nothing to decide. | Yes | **OWNER-ACCEPTED** as implemented | 2026-11-09 | Kean's instruction in the Claude Code session, 2026-11-09: adviser review skipped (Capstone 2); not clinically approved |
| **I** | The treating doctor's account is deactivated, or the patient is reassigned | Each alert (E) goes to whoever is the treating doctor when it is sent, only while active, once per conflict. While the doctor is deactivated no alert is sent to anyone; the conflict stays visible to the patient. After a reassignment the new doctor sees and can decide the conflict, but gets no "found" alert if the previous doctor already had it. If it was never sent, the new doctor gets it within about 15 minutes, even after the dose time. The 24-hour alert reaches the new doctor only if not yet sent, the first alert came more than 24 hours before the dose time, and that time has not passed. (Overlaps PR #62's open question about held alerts.) | Alerts require `doc_is_active`; recipient read at send time from `patient.doc_id`; stamps `conflict_doctor_alerted_at` / `conflict_doctor_final_alert_at` stop repeats. | Unchanged notice. | A reassigned doctor may not know of a pending conflict unless they open the patient's medication page. | Yes: who, if anyone, is told; and whether a reassignment should alert the new treating doctor immediately | **OWNER-ACCEPTED** as implemented | 2026-11-09 | Kean's instruction in the Claude Code session, 2026-11-09: adviser review skipped (Capstone 2); not clinically approved |
| **J** | Whether a reason is required | Required for both options, 1–1,000 characters. | Database check. | — | One more field. | Yes | **OWNER-ACCEPTED** as implemented | 2026-11-09 | Kean's instruction in the Claude Code session, 2026-11-09: adviser review skipped (Capstone 2); not clinically approved |
| **K** | Wording of the time picker for a repeated time | "Before the clocks go back (GMT-04:00)" / "After the clocks go back (GMT-05:00)", neither selected. | Website only. | — | Must choose explicitly. | Yes: wording | **OWNER-ACCEPTED** as implemented; not applicable in Asia/Manila | 2026-11-09 | Kean's instruction in the Claude Code session, 2026-11-09: adviser review skipped (Capstone 2); not clinically approved |

## Open questions from the implementation review (2026-11-09)

The reviews of migration 48 found four behaviours the briefing did not put
to the adviser. Each belongs to a decision above and is owner-accepted with it.
Migration 48 does what the "Behaviour now" column says until an answer is
recorded here; a different answer is a new reviewed change.

| | Belongs to | Question for the adviser | Behaviour now (provisional) | Answer | Approval date | Evidence |
|---|---|---|---|---|---|---|
| **F1** | F | The doctor sets a time for a held dose, and the course is then ended before that time. Ending a course removes the doses still to come after its end, so the doctor's dose is removed too; the decision stays recorded. Is the wording below clinically appropriate, and what should the patient and the doctor each be told? (Whether a later extension of the course brings the dose time back is H1.) | Shown as "Rescheduled, then the course ended before it". The patient reads: "Your doctor reviewed your … dose time on … and set a time for it, but the course ended before that time, so it is not among your doses." | **OWNER-ACCEPTED** as implemented | 2026-11-09 | Kean's instruction in the Claude Code session, 2026-11-09: adviser review skipped (Capstone 2); not clinically approved |
| **G1** | G, C | After a clinic changes time zone, doses of the old and new zone can fall close together without sharing a moment. Moving from Los Angeles to Manila, a medicine at 08:00, 14:00 and 20:00 has doses **2 hours apart**, and 20 January's 20:00 dose comes after 21 January's 08:00. Should a new dose within some minimum interval of another dose of the same medicine also be held for the doctor, and what interval? The same question applies to the time a doctor chooses under C: should it also keep that interval from the medicine's other doses? | Only a dose at **exactly** another dose's moment is held, and a doctor's chosen time is refused only at exactly another dose's moment. Doses close together are created and reminded as normal. | **OWNER-ACCEPTED** as implemented; not applicable in Asia/Manila | 2026-11-09 | Kean's instruction in the Claude Code session, 2026-11-09: adviser review skipped (Capstone 2); not clinically approved |
| **H1** | H, F1 | When a course is ended early and then extended again, the doses removed at the end come back, but a conflict closed as `course_ended` stays closed: that dose time gets neither a dose nor a review, and the patient reads "Course ended before review". The same applies to a dose the doctor had rescheduled that was removed when the course ended (F1): extending does not bring it back. Should extending the course reopen those dose times for the treating doctor, so that a new decision is needed, or should they stay closed? | Not reopened, and the removed rescheduled dose is not recreated. Visible to patient and doctor as "Course ended before review" or "Rescheduled, then the course ended before it". The website has no action that extends a course; a later end date can only be set outside it. | **OWNER-ACCEPTED** as implemented | 2026-11-09 | Kean's instruction in the Claude Code session, 2026-11-09: adviser review skipped (Capstone 2); not clinically approved |
| **J1** | C, J | The doctor's written reason is stored with the conflict. The patient's page does not show it, but the patient's own account can read it through the database's interface. Is the reason meant for the patient to read, or for clinicians only? | Readable by the patient and the treating doctor; shown on screen to the doctor only; never written to the audit log. | **OWNER-ACCEPTED** as implemented | 2026-11-09 | Kean's instruction in the Claude Code session, 2026-11-09: adviser review skipped (Capstone 2); not clinically approved |

## Not clinical decisions (technical, for Kean)

- A schedule's times, frequency, start date and prescription cannot be
  edited (end it and add a new one, as the website already does).
- A schedule cannot list the same time twice.
- Conflicts are readable by the patient and their treating doctor only,
  exactly as doses are (not by the Clinic Admin).
