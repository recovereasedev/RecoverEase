-- ===========================================================================
-- Rollback of migration 38 (held_chat_alerts)
-- ===========================================================================
-- Removes the hold on critical alerts: the admin counts, the delivery on
-- hand-over, the hold function, its guard and the column, returning the
-- schema to exactly what 37 left (tests/db/held-chat-alerts.test.ts).
-- Applied as a new migration, with approval. Roll this back before 37's.
--
-- Refused while any alert is still held: dropping the column would drop an
-- alert no clinician has received. Deliver them first - move the patients
-- to an active doctor, or reactivate theirs.
--
-- `chatbot-reply` from 38 on keeps working without it: when an alert cannot
-- be held, it tells the Clinic Admins anyway. Kept: every notification
-- already sent, delivered alerts included, and every flag and summary.
-- ===========================================================================

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'chat_session'
       and column_name = 'chat_session_alert_held_since'
  ) then
    raise exception 'Migration 38 is not applied. Nothing was changed.';
  end if;

  if exists (
    select 1 from public.chat_session
     where chat_session_alert_held_since is not null
  ) then
    raise exception 'A critical alert is still waiting for a clinician. Deliver it - reassign the patients or reactivate their doctor - before rolling back migration 38. Nothing was changed.';
  end if;
end
$$;

drop function public.admin_held_chat_alert_counts();

drop trigger doctor_deliver_held_chat_alerts on public.doctor;
drop trigger patient_deliver_held_chat_alerts on public.patient;
drop function public.chat_alert_deliver_on_handover();
drop function app_private.deliver_held_chat_alerts();

drop function public.hold_chat_alert(uuid);

drop trigger chat_session_guard_held_alert on public.chat_session;
drop function public.chat_session_guard_held_alert();

drop index public.chat_session_alert_held_idx;
alter table public.chat_session drop column chat_session_alert_held_since;
