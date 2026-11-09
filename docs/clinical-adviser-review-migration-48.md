# Clinical Adviser Review: Medication Dose Timing During Clock and Time Zone Changes

**RecoverEase (Capstone 2) - change "migration 48"**

| | |
|---|---|
| Prepared by | Kean Caballero, RecoverEase |
| Prepared on | 9 November 2026 |
| Change under review | Pull request #76, "Medication dose identity and clock-change conflict handling" |
| Implementation reviewed | 460fd64 (the code this document describes; later documentation-only commits do not change it) |
| Decisions awaiting review | 15: A to K, F1, G1, H1 and J1 |
| Clinical status | **Every decision is PENDING.** Nothing in this document has clinical approval. |
| Production status | **Not applied to production. Not in use by any patient or doctor.** |

> **Not sent (2026-11-09).** The project owner decided to skip the clinical
> adviser review for this Capstone 2 project and accepted the behaviour below
> as implemented, without clinical approval. This document is kept as the
> record of what was prepared; the outcome is in
> `docs/medication-clock-change-decisions.md`.

> **Please note.** Every behaviour described below is a *provisional
> proposal*, prepared so that it can be reviewed. It is not a clinical policy,
> it has not been clinically validated, and it will not be put into use until
> you have answered the decisions it depends on. You are free to approve,
> change or reject any proposal, or to mark it not applicable.

---

## 1. Project and review context

