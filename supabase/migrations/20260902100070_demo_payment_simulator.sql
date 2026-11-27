-- ===========================================================================
-- RecoverEase — 70. The internal demo payment simulator
-- ===========================================================================
-- A RecoverEase-only checkout for the capstone demonstration: a Clinic Admin
-- of an allowed clinic "pays" for Basic or Premium, and the outcome they pick
-- (paid, failed or cancelled) is recorded as a real row, moving the clinic's
-- real subscription when it is paid. No payment provider is involved: no
-- PayMongo, no card, no QR payload, no bank or wallet, no money.
--
--   * subscription_payment.payment_provider - now 'paymongo' or
--     'demo_simulator'. A demo row is never live (payment_livemode is false,
--     enforced by a check), so migration 69's revenue figures never count it.
--     Its references are 'demo_cs_…' / 'demo_pay_…', never PayMongo's
--     'cs_' / 'pay_', so the PayMongo functions can never match one.
--   * subscription_payment.payment_demo_method - 'qr_wallet' or 'card': the
--     demo screen the Clinic Admin used. Set on demo rows only.
--   * app_private.demo_payment_simulator_clinic - the server-side switch and
--     allowlist in one: the simulator runs only for a clinic listed here with
--     enabled = true. Seeded with the RecoverEase Defense Demo Clinic, and
--     only where that clinic exists. Nothing signed in can read or change it.
--   * clinic_admin_simulate_demo_payment(plan, method, outcome, request_id) -
--     the only write. The clinic comes from the signed-in Clinic Admin, the
--     price from subscription_plan; the request id makes a repeat of the same
--     request change nothing.
--   * demo_payment_simulator_available() - whether the caller may use it,
--     so the website shows the button only where it would work.
--   * super_admin_demo_payment_activity(...) - the Super Admin's list of demo
--     transactions with summary counts and demo volume. Demo rows only; no
--     person, email or PayMongo reference.
--
-- super_admin_subscription_overview() is NOT changed: revenue stays "paid and
-- payment_livemode", and a demo row can never be live.
--
-- Rollback: supabase/rollbacks/20260902100070_demo_payment_simulator.down.sql
-- ===========================================================================

do $$
begin
  if to_regclass('public.subscription_payment') is null
     or not exists (
       select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'subscription_payment'
          and column_name = 'payment_livemode'
     )
     or to_regprocedure('app_private.require_super_admin()') is null then
    raise exception 'Migration 70 needs migrations 33, 68 and 69 first. Nothing was applied.';
  end if;
end
$$;

-- Every migration from 41 waits at most 3 seconds for a lock. Reset at the end.
set lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Payments: a second source, never live
-- ---------------------------------------------------------------------------
alter table public.subscription_payment
  drop constraint subscription_payment_payment_provider_check;
alter table public.subscription_payment
  add constraint subscription_payment_payment_provider_check
  check (payment_provider in ('paymongo', 'demo_simulator'));

alter table public.subscription_payment
  add column payment_demo_method text
  check (payment_demo_method in ('qr_wallet', 'card'));

comment on column public.subscription_payment.payment_demo_method is
  'The RecoverEase demo checkout screen used (qr_wallet or card). Demo '
  'simulator rows only; nothing was paid through it (migration 70).';

-- A demo row: never live, always a demo method, demo references only. A
-- PayMongo row: no demo method and no demo reference.
alter table public.subscription_payment
  add constraint subscription_payment_demo_rules check (
    case payment_provider
      when 'demo_simulator' then
        not payment_livemode
        and payment_demo_method is not null
        and provider_checkout_id is not null
        and provider_checkout_id ~ '^demo_cs_[0-9a-f]{32}$'
        and (provider_payment_id is null or provider_payment_id ~ '^demo_pay_[0-9a-f]{32}$')
        and provider_payment_intent_id is null
      else
        payment_demo_method is null
        and coalesce(provider_checkout_id, '') !~ '^demo_'
        and coalesce(provider_payment_id, '') !~ '^demo_'
    end
  );

create index subscription_payment_demo
  on public.subscription_payment (payment_created_at desc)
  where payment_provider = 'demo_simulator';

-- ---------------------------------------------------------------------------
-- The server-side switch and allowlist
-- ---------------------------------------------------------------------------
create table app_private.demo_payment_simulator_clinic (
  clinic_id   uuid primary key references public.clinic (clinic_id),
  enabled     boolean not null default true,
  added_at    timestamptz not null default now()
);

