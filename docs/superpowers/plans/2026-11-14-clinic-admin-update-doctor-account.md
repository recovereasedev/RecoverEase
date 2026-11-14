# Clinic Admin: Update Doctor Account Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Clinic Admin can edit an existing doctor's profile details from Doctor Accounts (module 11.2).

**Architecture:** The database already allows it: `doctor_update_self_or_admin` (migration 30) lets a Clinic Admin update the doctors of their own clinic, and `updateDoctor` / `useUpdateDoctor` already exist. What is missing is the interface. One new dialog, mounted by the page while a doctor is selected, sends only the columns that changed through the existing mutation. No new API function, no new hook. One follow-up migration (54, Task 5), approved by the owner on 2026-11-14, fixes `doc_id` and `doc_created_at` in the database.

**Tech Stack:** React 19, TanStack Query, the app's `Dialog` / `Field` / `FormError` / `SavedNotice`, Vitest + Testing Library, PGlite (`tests/db`), Playwright with the Supabase stub (`e2e`).

**Spec:** the owner's task brief of 2026-11-14, "Implement Clinic Admin - Update Doctor Account".

## Global Constraints

- Editable: `doc_first_name`, `doc_last_name`, `doc_specialization`, `doc_license_no`, `doc_contact_no`. Nothing else is ever sent.
- Never sent: `doc_id`, `user_id`, `clinic_id`, `doc_created_at`, `doc_is_active`, `doc_appointment_reminder_is_enabled`.
- Required (database checks): first name, last name, licence number - non-blank after trimming. Specialisation and contact number are optional; blank is stored as `null`.
- Licence numbers are unique across the whole `doctor` table (`doctor_license_no_key`).
- No contact-number format rule exists anywhere in the project (registration and the doctor's own profile accept any text), so none is added here.
- No RLS change, no change to password reset, activation or reassignment. The only migration is 54 (Task 5), a guard trigger and nothing else.
- British spelling in copy ("licence", "specialisation"), as on the rest of the page.

## Review Focus

- A doctor edits their own contact number while the administrator's dialog is open: the administrator's save must not put the old one back. Only changed columns are sent.
- Save pressed with nothing changed: no request, no "updated" message.
- A second press while saving: one request.
- The licence number is another doctor's: said beside the field, entries kept, no database wording shown.
- The row cannot be updated (another clinic's doctor, or access lost): a plain sentence, nothing saved.

---

### Task 1: The edit dialog and its place on the page

**Files:**
- Create: `src/features/patients/components/edit-doctor-dialog.tsx`
- Modify: `src/features/patients/pages/admin-doctors-page.tsx`
- Test: `tests/unit/admin-edit-doctor.test.tsx`

**Interfaces:**
- Consumes: `useUpdateDoctor(doctorId)` from `@/features/patients/hooks`; `Doctor` from `@/features/patients/api`.
- Produces: `EditDoctorDialog({ doctor: Doctor, onClose: () => void, onSaved: (name: string) => void })`.

- [ ] **Step 1:** Write `tests/unit/admin-edit-doctor.test.tsx` against the page with `fetchAllDoctors`, `updateDoctor` and `setDoctorActive` mocked: an Edit button per doctor; the chosen doctor's values prefilled; only changed, trimmed columns sent; blank required fields refused beside their field with focus; optional fields cleared to `null`; nothing changed sends nothing; duplicate licence (`code: '23505'`) beside the field; other failures in a `FormError`; `PGRST116` as a plain sentence; one request per save; Cancel discards; a reopened dialog starts from the stored values; the list shows the saved values; Reset password and Deactivate unchanged.
- [ ] **Step 2:** Run `npx vitest run --project unit tests/unit/admin-edit-doctor.test.tsx`. Expected: FAIL, no Edit button.
- [ ] **Step 3:** Implement `EditDoctorDialog` as a real `<form>` (Enter submits) inside `Dialog`, with the footer's Save button bound by `form=`; checked on submit with `focusFirstInvalid`; an `inFlight` ref beside `isLoading`.
- [ ] **Step 4:** In the page: an "Edit" button first among each row's actions, the dialog mounted only while a doctor is selected, and a `SavedNotice` above the list.
- [ ] **Step 5:** Run the test again. Expected: PASS.

### Task 2: What the database allows

**Files:**
- Test: `tests/db/clinic-admin-updates-doctor.test.ts`

- [ ] **Step 1:** With a second clinic added in the test's own database: the administrator changes the five columns of their own clinic's doctor and nothing else moves; an administrator of another clinic, another doctor, a patient and a visitor change nothing; `user_id`, `clinic_id` and the reminder setting are refused to the administrator; a duplicate licence raises `23505` on `doctor_license_no_key`; blank names and licence raise `23514`.
- [ ] **Step 2:** Run `npx vitest run --project db tests/db/clinic-admin-updates-doctor.test.ts`. Expected: PASS against the existing migrations. A failure here is a finding to report, not something to fix with a migration.

### Task 3: In the browser

**Files:**
- Test: `e2e/edit-doctor.spec.ts`

- [ ] **Step 1:** As the administrator on `/admin/doctors`: the `PATCH` carries exactly the changed columns for that `doc_id`; the row and the confirmation show the new values and focus returns to the Edit button; Enter saves and Escape closes; a blank field takes focus; a `409` / `23505` answer lands beside the licence field.
- [ ] **Step 2:** Run `npx playwright test e2e/edit-doctor.spec.ts`. Expected: PASS.

### Task 4: Verify

- [ ] `npm run test:unit`, `npm run lint`, `npm run typecheck`, `npm run build`, the doctor-related `tests/db` files, the e2e specs that open `/admin/doctors`, `git diff --check`.

### Task 5: The record ID and registration date, in the database (follow-up)

Task 2 found that migration 30's policy let an administrator rewrite `doc_id` (of a doctor nothing referenced) and `doc_created_at`, and a doctor their own `doc_created_at`. No guard covered either.

**Files:**
- Create: `supabase/migrations/20260902100054_doctor_identity_columns_fixed.sql`, `supabase/rollbacks/20260902100054_doctor_identity_columns_fixed.down.sql`
- Test: `tests/db/doctor-identity-fixed.test.ts`; `tests/db/super-admin-rollback.test.ts` runs the new down-script first.

- [ ] **Step 1:** Tests first: the administrator and the doctor are refused either change, with the row unchanged; so is the service role; both columns sent back unchanged are accepted; the five details, the clinic boundary, activation and the reminder setting behave as before; the migration waits at most 3 s for its lock, runs twice, and rolls back. Expected: FAIL before the migration exists.
- [ ] **Step 2:** One `before update` trigger on `doctor`, `when` either column `is distinct from` its old value, for every writer, `insufficient_privilege`. Expected: PASS. Not applied to production.