RecoverEase is a recovery-care web application used by a clinic, its doctors
and their patients. Among other things, a doctor records a patient's
medication schedule (for example "Medicine X, 1 tablet, at 08:00 and
20:00"), and the system:

- creates each individual dose for the coming days;
- reminds the patient before and after each dose;
- lets the patient mark a dose as taken, and marks a dose missed when its
  time passes without that;
- shows an adherence figure (the share of doses taken) to the patient and the
  doctor, and in the printed report.

Every dose time is a time on the **clinic's local clock**. This review is
about what happens when that clock behaves unusually.

## 2. Why clinical review is needed

A technical review found three problems in how doses were created:

1. **Duplicate doses after a clinic changes time zone.** The system created a
   second dose next to each existing dose for up to 30 days. A patient could
   be reminded to take the same medicine twice.
2. **Daylight-saving "spring forward".** When clocks jump forward (for
   example from 02:00 straight to 03:00), a 02:30 dose time does not exist
   that day. The system could silently drop that dose.
3. **Daylight-saving "fall back".** When clocks go back (for example from
   02:00 to 01:00), 01:30 happens twice. The system silently chose one of the
   two, without anyone deciding.

The proposed change stops the duplicates and stops anything being silently
dropped or chosen. Where a dose time cannot be scheduled safely, it holds that
dose time for the patient's treating doctor to decide.

**Deciding what should happen to a patient's dose in these situations is a
clinical decision.** It affects how far apart doses are, whether a dose is
given at all, what the patient is told, and how adherence is judged. These
decisions need your answers before the change is used.

## 3. Current status and production restrictions

- The change is **built and tested on the development side only**. The tests
  check that the system *behaves as described*. They do not show that the
  behaviour is *clinically right*; that is what this review is for.
- It has **not been applied to the production system**, and no patient or
  doctor uses it.
- It will not be applied, and the "held for the doctor" workflow will not run
  for real patients, until:
  1. your answers are recorded for every decision the behaviour relies on;
  2. any change you ask for has been built and tested;
  3. the project owner has separately approved each production step.
- Any decision you leave unanswered **stays PENDING**, and the behaviour that
  depends on it is not put into use.

**About the current clinic.** The only clinic today is in **Asia/Manila**,
which has no daylight saving time. So:

- Decisions **A, B and K** (daylight-saving days) would only arise if a clinic
  in a daylight-saving time zone joined, or the clinic moved to one.
- Decisions **G and G1** (time zone changes) would only arise if a clinic
  changed its time zone setting.

Whether any decision is **not applicable** is for you to decide. We have not
assumed that any of them can be skipped.

## 4. How the system handles dose times

### 4.1 Automatic dose generation

Every night, and whenever a doctor adds a schedule, the system creates the
individual doses for the next 30 days from the prescribed times on the
clinic's clock. For "08:00 and 20:00" it creates one 08:00 dose and one 20:00
dose for each day. **Nobody reviews these doses**: they appear, the patient
is reminded, and they are marked taken or missed in the usual way.

Each dose now carries a permanent label: *which medicine schedule, which
date, which prescribed time* (for example "Medicine X, 10 March, 08:00").
Only one dose can ever exist with a given label, which is what prevents
duplicates.

### 4.2 Clock-change conflicts (a dose time that cannot be scheduled safely)

In three situations the system does **not** create the dose. Instead it
records a **conflict**: a note that this dose time needs the treating
doctor's decision.

| Situation | Example |
|---|---|
| The time does not exist that day (spring forward) | Clocks jump from 02:00 to 03:00, so a 02:30 dose time does not exist. |
| The time happens twice that day (fall back) | Clocks go back from 02:00 to 01:00, so 01:30 happens twice, an hour apart. |
| After a time zone change, a new dose would fall at exactly the same moment as a dose already scheduled | See decision G. |

A conflict is **not a dose**:

- the patient is not reminded about it;
- it is never marked taken or missed;
- it is not in the adherence figure;
- the patient sees a neutral notice, and the doctor is alerted.

**If no decision is made before the dose time,** the conflict is shown as
"Not scheduled: unresolved clock-change review". No dose took place, but it
is not counted as missed.

### 4.3 A doctor choosing a replacement dose time

The treating doctor opens the conflict and chooses one of two options:

- **"Set a time for this dose":** the doctor enters a time on the same date,
  later than now, that is not at exactly the same moment as another dose of
  the same medicine. That time becomes an **ordinary dose**, with ordinary
  reminders and the ordinary taken or missed outcome.
- **"No separate dose":** no dose is created, and the decision is recorded.

Either way, the doctor must write a reason. **The system never suggests a
time**: both options start unselected and the time starts empty.

**How they differ:**

| | Automatic dose generation | A conflict | A doctor-selected time |
|---|---|---|---|
| Who decides | The system, from the prescription | Nobody yet: held for the doctor | The treating doctor |
| Is it a dose? | Yes | No | Yes |
| Reminders | Yes | No | Yes |
| Counted in adherence | Yes | No (shown separately) | Yes |
| Checked against other doses | Never at exactly the same moment | n/a | Never at exactly the same moment |

## 5. Safeguards already enforced, and what still needs your decision

### 5.1 Enforced by the system and tested

These are built into the database, so they hold whatever the website does.
Each is covered by automated tests.

- **Never taken or missed.** A conflict is never counted as taken, never
  marked missed and never reminded about like a dose.
- **Not in the adherence figure.** Adherence is worked out from real doses
  only. An undecided dose time cannot lower it; it is listed beside it.
- **No duplicates.** Each (medicine schedule, date, prescribed time) can
  exist only once, as either a dose or a conflict.
- **Treating doctor only.** Only the patient's own treating doctor, with an
  active account, can decide a conflict. Another doctor is told it does not
  exist, and the patient and clinic administrators cannot decide at all.
- **A reason is required** for every decision (1 to 1,000 characters).
- **One decision only.** A conflict cannot be decided twice, and two
  decisions made at the same time are handled one after the other.
- **Existing records are kept.** When the change is installed, every existing
  dose is given its permanent label. Its time, status and "taken" record are
  not changed; a test checks this.
- **Clinical records are not deleted.** A conflict is never deleted. Removing
  this change from the system is refused while any conflict exists.
- **Recorded in the audit log.** Each decision is logged as a clinical
  action of the patient's clinic. The doctor's written reason is not copied
  into the log.
- **No suggestions.** Nothing suggests a medicine, a dose, a time or a change
  to a prescription.

### 5.2 Not proven by the automated tests

- Two people acting at exactly the same instant is handled by the database's
  standard locking. This was reasoned through, not reproduced in a test.
- The 15-minute job that sends doctor alerts cannot run in the test
  environment. It would be checked on the production system after
  installation.

### 5.3 Still awaiting your clinical decision

- whether holding for the doctor is right at all (A, B);
- what the doctor may decide (C);
- how and when the patient and doctor are told (D, E, I);
- how conflicts are treated and labelled (F, K, F1);
- what happens during a time zone change, and how close doses may be (G, G1);
- what happens when a course ends or is extended (H, H1);
- whether a reason is required, and who may read it (J, J1).

### 5.4 The main remaining risk

While a dose time is held, **there is no dose**. If the doctor does not
decide before that time, the patient receives no reminder and no dose is
scheduled. It is recorded as "not scheduled" rather than missed. Decisions
A, B, D, E and I all bear on this risk.

## 6. The decisions

For each decision: the situation, what the system does now (provisionally),
what you are asked to decide, the possible patient-safety impact, and the
questions that need an explicit answer.

---

### Decision A: a dose time that does not exist (spring forward)

**Situation.** In a daylight-saving time zone, clocks jump forward once a
year (for example from 02:00 straight to 03:00). A dose prescribed for 02:30
has no 02:30 that day.

**Current provisional behaviour.** No dose is created. The dose time is held
for the treating doctor as a conflict. It is never moved to another time
automatically.

**What you are asked to decide.** Whether holding for the doctor is the right
approach, or whether one automatic rule should apply instead (for example
moving the dose to just after the jump).

**Patient-safety considerations.**

- An automatic move could put the dose closer to the next dose than
  prescribed.
- Holding it means no dose until the doctor decides. If the doctor does not
  decide in time, the dose does not take place.

**Questions requiring an explicit answer.**

- A.a. Should a dose time that does not exist be held for the treating doctor?
- A.b. If not, what single automatic rule should apply?
- A.c. Is this decision applicable to the clinics RecoverEase serves?

---

### Decision B: a dose time that happens twice (fall back)

**Situation.** When clocks go back (for example from 02:00 to 01:00), a dose
prescribed for 01:30 could mean either of two moments, one hour apart.

**Current provisional behaviour.** No dose is created. The dose time is held
for the doctor, who chooses the first 01:30 (before the clocks go back) or
the second (after). The database on its own would pick the second
automatically; that is not used without your approval.

**What you are asked to decide.** Hold for the doctor, or one rule for every
patient (always the first, or always the second).

**Patient-safety considerations.** The gap to the neighbouring doses differs
by an hour depending on which 01:30 is used. For some medicines this may
matter.

**Questions requiring an explicit answer.**

- B.a. Should a repeated dose time be held for the treating doctor?
- B.b. If not, should it always be the first or always the second occurrence?
- B.c. Is this decision applicable to the clinics RecoverEase serves?

---

### Decision C: the doctor's options when deciding a conflict

**Situation.** What the treating doctor is allowed to decide about a held
dose time.

**Current provisional behaviour.**

- **"Set a time for this dose":** a time on the same date, later than now,
  and not at exactly the same moment as another dose of the same medicine.
  It becomes an ordinary dose.
- **"No separate dose":** no dose is created.
- A written reason is required for both.
- Nothing is pre-selected and no time is suggested.
- A different date is refused.
- **A decision is final:** it cannot be changed afterwards in the system.
- Once the date has passed, a time can no longer be set; only "No separate
  dose" can be recorded.

**What you are asked to decide.** Whether these options, the same-date
limit and the finality of a decision are clinically appropriate.

**Patient-safety considerations.**

- If the right answer is a dose on another day, the doctor cannot choose it.
- A mistaken decision cannot be corrected in the system.
- Close spacing to other doses is addressed in G1.

**Questions requiring an explicit answer.**

- C.a. Are "Set a time for this dose" and "No separate dose" the right
  options? Is any option missing?
- C.b. Should the chosen time be limited to the same date?
- C.c. Should a decision be final, or should the doctor be able to change it?
  If so, under what conditions?

---

### Decision D: telling the patient

**Situation.** The patient needs to know that one of their dose times is on
hold, and later what was decided.

**Current provisional behaviour.** A notice on the patient's Medications
page only: no phone notification and no message. The notice never tells the
patient to take or skip anything. The wording is:

| When | What the patient reads |
|---|---|
| Awaiting the doctor | "Your [medicine] dose time on [date] at [time] is awaiting your doctor's review because of a clock change." |
| Time passed, no decision | "Your [medicine] dose time on [date] at [time] was not scheduled: your doctor's review of the clock change was not completed." |
| Doctor set a time | "Your doctor reviewed your [medicine] dose time on [date] at [time] and set a time for it. It is listed with your doses." |
| Doctor decided no separate dose | "Your doctor reviewed your [medicine] dose time on [date] at [time] and decided it is not given separately." |
| Course ended first | "Your [medicine] dose time on [date] at [time] was not scheduled: the course ended before it was reviewed." |

(The wording for a doctor-set dose later removed by the course ending is
decision F1.)

**What you are asked to decide.** Whether an on-page notice is enough, and
whether the wording is appropriate.

**Patient-safety considerations.** A patient who does not open the page may
not know the dose time is on hold. With no reminder, they may take the dose
on their own judgement, or not at all. Unclear wording could be read as an
instruction.

**Questions requiring an explicit answer.**

- D.a. Is an on-page notice enough, or should the patient also be notified
  (for example a phone notification)?
- D.b. Is each sentence above clinically appropriate? If not, what wording
  should be used?

---

### Decision E: alerting the doctor

**Situation.** The treating doctor needs to know there is a dose time to
decide.

**Current provisional behaviour.** The doctor receives a RecoverEase
notification: "A [medicine] dose time for [patient] on [date] at [time] needs
your review because of a clock change."

- It is sent once when the conflict is found.
- One more is sent 24 hours before the dose time if it is still undecided
  (only if the first came earlier than that): "Still awaiting your review:
  a [medicine] dose time for [patient] on [date] at [time] (clock change)."
- Never more than two per conflict.
- Only to the treating doctor, and only while their account is active. What
  happens when that doctor changes is decision I.

**What you are asked to decide.** Whether this timing, number and recipient
are appropriate.

**Patient-safety considerations.** Too few or too late alerts can leave a
dose time undecided when it arrives. In that case no dose takes place (see
section 5.4).

**Questions requiring an explicit answer.**

- E.a. Is one alert when found, plus one 24 hours before, appropriate?
- E.b. Should anyone other than the treating doctor be alerted?

---

### Decision F: adherence

**Situation.** How conflicts affect the adherence figure that the patient
and doctor see.

**Current provisional behaviour.** Conflicts are not counted as taken or
missed, and are not part of the adherence figure. They are listed beside it,
with the note "Not counted in the adherence figure above". Each conflict
carries one of these labels:

| Label | When it is used |
|---|---|
| "Awaiting doctor review" | Held, not yet decided, and its time has not passed. |
| "Not scheduled: unresolved clock-change review" | Its time passed with no decision. |
| "Rescheduled by the doctor" | The doctor set a time; that dose is listed with the patient's doses. |
| "Doctor decided: not given separately" | The doctor recorded no separate dose. |
| "Course ended before review" | The course ended before a decision (decision H). |

The same labels appear:

- on the summary next to adherence, on the patient's page and the doctor's
  patient page;
- in the printed report;
- as the heading of each notice the patient reads (decision D);
- in the doctor's list of dose times.

The system has one more label, "Rescheduled, then the course ended before
it", for a dose the doctor set that was later removed by the course ending.
Its wording is decision F1, not F.

A dose time the doctor rescheduled becomes an ordinary dose, and counts in
adherence like any other.

**What you are asked to decide.** Whether conflicts should be kept out of
adherence, and whether the labels are appropriate.

**Patient-safety considerations.**

- Counting conflicts as missed would unfairly lower a patient's adherence.
- Leaving them out without showing them could hide doses that never took
  place.

**Questions requiring an explicit answer.**

- F.a. Should conflicts be kept out of the adherence figure and listed
  beside it?
- F.b. Are the five labels above appropriate? If not, what should they say?

---

### Decision F1: a doctor-set dose removed because the course ended

**Situation.**

1. The doctor sets a time for a held dose (decision C).
2. Later, before that time, the medication course is ended.
3. Ending a course removes all doses still to come after the end date, so the
   dose the doctor set is removed too.
4. The doctor's decision itself stays on record.

**Current provisional behaviour.**

- **The doctor sees:** "Rescheduled, then the course ended before it", with
  the reason they wrote.
- **The patient reads:** "Your doctor reviewed your [medicine] dose time on
  [date] at [time] and set a time for it, but the course ended before that
  time, so it is not among your doses."

**What you are asked to decide.** Only the **wording**: whether this is
clinically appropriate, and what the patient and the doctor should each be
told. (Whether a later extension of the course brings this dose time back is
decision H1.)

**Patient-safety considerations.** Confusing wording could lead a patient to
believe the dose is still due, or that they missed it.

**Questions requiring an explicit answer.**

- F1.a. Is the patient's sentence above appropriate? If not, what should the
  patient read?
- F1.b. Is the doctor's label above appropriate? If not, what should the
  doctor see?

---

### Decision G: a clinic changing time zone

**Situation.** A clinic changes its time zone setting (for example after
relocating). Doses for the next 30 days have already been created at moments
based on the old time zone.

**Current provisional behaviour.**

- Doses already created keep their **exact original moment**. In the new
  local time they may show a different clock time than prescribed.
- Days not yet created follow the new time zone.
- If a new day's dose would fall at **exactly** the same moment as a dose
  already scheduled, it is held for the doctor as a conflict (decisions C to
  F apply).
- In practice the transition lasts about 30 days, and the doctor may have a
  few dose times to review once.

**What you are asked to decide.** Whether this transition is acceptable, or
what should happen instead.

**Patient-safety considerations.** During the transition, doses can come at
unexpected local times or at uneven intervals. How close doses may be is
G1.

**Questions requiring an explicit answer.**

- G.a. Is it acceptable that doses already scheduled keep their original
  moment for up to 30 days?
- G.b. Is holding an exact same-moment clash for the doctor appropriate?
- G.c. Is this decision applicable to the clinics RecoverEase serves?

---

### Decision G1: minimum spacing between doses of the same medicine

**Situation.** The system only catches two doses at *exactly* the same
moment. It does not catch doses that are *close together*. This can happen
in two ways.

1. **After a time zone change (automatic doses).** Old-zone and new-zone
   doses can fall close together. For example, when a clinic moves from Los
   Angeles to Manila, a medicine prescribed at 08:00, 14:00 and 20:00 has
   doses only **2 hours apart** around the changeover. One day's 20:00 dose
   comes *after* the next day's 08:00 dose.
2. **When the doctor chooses a time (decision C).** The doctor's time is only
   refused if it is at exactly another dose's moment. A time a few minutes
   before or after another dose of the same medicine is accepted.

**Current provisional behaviour.** Close-together doses are created and
reminded as normal. No minimum interval is applied anywhere.

**What you are asked to decide.** Whether a minimum interval between doses
of the same medicine is needed and, if so, how it should work. **No interval
has been assumed**: any number must come from you.

**Patient-safety considerations.** Without a minimum interval, a patient
could be reminded to take two doses of the same medicine much closer
together than prescribed. A single interval might suit some medicines and
not others. A rule that blocks the doctor could also stop a deliberate
clinical choice.

**Questions requiring an explicit answer.**

- G1.a. Is a minimum interval between doses of the same medicine needed?
- G1.b. If yes, what interval?
- G1.c. Should one interval apply to all medicines, or should it vary (for
  example by medicine or by dosing frequency)? If it varies, how?
- G1.d. Should the interval also apply to a time the doctor chooses?
- G1.e. When a dose would break the interval, should the system **block** it
  (hold an automatic dose for the doctor; refuse the doctor's time), or only
  **warn**?
- G1.f. Is this decision applicable to the clinics RecoverEase serves?

---

### Decision H: a course ends while a conflict is still pending

**Situation.** The doctor ends a medication course early. A held dose time
after the new end date has not yet been decided.

**Current provisional behaviour.** The conflict is closed as "Course ended
before review". It stays on record and is never deleted. The patient and
doctor can both see it, and there is nothing left for the doctor to decide.

**What you are asked to decide.** Whether closing it this way is
appropriate.

**Patient-safety considerations.** A dose time is closed without a doctor's
decision. Since the course has ended, this is usually expected, but you may
want a different outcome.

**Questions requiring an explicit answer.**

- H.a. When a course ends, should pending conflicts after the end date be
  closed as "Course ended before review"?

---

### Decision H1: a course ended and later extended

**Situation.**

1. A course is ended early.
2. Any pending conflict after the end date is closed (decision H). Any dose
   the doctor had already set after the end date is removed (decision F1).
3. Later the course is **extended** again.

Ordinary doses for the extended period are created again. These earlier
dose times are not.

**Current provisional behaviour.**

- The closed conflict **stays closed**. That dose time gets neither a dose
  nor a new review, and the patient still reads "Course ended before review".
- A dose the doctor had set and that was removed is **not recreated**. The
  patient and doctor still read "Rescheduled, then the course ended before
  it".
- The website currently has no button to extend a course; ending sets the
  end date to today. A later end date can only be set outside the website
  today, or by a future feature, which is why this needs a decision now.

**What you are asked to decide.** Only what happens **on extension**:

- whether those dose times should be reopened for the treating doctor;
- what should happen to each dose time;
- whether a new doctor decision is needed.

**Patient-safety considerations.** Inside an extended course, a dose time
could silently have no dose at all. Reopening it would ask the doctor to
decide again, with more alerts.

**Questions requiring an explicit answer.**

- H1.a. When a course is extended, should a conflict closed as "Course ended
  before review" be reopened for the treating doctor?
- H1.b. Should a dose the doctor had set, removed when the course ended, be
  recreated, reopened for a new decision, or left as it is?
- H1.c. If reopened, must the doctor make a new decision, or does the
  earlier decision stand?

---

### Decision I: the treating doctor is deactivated, or the patient is reassigned

**Situation.** While a dose time is held, the treating doctor leaves or is
deactivated, or the clinic administrator reassigns the patient to another
doctor.

**Current provisional behaviour.** The alerts in decision E are sent to
whoever is the patient's treating doctor *at the time each alert goes out*,
and only if that doctor's account is active. Each alert is sent once per
conflict, never repeated.

- **While the treating doctor is deactivated:** no alert is sent to anyone.
  The deactivated doctor can no longer see or decide the conflict. The
  patient still sees their notice.
- **When the patient is reassigned to another doctor:**
  - The new doctor can see the pending conflict on the patient's page, and
    can decide it.
  - If the "conflict found" alert was already sent to the previous doctor,
    the new doctor does **not** receive one. Nothing tells them at the
    moment of reassignment.
  - If that alert was never sent (for example because the previous doctor
    was already deactivated), the new doctor receives it within about 15
    minutes. This happens even if the dose time has already passed by then.
  - The new doctor receives the "still awaiting your review" alert, 24 hours
    before the dose time, only if:
    - it has not already been sent;
    - the first alert went out more than 24 hours before the dose time;
    - the dose time has not yet passed.

**What you are asked to decide.** Who, if anyone, should be told when the
treating doctor is deactivated, and whether a reassignment should alert the
new treating doctor straight away.

**Patient-safety considerations.** If nobody is told, nobody may decide
before the dose time, and no dose takes place (see section 5.4). A newly
assigned doctor may not know about a pending conflict unless they open the
patient's medication page.

**Questions requiring an explicit answer.**

- I.a. When the treating doctor is deactivated, should anyone be alerted?
  If so, who (for example a newly assigned doctor, or a clinic role)?
- I.b. When a patient is reassigned, should the new treating doctor receive
  an immediate alert about each pending conflict, even if the previous
  doctor was already alerted?

---

### Decision J: is a written reason required?

**Situation.** Whether the doctor must write why they decided.

**Current provisional behaviour.** A reason of 1 to 1,000 characters is
required for both options. The audit log records that a decision was made,
but not the reason's text.

**What you are asked to decide.** Whether a reason should be required.

**Patient-safety considerations.** Without a reason, the clinical record of
why a dose was moved or not given is weaker. Requiring one is a small extra
step for the doctor. Who may read it is J1.

**Questions requiring an explicit answer.**

- J.a. Should a reason be required for "Set a time", for "No separate dose",
  for both, or for neither?
- J.b. Is a limit of 1,000 characters appropriate?

---

### Decision J1: may the patient read the doctor's reason?

**Situation.** The doctor's written reason is stored with the conflict.

**Current provisional behaviour.**

- The doctor sees the reason on screen. The patient's screen does not show
  it.
- However, the patient's own login can technically read the stored reason
  through the system's data connection. It is not hidden from the patient at
  the database level.
- The reason is never written to the audit log.

**What you are asked to decide.** Whether the reason is meant for the
patient to read, or for clinicians only.

**Patient-safety considerations.**

- A reason written for colleagues could be read by the patient, possibly
  without context.
- If it is restricted instead, the patient loses an explanation.
- "Clinicians only" would need a technical change before production.

**Questions requiring an explicit answer.**

- J1.a. May the patient read the doctor's reason?
- J1.b. If yes, should it also be shown on the patient's screen?

---

### Decision K: wording for a repeated dose time

**Situation.** For decision B, the doctor must say which of the two 01:30s
is meant.

**Current provisional behaviour.** The doctor sees two choices, with neither
selected, for example:

- "Before the clocks go back (GMT-04:00)"
- "After the clocks go back (GMT-05:00)"

All times are shown in the clinic's time zone.

**What you are asked to decide.** Whether this wording is clear enough.

**Patient-safety considerations.** Unclear wording could lead the doctor to
pick the wrong moment, an hour off.

**Questions requiring an explicit answer.**

- K.a. Is this wording clear and appropriate? If not, what should it say?
- K.b. Is this decision applicable to the clinics RecoverEase serves?

---

## 7. Adviser response record

Please give one response per decision, using one of these categories:

- **Approved as proposed**
- **Approved with changes** (please describe the changes)
- **Rejected** (please say what should happen instead, if you can)
- **Not applicable**
- **Further discussion required**

Adviser name and role: ______________________________

| Decision | Adviser response | Conditions or corrections | Approval date | Evidence reference | Status |
|---|---|---|---|---|---|
| A. Time that does not exist | | | | | PENDING |
| B. Time that happens twice | | | | | PENDING |
| C. Doctor's options | | | | | PENDING |
| D. Telling the patient | | | | | PENDING |
| E. Alerting the doctor | | | | | PENDING |
| F. Adherence | | | | | PENDING |
| F1. Doctor-set dose removed by course end (wording) | | | | | PENDING |
| G. Clinic changing time zone | | | | | PENDING |
| G1. Minimum spacing between doses | | | | | PENDING |
| H. Course ends with a pending conflict | | | | | PENDING |
| H1. Course ended, then extended | | | | | PENDING |
| I. Treating doctor deactivated or patient reassigned | | | | | PENDING |
| J. Reason required | | | | | PENDING |
| J1. Patient reading the doctor's reason | | | | | PENDING |
| K. Wording for a repeated time | | | | | PENDING |

**How responses are recorded.**

- A decision's status changes from PENDING only after the adviser's **written
  response** (email, message or signed copy of this table) has been received
  and kept.
- The response is recorded in the adviser's own words, with its date and
  where the original is kept (the "Evidence reference").
- A decision left blank, or marked "Further discussion required", stays
  PENDING.
- "Approved with changes" and "Rejected" mean the system is changed and
  tested again before production.
- No status is changed, and nothing is put into use, without the project
  owner's separate authorisation.
- The working record is `docs/medication-clock-change-decisions.md` in the
  RecoverEase repository.

## 8. Message to the clinical adviser

> **Subject: Clinical review request: medication dose timing during clock
> and time zone changes (RecoverEase)**
>
> Dear [Adviser's name],
>
> I hope you are well. I would like to ask for your clinical review of a
> change to how RecoverEase schedules medication doses when a clinic's clock
> or time zone changes.
>
> **Why your review is needed.** Our current system can create duplicate
> doses after a clinic changes time zone. On daylight-saving days it can drop
> a dose time, or choose one without anyone deciding. We have prepared a
> change that prevents this: when a dose time cannot be scheduled safely, the
> system now holds it for the patient's treating doctor instead of guessing.
> How those dose times should be handled is a clinical matter, so the change
> will not be used until you have reviewed it.
>
> **Current status.** The change is built and tested on our side, but it is
> **not clinically approved** and has **not been put into use**. Every
> behaviour in the attached document is a provisional proposal, not a final
> policy.
>
> **What I am asking.** Please review the attached document, which explains
> all 15 pending decisions (A to K, F1, G1, H1 and J1) in plain terms. For
> each decision, I would be grateful for:
>
> 1. your response: approved as proposed, approved with changes, rejected,
>    not applicable, or further discussion required;
> 2. any conditions, corrections or concerns.
>
> I would particularly value your view on **G1**: whether a minimum interval
> is needed between doses of the same medicine, and if so what interval;
> whether it should be the same for all medicines; whether it should also
> apply to times a doctor chooses; and whether breaking it should block the
> dose or only warn. We have deliberately not assumed any value.
>
> **Written responses.** Please reply in writing (email or message is fine),
> or fill in the response table in section 7, so that your answers can be
> recorded accurately with their date. Any decision left unanswered, or that
> you would like to discuss further, will remain pending, and the related
> behaviour will not be used.
>
> Please feel completely free to reject or revise any proposal. A correction
> or a "no" is just as valuable to us as an approval.
>
> If it is easier, I would be glad to go through the document with you in a
> short meeting.
>
> Thank you very much for your time and guidance.
>
> Kind regards,
>
> Kean Caballero
> RecoverEase (Capstone 2)
