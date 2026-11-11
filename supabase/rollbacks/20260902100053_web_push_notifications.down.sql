-- ===========================================================================
-- Rollback of migration 53 (web_push_notifications)
-- ===========================================================================
-- Removes Web Push: the queue, every saved device, the trigger on
-- `notification` and the functions. Reminders keep being stored and shown
-- in the app exactly as before 53; no notification row is changed.
--
-- Run supabase/manual/web_push_deactivate.sql first if delivery was turned
-- on, so no pg_cron job keeps calling a function that is gone. This file
-- also removes the job if it is still there.
--
-- Data loss: every patient's push subscription is deleted. After a
-- re-apply, patients switch push on again on each device.
--
-- Re-runnable: every statement is "if exists".
-- ===========================================================================

set lock_timeout = '3s';

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid)
       from cron.job
      where jobname = 'recoverease-push-deliveries';
  end if;
end
$$;

drop trigger if exists notification_enqueue_push on public.notification;
drop function if exists app_private.enqueue_push_deliveries();
drop function if exists app_private.request_push_dispatch();
drop function if exists public.claim_push_deliveries(integer);
drop function if exists public.complete_push_delivery(uuid, text, integer, text, integer);
drop function if exists public.register_push_subscription(text, text, text, text);
drop function if exists public.unregister_push_subscription(text);
drop table if exists public.push_delivery;
drop table if exists public.push_subscription;

reset lock_timeout;
