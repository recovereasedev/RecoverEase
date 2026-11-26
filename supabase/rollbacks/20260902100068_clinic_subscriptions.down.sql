-- ===========================================================================
-- Rollback of migration 68 (clinic_subscriptions)
-- ===========================================================================
-- Removes the plans, subscriptions, payments and webhook records, their
-- functions, the new-clinic trigger and the expiry job.
--
-- THIS DELETES BILLING HISTORY. Every subscription and every payment record,
-- paid ones included, goes with its table. Take a dump of the four tables
-- first (docs/database.md, migration 68) and only roll back with approval.
--
-- Roll the website and the two PayMongo Edge Functions back first: from
-- migration 68 the Super Admin overview and the Clinic Admin settings page
-- read these objects, and `paymongo-checkout` / `paymongo-webhook` write them.
-- Without them those parts show their error state; nothing clinical changes.
-- ===========================================================================

do $$
begin
  if to_regclass('public.clinic_subscription') is null then
    raise exception 'Migration 68 is not applied. Nothing was changed.';
  end if;
end
$$;

set lock_timeout = '3s';

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid)
       from cron.job
      where jobname = 'recoverease-expire-lapsed-subscriptions';
  end if;
end
$$;

drop function if exists public.super_admin_subscription_overview();
drop function if exists public.expire_lapsed_subscriptions();
drop function if exists public.billing_handle_webhook_event(text, text, boolean, text, text, text, bigint, text, timestamptz);
drop function if exists public.billing_mark_unpaid(text, text, text);
drop function if exists public.billing_apply_paid_checkout(text, text, bigint, text, timestamptz);
drop function if exists public.billing_record_checkout(uuid, text, text, text);
drop function if exists public.billing_checkout_quote(uuid, text);
drop function if exists public.clinic_admin_choose_free_plan();

drop trigger if exists clinic_starts_on_free_plan on public.clinic;
drop function if exists app_private.start_clinic_on_free_plan();

drop table if exists public.paymongo_webhook_event;
drop table if exists public.subscription_payment;
drop table if exists public.clinic_subscription;
drop table if exists public.subscription_plan;

reset lock_timeout;
