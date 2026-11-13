# UI Shared Components Phase 2B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the shared components, the shared status definitions and the doctor's chat alerts in line with the Phase 2A design system, without changing any data, query, route or permission.

**Architecture:** Most of the change is in class names and copy inside existing shared files (`src/components`, `src/lib/status.ts`). One small new module, `src/features/notifications/chat-alert.ts`, tells the two kinds of chat alert apart using the exact messages the backend writes. The dashboard and the notifications page then show each kind with its own label, icon and tone.

**Tech Stack:** React 19, Tailwind v4 tokens (`src/index.css`), lucide-react, Vitest + Testing Library, Playwright e2e against the local stub.

**Spec:** the owner's Phase 2B brief (2026-11-13), `docs/ui-design.md`, the Phase 2A plan and its review findings. Base `origin/main` `132126d` (PR #81 merged).

## Global Constraints

- Tokens only; no new colours. Light primary `#2563EB`, dark blue `#1D4FC4`, teal `#14B8A6`/`#0F766E`, ink `#0F2747`, muted `#4B5F7A`.
- No new text style below 14px in the shared components this plan touches. `text-xs` and `text-label-sm` tokens stay 12px; page-specific uses stay for later phases.
- Red only for a trustworthy emergency or critical signal. Amber for clinical attention. Neutral for technical or system failures. Teal for success.
- Do not infer clinical urgency from text. The chat-alert split uses the two fixed system messages the backend itself matches on, never patient text.
- No change to queries, RLS, routes, read/unread behaviour, escalation, Edge Functions, migrations or business logic. No patient-message preview on any dashboard.
- Copy: calm, short, plain. Keep safety, consent, privacy and dosage text.
- No commit, push or PR until the owner reviews.

## Approaches considered (from brainstorming; the owner's brief pre-approved the scope)

- **Chat-alert split, A (chosen):** match `notification_message` against the two backend constants, mirrored in the client and pinned to the backend files by a test. No query change. Unknown chat-alert text falls back to the concern treatment, so nothing real is ever shown as a mere technical fault.
- **B:** embed `chat_session_has_critical_flag` in the notifications query. Rejected: changes the API query, is null for readers who may not see the conversation, and a flagged conversation can also receive a later "unanswered" alert, so it cannot tell the two apart.
- **C:** a new notification type. Rejected: needs a migration and an Edge Function deploy, both out of scope.
- **Text floor, A (chosen):** change the 12px classes inside the in-scope shared components to `text-sm` (15px). **B:** raise the `text-label-sm`/`text-xs` tokens to 14px. Rejected: changes 27 files at once, including the app shell and page-specific labels the brief defers.

## Challenges I put to the plan (grill-me is not installed; done by hand)

- *Does sorting concerns above unanswered alerts change escalation?* No: same items, same links, same read state; only the order inside the "Needs attention" card.
- *Does making a missed dose amber hide it?* It keeps its own label ("Missed") and icon, and stays apart from "Overdue" by both. Amber is the design's attention colour; red is kept for emergencies.
- *Will 15px badges and table headings break narrow layouts?* Checked by the e2e responsive specs and screenshots at 320, 375, 768 and 1280.
- *Is the app shell's bottom bar (12px) in scope?* No. It is navigation layout, deferred to the shell phase; listed as deferred.

## Review Focus

- A chat alert whose text matches neither constant (older rows, a future message): must show as a concern, not as a technical fault.
- An unanswered-message alert on a conversation that was flagged earlier: must still show as unanswered (the message decides, not the flag).
- The notifications page for a patient or an admin: unchanged apart from tone and size.
- A disabled or loading primary button: hover must not change it; focus ring stays.
- Dark theme: every changed tone pairing must still clear 4.5:1 (existing theme-token tests cover the tokens used).

---

### Task 1: Shared status tones

**Files:** Modify `src/lib/status.ts`; Test `tests/unit/status-tones.test.ts` (new), update `tests/unit/dose-status.test.ts:100`.

- [ ] Test `no shared status is red`: every descriptor in `appointmentStatus`, `rescheduleRequestStatus`, `treatmentPlanStatus`, `treatmentGoalStatus`, `medicationLogStatus`, `patientDoseStatus`, `patientStatus`, `doctorAccountStatus` has `tone !== 'danger'`.
- [ ] Test the exact tones: appointment `cancelled` neutral, reschedule `declined` neutral, patient dose `missed` warning, doctor `inactive` neutral; `overdue` and `missed` keep different labels and icons.
- [ ] Run `npx vitest run --project unit tests/unit/status-tones.test.ts`; expect FAIL on the four red entries.
- [ ] Change the four tones; update the dose-status expectation and the comment above `patientDoseStatus`.
- [ ] Run the two test files; expect PASS.

### Task 2: Button states and the chat Send button

