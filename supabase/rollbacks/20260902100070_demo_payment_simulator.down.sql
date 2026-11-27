-- ===========================================================================
-- Rollback of migration 70 (the internal demo payment simulator)
-- ===========================================================================
-- Refuses while any demo simulator payment exists: restoring migration 68's
-- "paymongo only" check would fail on those rows halfway. Decide what to do
-- with them first (they are simulations, not money). A subscription a demo
-- payment moved is a real subscription row and is not touched here.
-- ===========================================================================

do $$
begin
  if exists (select 1 from public.subscription_payment where payment_provider = 'demo_simulator') then
    raise exception 'There are demo simulator payments; remove them deliberately before rolling back migration 70. Nothing was changed.';
  end if;
end
$$;

set lock_timeout = '3s';

drop function if exists public.super_admin_demo_payment_activity(uuid, text, text, date, date, integer, integer);
drop function if exists public.clinic_admin_simulate_demo_payment(text, text, text, uuid);
drop function if exists public.demo_payment_simulator_available();
drop function if exists app_private.demo_simulator_clinic_of(uuid);
drop table if exists app_private.demo_payment_simulator_clinic;

drop index if exists public.subscription_payment_demo;
alter table public.subscription_payment drop constraint if exists subscription_payment_demo_rules;
alter table public.subscription_payment drop column if exists payment_demo_method;
alter table public.subscription_payment drop constraint subscription_payment_payment_provider_check;
alter table public.subscription_payment
  add constraint subscription_payment_payment_provider_check
  check (payment_provider = 'paymongo');

reset lock_timeout;
