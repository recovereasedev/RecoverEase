-- ===========================================================================
-- RecoverEase — 41. A doctor's notification is a general message, nothing else
-- ===========================================================================
-- Module 7.1 "Send Notification to Patient". The website has only ever sent
-- `general` from it (src/features/notifications/components/notify-patient.tsx),
-- but `notification_insert_doctor_to_patient` checked only whom a doctor was
-- notifying - their own patient, while their account is active - and nothing
-- about what. A direct Data API call could therefore put a doctor's words in
-- front of their patient as a `chat_critical` alert, a medication or an
-- appointment reminder, an announcement, linked to a chat session, already
-- marked read, or as a message of any length.
--
-- This narrows the same policy, keeping its recipient rule word for word, to
-- what the form sends:
--
--   * `notification_type = 'general'` - every other type is raised by the
--     system itself (the reminder jobs, cancellation and reassignment
--     notices, and the guidance chat's critical alerts);
--   * no `chat_session_id` - only a critical-chat alert links a conversation;
--   * unread - it is new to the patient;
--   * a message of 1 to 1,000 characters once trimmed, the form's own limit.
--
-- Nothing the system sends is affected. Every database function that writes
-- a notification - the medication, pre-dose and appointment reminder jobs,
-- `appointment_notify_cancellation` and `admin_reassign_doctor_patients` - is
-- SECURITY DEFINER and runs as its owner, and `chatbot-reply` writes its
-- critical alerts with the service role; RLS does not apply to either. The
-- doctor policy was never their path, so the escalation alerts and the
-- reminders arrive exactly as before (tests/db/doctor-notifications.test.ts).
--
-- Rollback: supabase/rollbacks/20260902100041_doctor_notifications_general_only.down.sql
-- ===========================================================================

-- Replacing the policy locks `notification`, which the reminder jobs write -
-- the pre-dose job every minute. Waiting at most 3 seconds for that lock, the
-- migration fails rather than holding the website up behind it
-- (docs/deployment.md, "Migration timing and run history"). A plain SET, not
-- SET LOCAL, so it holds whether or not the runner wraps this file in one
-- transaction; it is reset at the end.
set lock_timeout = '3s';

drop policy if exists notification_insert_doctor_to_patient on public.notification;

create policy notification_insert_doctor_to_patient
  on public.notification for insert to authenticated
  with check (
    (select app_private.is_user_my_patient(user_id))
    and notification_type = 'general'
    and chat_session_id is null
    and notification_is_read = false
    and char_length(btrim(notification_message)) between 1 and 1000
  );

comment on policy notification_insert_doctor_to_patient on public.notification is
  'Module 7.1: an active doctor may send their own patient a general, unread '
  'message of up to 1,000 characters. Every other notification is written by '
  'SECURITY DEFINER functions or the service role (migration 41).';

-- Back to the server's default for anything else this connection runs.
reset lock_timeout;
