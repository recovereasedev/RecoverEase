# Adviser checklist status

The status of every requirement in the official module list
(`Final Modules.pdf`, "Program Specification - List of Modules": 14 modules,
73 sub-functions) and in the adviser's follow-up list, checked against the
code on 2026-10-29 (branch `feature/adviser-checklist-completion`, started
from `main` `ad3be04` and merged with `main` `e88bc2b`, which adds migration
44).

**Statuses.** *Complete*: the whole path works - screen, rules, database,
tests. *Partial*: part of it is missing, said why. *Blocked*: needs a
product decision or a platform capability the web does not have; the
smallest options are given.

**What "tested" means here.** Database rules are tested on PGlite (real
PostgreSQL, the repository's migrations replayed, Supabase's roles
emulated); screens with Vitest and jsdom; journeys with Playwright in
Chromium against a stubbed Supabase. Nothing on this branch has run against
the hosted Supabase project or on a real phone.

The "No. of Points (1 point per module per user)" row under each module in
`Final Modules.pdf` is the grading rubric - one point per module per user
role - not a feature. The 2nd-half plan's "points system" row read it as one;
nothing is built for it.

## Authentication & User Access

| # | Requirement | Roles | Status | Where |
| --- | --- | --- | --- | --- |
| 1.1 | Account Creation | Doctor, Admin | Complete | `create-account` Edge Function; Register account dialog |
| 1.2 | Login / Logout | All | Complete | `features/auth` |
| 1.3 | Reset Password | All | Complete | Forgot / reset password pages, `reset-account-password` |
| 1.4 | Account Verification (Email) | All | **Blocked - product decision** | Accounts are created confirmed (`email_confirm: true`) because they are handed over in person with a temporary password, and a password-setup link is emailed. The module list names it only as "Account Verification (Email)", for all three roles, and does not say whether an address must be confirmed before first sign-in. Options: (a) require the emailed link before first sign-in and drop in-person temporary passwords; (b) keep both and show whether the address has been used. Either changes `create-account` and onboarding. |
| 1.5 | Role-Based Access Control | All | Complete | RLS on every table; `docs/security.md` |
| 1.6 | Capture Data Privacy Consent | Patient | Complete | `pat_consent_at` at first sign-in |

## User Registration & Account Management

| # | Requirement | Roles | Status | Where |
| --- | --- | --- | --- | --- |
| 2.1 | Register Doctor Account | Admin | Complete | Admin Doctors page |
| 2.2 | Register Patient Account | Doctor | Complete | Doctor Patients page |
| 2.3 | View Patient List | Doctor | Complete | `/doctor/patients` |
| 2.4 | View Patient Profile | Doctor | Complete | `/doctor/patients/:id` |
| 2.5 | Update Patient Information | Doctor | **Complete (this branch)** | Patient details, Edit details: `patient-details-card.tsx` |
| 2.6 | View and Update Doctor Profile | Doctor | Complete | `/doctor/profile` |
| 2.7 | View and Update Patient Profile | Patient | Complete | `/patient/profile` |

## Patient Care - Treatment Plan

| # | Requirement | Roles | Status | Where |
| --- | --- | --- | --- | --- |
| 3.1-3.3 | Create / Update Treatment Plan, Define Goals | Doctor | Complete | Patient record, Treatment tab |
| 3.4 | View Treatment Plan | Patient, Doctor | Complete | `/patient/treatment`, record |
| 3.5 | Download Treatment Plan as PDF | Patient | **Complete (redesigned on this branch)** | The prescription's sheet design; Print prints the same PDF |

## Patient Care - Medication