comment on table app_private.demo_payment_simulator_clinic is
  'Clinics allowed to use the internal demo payment simulator, and whether it '
  'is on for each. Changed only by the database owner (migration 70).';

revoke all on table app_private.demo_payment_simulator_clinic from public, anon, authenticated;

-- The RecoverEase Defense Demo Clinic, where it exists (production). Nowhere
-- else: a database without it gets no row, and so no simulator.
insert into app_private.demo_payment_simulator_clinic (clinic_id)
select c.clinic_id
  from public.clinic c
 where c.clinic_id = 'e0d42c98-7d09-4f0c-aac8-ae42de087335'
on conflict (clinic_id) do nothing;

-- The caller's clinic, when they are a Clinic Admin of an active clinic on
-- which the simulator is enabled; otherwise null.
create or replace function app_private.demo_simulator_clinic_of(p_user_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select a.clinic_id
    from public.admin a
    join public.user_account ua on ua.user_id = a.user_id
    join public.clinic c on c.clinic_id = a.clinic_id
    join app_private.demo_payment_simulator_clinic d on d.clinic_id = a.clinic_id
   where a.user_id = p_user_id
     and ua.user_role = 'admin'
     and c.clinic_status = 'active'
     and d.enabled
$$;

revoke all on function app_private.demo_simulator_clinic_of(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Is it available to me?
-- ---------------------------------------------------------------------------
create or replace function public.demo_payment_simulator_available()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app_private.demo_simulator_clinic_of((select auth.uid())) is not null
$$;

comment on function public.demo_payment_simulator_available() is
  'True when the signed-in user is a Clinic Admin of an active clinic on '
  'which the demo payment simulator is enabled (migration 70).';

revoke all on function public.demo_payment_simulator_available() from public, anon;
grant execute on function public.demo_payment_simulator_available() to authenticated;

-- ---------------------------------------------------------------------------
-- A simulated payment
-- ---------------------------------------------------------------------------
-- The clinic is the caller's, the price is the plan's, the row is never live.
-- The request id is the website's, made once per checkout: the same id again
-- returns the row it made and changes nothing, so a double press or a retry
-- after a lost answer never pays or extends twice. The clinic's active
-- subscription is locked first, so two requests for one clinic run one after
-- the other.
--
-- Paid: the plan already held is extended by a month from the end of its
-- period; another plan replaces the current one from now (as migration 68's
-- billing_apply_paid_checkout does for PayMongo). Failed and cancelled are
-- recorded and change no subscription.
create or replace function public.clinic_admin_simulate_demo_payment(
  p_plan_code text,
  p_method text,
  p_outcome text,
  p_request_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_clinic uuid;
  v_plan public.subscription_plan;
  v_current public.clinic_subscription;
  v_existing public.subscription_payment;
  v_row public.subscription_payment;
  v_key text;
  v_subscription uuid;
  v_period_end timestamptz;
begin
  v_clinic := app_private.demo_simulator_clinic_of(v_user);
  if v_clinic is null then
    raise exception 'The demo checkout is only for the Clinic Admin of a clinic it is enabled for'
      using errcode = 'insufficient_privilege';
  end if;

  if p_plan_code is null or p_plan_code not in ('basic', 'premium') then
    raise exception 'Only Basic or Premium can be bought through the demo checkout'
      using errcode = 'check_violation';
  end if;
  if p_method is null or p_method not in ('qr_wallet', 'card') then
    raise exception 'Choose QR / Wallet Demo or Card Demo'
      using errcode = 'check_violation';
  end if;
  if p_outcome is null or p_outcome not in ('paid', 'failed', 'cancelled') then
    raise exception 'Unknown demo outcome'
      using errcode = 'check_violation';
  end if;
  if p_request_id is null then
    raise exception 'A demo checkout needs its request id'
      using errcode = 'check_violation';
  end if;

  select * into v_plan
    from public.subscription_plan p
   where p.plan_code = p_plan_code and p.plan_price_centavos > 0;
  if not found then
    raise exception 'That plan has no price' using errcode = 'check_violation';
  end if;

  -- One request at a time per clinic.
  select * into v_current
    from public.clinic_subscription s
   where s.clinic_id = v_clinic and s.subscription_status = 'active'
   for update;

  v_key := replace(p_request_id::text, '-', '');

  select * into v_existing
    from public.subscription_payment sp
   where sp.provider_checkout_id = 'demo_cs_' || v_key;
  if found then
    if v_existing.clinic_id is distinct from v_clinic then
      raise exception 'That demo request belongs to another clinic'
        using errcode = 'insufficient_privilege';
    end if;
    return jsonb_build_object(
      'result', 'duplicate',
      'payment_id', v_existing.payment_id,
      'reference', 'RE-' || upper(substr(v_key, 1, 10)),
      'status', v_existing.payment_status,
      'plan_code', v_existing.plan_code,
      'plan_name', v_existing.plan_name_snapshot,
      'amount_centavos', v_existing.payment_amount_centavos,
      'method', v_existing.payment_demo_method,
      'period_end', (select s.subscription_period_end from public.clinic_subscription s
                      where s.clinic_id = v_clinic and s.subscription_status = 'active')
    );
  end if;

  if v_current.plan_code = 'enterprise' then
    raise exception 'An Enterprise agreement is changed with RecoverEase, not here'
      using errcode = 'check_violation';
  end if;

  if p_outcome = 'paid' then
    if v_current.subscription_id is not null and v_current.plan_code = p_plan_code then
      update public.clinic_subscription
         set subscription_period_end =
               greatest(subscription_period_end, now()) + interval '1 month',
             subscription_updated_at = now()
       where subscription_id = v_current.subscription_id
       returning subscription_id, subscription_period_end into v_subscription, v_period_end;
    else
      if v_current.subscription_id is not null then
        update public.clinic_subscription
           set subscription_status = 'replaced',
               subscription_period_end = greatest(now(), subscription_period_start + interval '1 second'),
               subscription_updated_at = now()
         where subscription_id = v_current.subscription_id;
      end if;

      insert into public.clinic_subscription
        (clinic_id, plan_code, subscription_status, subscription_billing_interval,
         subscription_period_start, subscription_period_end)
      values
        (v_clinic, p_plan_code, 'active', 'month', now(), now() + interval '1 month')
      returning subscription_id, subscription_period_end into v_subscription, v_period_end;
    end if;

    insert into public.subscription_payment
      (clinic_id, subscription_id, plan_code, plan_name_snapshot, payment_amount_centavos,
       payment_currency, payment_status, payment_provider, provider_checkout_id,
       provider_payment_id, payment_paid_at, payment_livemode, payment_demo_method,
       created_by_user_id)
    values
      (v_clinic, v_subscription, v_plan.plan_code, v_plan.plan_name, v_plan.plan_price_centavos,
       v_plan.plan_currency, 'paid', 'demo_simulator', 'demo_cs_' || v_key,
       'demo_pay_' || v_key, now(), false, p_method, v_user)
    returning * into v_row;
  else
    insert into public.subscription_payment
      (clinic_id, plan_code, plan_name_snapshot, payment_amount_centavos, payment_currency,
       payment_status, payment_provider, provider_checkout_id, payment_livemode,
       payment_demo_method, created_by_user_id)
    values
      (v_clinic, v_plan.plan_code, v_plan.plan_name, v_plan.plan_price_centavos, v_plan.plan_currency,
       p_outcome, 'demo_simulator', 'demo_cs_' || v_key, false, p_method, v_user)
    returning * into v_row;
    v_period_end := v_current.subscription_period_end;
  end if;

  return jsonb_build_object(
    'result', case p_outcome when 'paid' then 'activated' else p_outcome end,
    'payment_id', v_row.payment_id,
    'reference', 'RE-' || upper(substr(v_key, 1, 10)),
    'status', v_row.payment_status,
    'plan_code', v_row.plan_code,
    'plan_name', v_row.plan_name_snapshot,
    'amount_centavos', v_row.payment_amount_centavos,
    'method', v_row.payment_demo_method,
    'period_end', v_period_end
  );
end;
$$;

comment on function public.clinic_admin_simulate_demo_payment(text, text, text, uuid) is
  'Records a simulated Basic or Premium payment (paid, failed or cancelled) '
  'for the calling Clinic Admin''s own clinic, priced from subscription_plan, '
  'never live, once per request id. Paid moves the clinic''s subscription. '
  'Only where the demo simulator is enabled (migration 70).';

revoke all on function public.clinic_admin_simulate_demo_payment(text, text, text, uuid) from public, anon;
grant execute on function public.clinic_admin_simulate_demo_payment(text, text, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The Super Admin's view of demo transactions
-- ---------------------------------------------------------------------------
-- Demo simulator rows only. Summary over every demo row; the list is
-- filtered (clinic, status, method, Asia/Manila dates) and paged, newest
-- first. The clinic list is the clinics that can or did use the simulator,
-- for the filter. No person, email or PayMongo reference.
create or replace function public.super_admin_demo_payment_activity(
  p_clinic_id uuid default null,
  p_status text default null,
  p_method text default null,
  p_from date default null,
  p_to date default null,
  p_page integer default 0,
  p_page_size integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_page integer := greatest(coalesce(p_page, 0), 0);
  v_size integer := least(greatest(coalesce(p_page_size, 20), 1), 100);
begin
  perform app_private.require_super_admin();

  if p_status is not null and p_status not in ('pending', 'paid', 'failed', 'cancelled') then
    raise exception 'Unknown payment status' using errcode = 'check_violation';
  end if;
  if p_method is not null and p_method not in ('qr_wallet', 'card') then
    raise exception 'Unknown demo method' using errcode = 'check_violation';
  end if;

  return jsonb_build_object(
    'summary', (
      select jsonb_build_object(
        'total', count(*),
        'paid', count(*) filter (where sp.payment_status = 'paid'),
        'failed', count(*) filter (where sp.payment_status = 'failed'),
        'cancelled', count(*) filter (where sp.payment_status = 'cancelled'),
        'pending', count(*) filter (where sp.payment_status = 'pending'),
        'demo_volume_centavos', coalesce(sum(sp.payment_amount_centavos)
                                  filter (where sp.payment_status = 'paid'), 0)
      )
        from public.subscription_payment sp
       where sp.payment_provider = 'demo_simulator'
    ),
    'total_matching', (
      select count(*)
        from public.subscription_payment sp
       where sp.payment_provider = 'demo_simulator'
         and (p_clinic_id is null or sp.clinic_id = p_clinic_id)
         and (p_status is null or sp.payment_status = p_status)
         and (p_method is null or sp.payment_demo_method = p_method)
         and (p_from is null or (sp.payment_created_at at time zone 'Asia/Manila')::date >= p_from)
         and (p_to is null or (sp.payment_created_at at time zone 'Asia/Manila')::date <= p_to)
    ),
    'rows', (
      select coalesce(jsonb_agg(r.item order by r.created_at desc, r.payment_id desc), '[]'::jsonb)
        from (
          select sp.payment_created_at as created_at, sp.payment_id,
                 jsonb_build_object(
                   'payment_id', sp.payment_id,
                   'reference', 'RE-' || upper(substr(sp.provider_checkout_id, 9, 10)),
                   'clinic_id', sp.clinic_id,
                   'clinic_name', c.clinic_name,
                   'plan_code', sp.plan_code,
                   'plan_name', sp.plan_name_snapshot,
                   'amount_centavos', sp.payment_amount_centavos,
                   'method', sp.payment_demo_method,
                   'status', sp.payment_status,
                   'created_at', sp.payment_created_at,
                   'paid_at', sp.payment_paid_at
                 ) as item
            from public.subscription_payment sp
            join public.clinic c on c.clinic_id = sp.clinic_id
           where sp.payment_provider = 'demo_simulator'
             and (p_clinic_id is null or sp.clinic_id = p_clinic_id)
             and (p_status is null or sp.payment_status = p_status)
             and (p_method is null or sp.payment_demo_method = p_method)
             and (p_from is null or (sp.payment_created_at at time zone 'Asia/Manila')::date >= p_from)
             and (p_to is null or (sp.payment_created_at at time zone 'Asia/Manila')::date <= p_to)
           order by sp.payment_created_at desc, sp.payment_id desc
           limit v_size offset v_page * v_size
        ) r
    ),
    'clinics', (
      select coalesce(jsonb_agg(jsonb_build_object('clinic_id', c.clinic_id, 'clinic_name', c.clinic_name)
                                order by lower(c.clinic_name)), '[]'::jsonb)
        from public.clinic c
       where exists (select 1 from app_private.demo_payment_simulator_clinic d where d.clinic_id = c.clinic_id)
          or exists (select 1 from public.subscription_payment sp
                      where sp.clinic_id = c.clinic_id and sp.payment_provider = 'demo_simulator')
    ),
    'page', v_page,
    'page_size', v_size,
    'generated_at', now()
  );
end;
$$;

comment on function public.super_admin_demo_payment_activity(uuid, text, text, date, date, integer, integer) is
  'Demo simulator transactions for the Super Admin: summary counts, demo '
  'volume (never revenue) and a filtered, paged list with clinic names. '
  'Super Admin only (migration 70).';

revoke all on function public.super_admin_demo_payment_activity(uuid, text, text, date, date, integer, integer) from public, anon;
grant execute on function public.super_admin_demo_payment_activity(uuid, text, text, date, date, integer, integer) to authenticated;

reset lock_timeout;