**Files:** Modify `src/features/chat/pages/patient-chat-page.tsx:1005`; Test `tests/unit/button-states.test.ts` (new).

- [ ] Test `every filled control darkens on hover and press`: read `src/index.css` fill tokens; for each `buttonVariants` variant with `bg-fill-*`, hover and active fills have lower luminance than rest.
- [ ] Test `no class list makes a fill lighter on hover`: scan `src/**/*.tsx` string literals that hold both `bg-fill-X-N` and `hover:bg-fill-X-M`; hover luminance must be lower. Expect FAIL on the chat Send button.
- [ ] Remove the Send button's `bg-fill-brand-700 … hover:bg-fill-brand-800` override so it uses the primary variant (rest `#2563EB`, hover `#1D4FC4`, press `#183F9C`).
- [ ] Run; expect PASS.

### Task 3: Shared component text floor and neutral failures

**Files:** Modify `src/components/ui/badge.tsx`, `progress.tsx`, `data-table.tsx`, `tabs.tsx`, `src/components/layout/theme-control.tsx`, `src/components/feedback/state-view.tsx`; Test `tests/unit/shared-text-floor.test.ts` (new).

- [ ] Test: none of those six files contains `text-xs`, `text-label-sm` or `text-[10-13px]`. Expect FAIL.
- [ ] Test: `ErrorState` renders its icon without a `danger` class (a load failure is technical, not clinical). Expect FAIL.
- [ ] Badge `text-sm`, icon `size-4`; ProgressRing centre `text-sm`; THead `text-sm font-semibold` in sentence case (drop `uppercase tracking-wider`); tab count `text-sm`; theme legend `text-sm`; ErrorState detail `text-sm`; ErrorState icon `text-neutral-500`.
- [ ] Shorten the permission error copy to "Your account can't view or change this. If this seems wrong, contact your care team."
- [ ] Run unit suite for the touched components; expect PASS.

### Task 4: Chat-alert kinds on the dashboard and the notifications page

**Files:** Create `src/features/notifications/chat-alert.ts`; Modify `src/features/dashboard/pages/doctor-dashboard.tsx`, `src/features/notifications/pages/notifications-page.tsx`; Test `tests/unit/chat-alert.test.ts`, `tests/unit/doctor-dashboard-alerts.test.tsx` (new), extend `tests/unit/critical-notification-link.test.tsx`.

**Interfaces — Produces:**
- `type ChatAlertKind = 'concern' | 'unanswered'`
- `chatAlertKind(n: { notification_type: NotificationType; notification_message: string }): ChatAlertKind | null`
- `CHAT_ALERT: Record<ChatAlertKind, { label: string; summary: string; icon: LucideIcon; tone: 'warning' | 'neutral' }>`

- [ ] Test the constants equal `CRITICAL_ALERT_MESSAGE` and `NEEDS_REVIEW_MESSAGE` from `supabase/functions/_shared`; `chatAlertKind` gives `concern`, `unanswered`, `concern` for unknown chat text, `null` for other types. FAIL (module missing).
- [ ] Implement the module. Labels: concern "Possible concern" / "A patient raised a concern in the guidance chat." (AlertTriangle, warning); unanswered "Unanswered message" / "The assistant couldn't answer a patient's message." (MessageSquareOff, neutral).
- [ ] Dashboard test: a concern row shows "Possible concern" with a warning tint; an unanswered row shows "Unanswered message" with no warning tint; concerns are listed first; both link to the conversation; no patient message text. FAIL.
- [ ] Dashboard: use `CHAT_ALERT` per row, list concerns first, drop the section description "Waiting on your decision or your review.", shorten the empty line to "Nothing needs your attention right now." and the error line to "Chat alerts couldn't be checked just now."
- [ ] Notifications-page test: an unanswered alert row shows "Unanswered message", a neutral icon and no warning tint; a concern row keeps the warning tint and shows "Possible concern". FAIL.
- [ ] Notifications page: a small label (`Badge`) before the message for chat alerts, per-kind icon and tint. Empty-state description only for patients.
- [ ] Run the four test files; expect PASS.

### Task 5: Comments, docs, review, verification

**Files:** Modify `src/components/layout/page-header.tsx:38-41`, `src/components/ui/section-heading.tsx:20-24`, `docs/ui-design.md` (Phase 2B section).

- [ ] Update the two comments to Figtree 36/700 title, 22/700 section heading, 17px body.
- [ ] `docs/ui-design.md`: record the status-tone rules, the chat-alert split and what is still deferred.
- [ ] `/code-review` and ponytail-review on the diff; fix Critical/Important.
- [ ] Screenshots at 1280, 768, 375, 320 in Light and Dark for the doctor dashboard, notifications, a badge-heavy page and patient chat, against the local stub.
- [ ] Serially: `npm run lint`, `npm run typecheck`, `npm run test:unit`, `npm run build`, targeted `npm run test:e2e`; then the full e2e.