| # | Requirement | Roles | Status | Where |
| --- | --- | --- | --- | --- |
| 4.1 | Set Medication Schedule | Doctor | Complete | Medication form |
| 4.2 | Configure Automated Medication Reminders | Doctor | Complete | Reminders follow the times the doctor sets (migrations 08, 37) |
| 4.3 | Create/Issue Prescription | Doctor | Complete | Medication form |
| 4.4 | Print/Export Prescription | Doctor | **Complete (this branch)** | Print prints the prescription PDF, not the record |
| 4.5 | View Medication Schedule | Patient, Doctor | Complete | Medications page, record |
| 4.6 | Mark Medication as Taken | Patient | Complete | Medications page |
| 4.7 | Receive Medication Reminders | Patient | Complete | pg_cron jobs; in-app tray |
| 4.8 | View Weekly Adherence Tracking | Patient | Complete | Medications page |
| 4.9 | Configure Medication Reminder Preferences | Patient | Complete | My profile |
| 4.10 | Download Prescription | Patient | Complete (PR #67); **Print now prints it** | Medications page |

## Patient Care - Recovery Monitoring

| # | Requirement | Roles | Status | Where |
| --- | --- | --- | --- | --- |
| 5.1-5.3 | Recovery dashboard, progress charts, adherence | Doctor | Complete | Patient record, Recovery tab |
| 5.4-5.5 | Add / view doctor's notes | Doctor | Complete | Record, Notes tab |
| 5.6 | View Personal Recovery Dashboard | Patient | Complete | Patient dashboard |
| 5.7 | View Recovery Roadmap | Patient | Complete | Treatment plan page (the goals as a path) |
| 5.8 | View Treatment Goals | Patient | Complete | Treatment plan page |
| 5.9-5.10 | Log progress, recovery journal | Patient | Complete | My recovery |
| 5.11 | View Recovery Trend Charts | Patient | Complete | My recovery; 7- and 30-day filters (PR #66) |
| 5.12 | View Recovery Streak | Patient | Complete | My recovery |

## Appointment Management

| # | Requirement | Roles | Status | Where |
| --- | --- | --- | --- | --- |
| 6.1 | Schedule Follow-up Appointment | Doctor | Complete | Appointments |
| 6.2 | View Appointment Calendar | Patient, Doctor | **Complete (this branch)** | `/patient/calendar` (doses, appointments, recorded mood check-ins), `/doctor/calendar` |
| 6.3-6.4 | Review / decide reschedule requests | Doctor | Complete | Appointments |
| 6.5-6.7 | Request reschedule, confirm attendance, history | Patient | Complete | Appointments |

## Notification & Communication Management

| # | Requirement | Roles | Status | Where |
| --- | --- | --- | --- | --- |
| 7.1 | Send Notification to Patient | Doctor | Complete (PR #67) | Notifications page; record. Migrations 41 and 44 applied 2026-10-29: a general, unread message of up to 1,000 characters, dated by the database |
| 7.2 | Post System Announcement | Doctor | Complete | Doctor Announcements (migration 36) |
| 7.3 | Configure Reminder Settings | Doctor | **Partial - product decision** | See below |
| 7.4 | View Notifications and Reminders | Patient | Complete | Notifications |
| 7.5 | View System Announcements | Patient | Complete | Announcements |

**7.3, as the adviser worded it:** "configure or adjust medication and
appointment reminder settings for their patients based on their prescribed
schedules". Today a doctor sets the dose times (which the reminders follow),
and can turn their own appointment reminders off (PR #67, migration 42,
applied 2026-10-29); the clinic sets the pre-dose lead time (migration 37)
and the missed-dose grace period; and the patient sets their own on/off and
preferred time. Which setting a doctor should hold *for a
patient* is not specified, and any of them changes the reminder jobs
running in production. The smallest options, each a migration with its own
tests and approval:

1. **Per prescribed schedule:** the prescribing doctor turns reminders off
   for one schedule (an as-needed medicine) - a column on
   `medication_schedule`, honoured by the pre-dose and follow-up jobs.
2. **Per patient, lead time:** the assigned doctor sets this patient's
   pre-dose lead (5, 10, 15 or 30 minutes), overriding the clinic's.
3. **Per patient, appointment reminder:** the assigned doctor sets how far
   ahead this patient's appointment reminder goes (today 24 hours).

In each, the patient's own "reminders off" still wins. Recommended: option
1, which matches "based on their prescribed schedules" most closely.

## AI Chatbot Support

| # | Requirement | Roles | Status | Where |
| --- | --- | --- | --- | --- |
| 8.1-8.5 | Guidance chat, critical detection and alerts, history, transcripts | Patient, Doctor | Complete | `chatbot-reply` |
| 8.6 | Monitor Chatbot Usage Logs | Admin | Complete | Admin dashboard |
| 8.7 | Configure Chatbot System Prompt | Admin | Complete | System settings |

Live replies were reported running into the 30-second Gemini limit on
`chatbot-reply` v16 and v17 (2026-10-20); v18 is deployed and no end-to-end
check of it is recorded. Needs a production smoke test.

## Reports & Analytics

| # | Requirement | Roles | Status | Where |
| --- | --- | --- | --- | --- |
| 9.1-9.2 | Generate / print recovery report | Doctor | Complete | Doctor Reports |
| 9.3-9.4 | Generate / export system-wide report | Admin | Complete | Admin Reports, PDF and Excel |
| 9.5 | View Recently Generated Reports | Admin | **Complete (this branch, migration 43)** | Each report keeps its figures and downloads again as generated; older ones say theirs were not kept. 43 is not applied: it goes in, verified, before this website is deployed |

## Admin Dashboard, Doctor Accounts, Announcements, Audit, Settings

| # | Requirement | Roles | Status | Where |
| --- | --- | --- | --- | --- |
| 10.1 | View Doctor/Patient Count Overview | Admin | Complete | Admin dashboard |
| 10.2 | View System Usage Statistics | Admin | Complete | Patients and doctors with active counts, accounts by role, upcoming appointments, recent activity, chatbot usage - all from database records |
| 11.1-11.3 | Doctor list, update, deactivate/reactivate | Admin | Complete | Admin Doctors |
| 12.1-12.2 | Create, manage/delete announcements | Admin | Complete | Admin Announcements |
| 13.1-13.2 | View, filter/search audit logs | Admin | Complete | Audit log |
| 14.1-14.2 | System settings, admin profile | Admin | Complete | Settings, profile |

## The adviser's follow-up list

| Requirement | Status |
| --- | --- |
| Offline medication reminders (Patient) | **Complete within what the web allows (this branch).** The patient saves their next 30 days of doses to the phone's own calendar, whose alarms sound offline with RecoverEase closed. A background notification from the site itself, offline, is not possible on the web; a native app or a push service would be its own project. |
| Download prescription (Patient) | Complete; Print now prints the same sheet |
| Recovery roadmap, trend charts | Complete |
| Medicine and appointment calendar (Patient & Doctor) | **Complete (this branch)** |
| Send notification to a specific patient (Doctor) | Complete (PR #67) |
| Configure reminder settings (Doctor) | Partial - product decision (7.3 above) |
| View recently generated reports, with download (Admin) | **Complete (this branch, migration 43; apply 43 before deploying)** |
| View system usage statistics | Complete |
| AI chatbot on/off | Complete (migration 38) |
| Intermittent AI failure handling | Partial: the failure states exist; live Gemini timeouts need a production check |
| Medication reminder lead time (5/10/15/30, default 10) | Complete (migration 37) |
