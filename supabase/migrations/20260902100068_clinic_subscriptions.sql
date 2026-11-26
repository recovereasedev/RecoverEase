-- ===========================================================================
-- RecoverEase — 68. Clinic subscriptions, PayMongo sandbox payments, and the
-- Super Admin's subscriber and revenue figures
-- ===========================================================================
-- Four plans, one current subscription per clinic, and the payments that
-- move a clinic onto a paid plan:
--
--   * subscription_plan     - Free (PHP 0, forever), Basic (PHP 999 a
--                             month), Premium (PHP 2,499 a month) and
--                             Enterprise (custom: no list price at all).
--                             Seeded only where missing, so a price already
--                             agreed is never overwritten.
--   * clinic_subscription   - a clinic's plan over a period. At most one
--                             `active` row per clinic (a unique index), and
--                             every clinic has one: the existing clinics are
--                             backfilled onto Free, and every new clinic
--                             starts on Free (a trigger). An Enterprise row
--                             carries its own agreed price.
--   * subscription_payment  - one row per checkout: the plan and amount as
--                             they were when the checkout was made (a
--                             snapshot), its status, and PayMongo's
--                             references. No card number, CVC or any other
--                             payment detail is stored - PayMongo's hosted
--                             checkout collects those, never RecoverEase.
--   * paymongo_webhook_event- each PayMongo event id once, with what was done
--                             with it. Not the payload.
--
-- Money is integer centavos (bigint) throughout: PHP 999.00 is 99900. No
-- float, no numeric rounding.
--
-- Who may do what:
--   * Anyone signed in may read the plans (names and prices).
--   * A Clinic Admin may read their own clinic's subscriptions and payments
--     (RLS on app_private.admin_clinic_id()), and move their clinic to Free.
--     Nobody else reads them through the Data API: not a doctor, not a
--     patient, not another clinic's Clinic Admin.
--   * Nothing signed in can write a subscription or a payment. The paid path
--     runs in the Edge Functions with the service role: `paymongo-checkout`
--     derives the clinic from the verified caller and the price from
--     subscription_plan, and `paymongo-webhook` applies an event only after
--     checking PayMongo's signature. Their functions here are granted to
--     service_role alone.
--   * An assured Super Admin reads platform totals only, through
--     super_admin_subscription_overview(): counts by plan and revenue sums.
--     No clinic, person, payment reference or payload.
--
-- Revenue is the sum of payments PayMongo confirmed paid, at the amount
-- actually paid. Pending, failed and cancelled payments never count; Free
-- never has a payment. Months are Asia/Manila calendar months.
--
-- Paid periods end on their own: a job every 15 minutes (pg_cron, where
-- available) marks a lapsed Basic or Premium subscription `expired` and puts
-- the clinic back on Free, so no clinic is ever left without a plan.
--
-- Nothing here gates any feature: a plan changes what a clinic is billed and
-- what the Super Admin sees, not what anyone can do.
--
-- Rollback: supabase/rollbacks/20260902100068_clinic_subscriptions.down.sql
-- ===========================================================================

do $$
begin
  if to_regprocedure('app_private.require_super_admin()') is null
     or to_regprocedure('app_private.admin_clinic_id()') is null
     or to_regclass('public.clinic') is null then
    raise exception 'Migration 68 needs migrations 29 and 33 first. Nothing was applied.';
  end if;
end
$$;

-- Every migration from 41 waits at most 3 seconds for a lock. Reset at the end.
set lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- The plans
-- ---------------------------------------------------------------------------
create table public.subscription_plan (
  plan_code             text primary key
                        check (plan_code in ('free', 'basic', 'premium', 'enterprise')),
  plan_name             text not null check (length(btrim(plan_name)) > 0),
  -- Null only for Enterprise: its price is whatever each agreement says.
  plan_price_centavos   bigint check (plan_price_centavos >= 0),
  plan_currency         text not null default 'PHP' check (plan_currency = 'PHP'),
  plan_billing_interval text not null
                        check (plan_billing_interval in ('forever', 'month', 'custom')),
  plan_sort_order       smallint not null,
  plan_created_at       timestamptz not null default now(),
  constraint subscription_plan_price_rules check (
    case plan_code
      when 'free'       then coalesce(plan_price_centavos = 0, false) and plan_billing_interval = 'forever'
      when 'enterprise' then plan_price_centavos is null and plan_billing_interval = 'custom'
      else coalesce(plan_price_centavos, 0) > 0 and plan_billing_interval = 'month'
    end
  )
);

comment on table public.subscription_plan is
  'RecoverEase''s four plans and their list prices in centavos. Enterprise has '
  'no list price: each Enterprise subscription stores its agreed price '
  '(migration 68).';

-- Only where missing: a price changed after this migration is kept.
insert into public.subscription_plan
  (plan_code, plan_name, plan_price_centavos, plan_billing_interval, plan_sort_order)
values
  ('free',       'Free',       0,      'forever', 1),
  ('basic',      'Basic',      99900,  'month',   2),
  ('premium',    'Premium',    249900, 'month',   3),
  ('enterprise', 'Enterprise', null,   'custom',  4)
on conflict (plan_code) do nothing;

alter table public.subscription_plan enable row level security;

create policy subscription_plan_select_signed_in
  on public.subscription_plan for select to authenticated
  using (true);

revoke all on public.subscription_plan from anon;
revoke insert, update, delete, truncate on public.subscription_plan from authenticated;

-- ---------------------------------------------------------------------------
-- A clinic's subscriptions
-- ---------------------------------------------------------------------------
create table public.clinic_subscription (
  subscription_id                 uuid primary key default gen_random_uuid(),
  clinic_id                       uuid not null references public.clinic (clinic_id),
  plan_code                       text not null references public.subscription_plan (plan_code),
  -- active: the clinic's current plan. expired: a paid period that ran out.
  -- replaced: left for another plan before its period ended.
  subscription_status             text not null
                                  check (subscription_status in ('active', 'expired', 'replaced')),
  subscription_billing_interval   text not null
                                  check (subscription_billing_interval in ('forever', 'month', 'custom')),
  subscription_period_start       timestamptz not null default now(),
  -- Null while open-ended: Free, or an Enterprise agreement with no end.
  subscription_period_end         timestamptz,
  -- Enterprise only, and required there: the price actually agreed.
  subscription_agreed_price_centavos bigint,
  subscription_created_at         timestamptz not null default now(),
  subscription_updated_at         timestamptz not null default now(),
  constraint clinic_subscription_period_order
    check (subscription_period_end is null or subscription_period_end > subscription_period_start),
  constraint clinic_subscription_agreed_price check (
    (plan_code = 'enterprise' and coalesce(subscription_agreed_price_centavos, 0) > 0)
    or (plan_code <> 'enterprise' and subscription_agreed_price_centavos is null)
  ),
  constraint clinic_subscription_paid_period check (
    plan_code not in ('basic', 'premium') or subscription_period_end is not null
  )
);

comment on table public.clinic_subscription is
  'A clinic''s plan over a period. At most one active row per clinic. Written '
  'only by migration 68''s functions (migration 68).';

-- The rule the Super Admin's counts rest on: one current plan per clinic.
create unique index clinic_subscription_one_active
  on public.clinic_subscription (clinic_id)
  where subscription_status = 'active';

create index clinic_subscription_clinic
  on public.clinic_subscription (clinic_id, subscription_created_at desc);

alter table public.clinic_subscription enable row level security;

create policy clinic_subscription_select_own_clinic_admin
  on public.clinic_subscription for select to authenticated
  using (clinic_id = (select app_private.admin_clinic_id()));

revoke all on public.clinic_subscription from anon;
revoke insert, update, delete, truncate on public.clinic_subscription from authenticated;

-- ---------------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------------
create table public.subscription_payment (
  payment_id                    uuid primary key default gen_random_uuid(),
  clinic_id                     uuid not null references public.clinic (clinic_id),
  -- Set when the payment activates or extends a subscription.
  subscription_id               uuid references public.clinic_subscription (subscription_id),
  -- What was bought, as it was when the checkout was made.
  plan_code                     text not null references public.subscription_plan (plan_code)
                                check (plan_code <> 'free'),
  plan_name_snapshot            text not null,
  payment_amount_centavos       bigint not null check (payment_amount_centavos > 0),
  payment_currency              text not null default 'PHP' check (payment_currency = 'PHP'),
  payment_status                text not null default 'pending'
                                check (payment_status in ('pending', 'paid', 'failed', 'cancelled')),
  payment_provider              text not null default 'paymongo' check (payment_provider = 'paymongo'),
  provider_checkout_id          text unique,
  provider_payment_intent_id    text,
  provider_payment_id           text unique,
  payment_paid_at               timestamptz,
  created_by_user_id            uuid,
  payment_created_at            timestamptz not null default now(),
  payment_updated_at            timestamptz not null default now(),
  constraint subscription_payment_paid_has_proof check (
    payment_status <> 'paid'
    or (payment_paid_at is not null and provider_payment_id is not null and subscription_id is not null)
  )
);

comment on table public.subscription_payment is
  'One row per checkout, with the plan and amount snapshotted. Only paid rows '
  'are revenue. Holds PayMongo references only - never card or account '
  'details (migration 68).';

create index subscription_payment_clinic
  on public.subscription_payment (clinic_id, payment_created_at desc);
create index subscription_payment_subscription
  on public.subscription_payment (subscription_id);
create index subscription_payment_intent
  on public.subscription_payment (provider_payment_intent_id);
create index subscription_payment_paid
  on public.subscription_payment (payment_paid_at)
  where payment_status = 'paid';

alter table public.subscription_payment enable row level security;

create policy subscription_payment_select_own_clinic_admin
  on public.subscription_payment for select to authenticated
  using (clinic_id = (select app_private.admin_clinic_id()));

revoke all on public.subscription_payment from anon;
revoke insert, update, delete, truncate on public.subscription_payment from authenticated;

-- ---------------------------------------------------------------------------
-- PayMongo events seen
-- ---------------------------------------------------------------------------
create table public.paymongo_webhook_event (
  provider_event_id     text primary key,
  event_type            text not null,
  event_livemode        boolean not null,
  processing_status     text not null
                        check (processing_status in ('processed', 'ignored', 'rejected')),
  processing_result     text not null,
  event_received_at     timestamptz not null default now(),
  event_processed_at    timestamptz not null default now()
);

comment on table public.paymongo_webhook_event is
  'Each signed PayMongo event id, once, and what was done with it - so a '
  'repeated delivery changes nothing. No payload is stored (migration 68).';

alter table public.paymongo_webhook_event enable row level security;
-- Only the service role (which bypasses RLS) reads or writes it. A signed-in
-- user's read returns no row (the policy admits none), as for every other
-- table here; no API role can write it and a visitor cannot read it.
create policy paymongo_webhook_event_no_api_access
  on public.paymongo_webhook_event for select to authenticated
  using (false);
revoke all on public.paymongo_webhook_event from anon;
revoke insert, update, delete, truncate on public.paymongo_webhook_event from authenticated;

-- ---------------------------------------------------------------------------
-- Every clinic on a plan
-- ---------------------------------------------------------------------------
-- A new clinic starts on Free, in the same transaction that creates it.
create or replace function app_private.start_clinic_on_free_plan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.clinic_subscription
    (clinic_id, plan_code, subscription_status, subscription_billing_interval)
  values (new.clinic_id, 'free', 'active', 'forever');
  return new;
end;
$$;

revoke all on function app_private.start_clinic_on_free_plan() from public, anon, authenticated;

create trigger clinic_starts_on_free_plan
  after insert on public.clinic
  for each row execute function app_private.start_clinic_on_free_plan();

-- The clinics that exist now: Free from the day they were created. Free
-- costs nothing and gates nothing, so this changes no one's access. Only a
-- clinic with no active subscription is touched, so re-running adds nothing.
insert into public.clinic_subscription
  (clinic_id, plan_code, subscription_status, subscription_billing_interval,
   subscription_period_start)
select c.clinic_id, 'free', 'active', 'forever', c.clinic_created_at
  from public.clinic c
 where not exists (
   select 1 from public.clinic_subscription s
    where s.clinic_id = c.clinic_id and s.subscription_status = 'active'
 );

-- ---------------------------------------------------------------------------
-- A Clinic Admin moves their clinic to Free
-- ---------------------------------------------------------------------------
-- The only subscription write a signed-in user can make, and only for the
-- caller's own clinic, which is read from the database. A paid period still
-- running is given up; the website says so before asking.
create or replace function public.clinic_admin_choose_free_plan()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_clinic uuid := app_private.admin_clinic_id();
  v_current public.clinic_subscription;
  v_new uuid;
begin
  if v_clinic is null then
    raise exception 'Only a Clinic Admin can change their clinic''s plan'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_current
    from public.clinic_subscription
   where clinic_id = v_clinic and subscription_status = 'active'
   for update;

  if found and v_current.plan_code = 'free' then
    return v_current.subscription_id;
  end if;

  if found and v_current.plan_code = 'enterprise' then
    raise exception 'An Enterprise agreement is changed with RecoverEase, not here'
      using errcode = 'check_violation';
  end if;

  if found then
    update public.clinic_subscription
       set subscription_status = 'replaced',
           subscription_period_end = greatest(now(), subscription_period_start + interval '1 second'),
           subscription_updated_at = now()
     where subscription_id = v_current.subscription_id;
  end if;

  insert into public.clinic_subscription
    (clinic_id, plan_code, subscription_status, subscription_billing_interval)
  values (v_clinic, 'free', 'active', 'forever')
  returning subscription_id into v_new;

  return v_new;
end;
$$;

comment on function public.clinic_admin_choose_free_plan() is
  'Moves the calling Clinic Admin''s own clinic to Free. Clinic Admins only '
  '(migration 68).';

revoke all on function public.clinic_admin_choose_free_plan() from public, anon;
grant execute on function public.clinic_admin_choose_free_plan() to authenticated;

-- ---------------------------------------------------------------------------
-- The checkout: priced and recorded by the server
-- ---------------------------------------------------------------------------
-- What a Clinic Admin would pay for a plan, from the database alone: their
-- clinic from their account, the amount from subscription_plan. Called by
-- `paymongo-checkout` with the id of the caller it verified.
create or replace function public.billing_checkout_quote(
  p_user_id uuid,
  p_plan_code text
)
returns table (
  clinic_id uuid,
  plan_code text,
  plan_name text,
  amount_centavos bigint,
  currency text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_clinic uuid;
begin
  select a.clinic_id into v_clinic
    from public.admin a
    join public.user_account ua on ua.user_id = a.user_id
    join public.clinic c on c.clinic_id = a.clinic_id
   where a.user_id = p_user_id
     and ua.user_role = 'admin'
     and c.clinic_status = 'active';

  if v_clinic is null then
    raise exception 'Only a Clinic Admin of an active clinic can subscribe'
      using errcode = 'insufficient_privilege';
  end if;

  if p_plan_code is null or p_plan_code not in ('basic', 'premium') then
    raise exception 'Only Basic or Premium can be bought online'
      using errcode = 'check_violation';
  end if;

  return query
    select v_clinic, p.plan_code, p.plan_name, p.plan_price_centavos, p.plan_currency
      from public.subscription_plan p
     where p.plan_code = p_plan_code
       and p.plan_price_centavos > 0;
end;
$$;

-- Records a checkout PayMongo has just made. The amount is priced again here
-- rather than taken from the caller.
create or replace function public.billing_record_checkout(
  p_user_id uuid,
  p_plan_code text,
  p_checkout_id text,
  p_payment_intent_id text
)
returns public.subscription_payment
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quote record;
  v_row public.subscription_payment;
begin
  select * into v_quote from public.billing_checkout_quote(p_user_id, p_plan_code);
  if v_quote is null or v_quote.clinic_id is null then
    raise exception 'That plan has no price' using errcode = 'check_violation';
  end if;
  if p_checkout_id is null or p_checkout_id !~ '^cs_[A-Za-z0-9]+$' then
    raise exception 'Not a PayMongo checkout id' using errcode = 'check_violation';
  end if;

  insert into public.subscription_payment
    (clinic_id, plan_code, plan_name_snapshot, payment_amount_centavos, payment_currency,
     provider_checkout_id, provider_payment_intent_id, created_by_user_id)
  values
    (v_quote.clinic_id, v_quote.plan_code, v_quote.plan_name, v_quote.amount_centavos,
     v_quote.currency, p_checkout_id, p_payment_intent_id, p_user_id)
  returning * into v_row;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- A confirmed payment, applied once
-- ---------------------------------------------------------------------------
-- Called only after PayMongo confirmed it: a signature-checked webhook, or the
-- checkout read back from PayMongo with the secret key. The payment row is
-- locked, so two deliveries at once cannot both apply it; a payment already
-- paid is reported as a duplicate and changes nothing.
--
-- The amount and currency must be exactly what was recorded at checkout, or
-- nothing is applied. Paying for the plan already held extends it by one
-- month from the end of the current period; paying for another plan replaces
-- the current one from now.
create or replace function public.billing_apply_paid_checkout(
  p_checkout_id text,
  p_provider_payment_id text,
  p_amount_centavos bigint,
  p_currency text,
  p_paid_at timestamptz
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payment public.subscription_payment;
  v_current public.clinic_subscription;
  v_subscription uuid;
  v_paid_at timestamptz := coalesce(p_paid_at, now());
begin
  select * into v_payment
    from public.subscription_payment
   where provider_checkout_id = p_checkout_id
   for update;

  if not found then
    return 'unknown_checkout';
  end if;
  if v_payment.payment_status = 'paid' then
    return 'duplicate';
  end if;
  if p_amount_centavos is distinct from v_payment.payment_amount_centavos
     or p_currency is distinct from v_payment.payment_currency then
    return 'amount_mismatch';
  end if;
  if p_provider_payment_id is null or p_provider_payment_id !~ '^pay_[A-Za-z0-9]+$' then
    return 'missing_payment_id';
  end if;

  select * into v_current
    from public.clinic_subscription
   where clinic_id = v_payment.clinic_id and subscription_status = 'active'
   for update;

  if found and v_current.plan_code = v_payment.plan_code then
    -- A renewal: the next month, starting where the current one ends.
    update public.clinic_subscription
       set subscription_period_end =
             greatest(subscription_period_end, v_paid_at) + interval '1 month',
           subscription_updated_at = now()
     where subscription_id = v_current.subscription_id;
    v_subscription := v_current.subscription_id;
  else
    if found then
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
      (v_payment.clinic_id, v_payment.plan_code, 'active', 'month',
       now(), now() + interval '1 month')
    returning subscription_id into v_subscription;
  end if;

  update public.subscription_payment
     set payment_status = 'paid',
         provider_payment_id = p_provider_payment_id,
         payment_paid_at = v_paid_at,
         subscription_id = v_subscription,
         payment_updated_at = now()
   where payment_id = v_payment.payment_id;

  return 'activated';
end;
$$;

-- A payment PayMongo reported failed, or a checkout PayMongo confirmed was
-- expired without payment. Never touches a paid row, and never a subscription.
create or replace function public.billing_mark_unpaid(
  p_checkout_id text,
  p_payment_intent_id text,
  p_status text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_status not in ('failed', 'cancelled') then
    raise exception 'Unknown status' using errcode = 'check_violation';
  end if;

  update public.subscription_payment
     set payment_status = p_status,
         payment_updated_at = now()
   where payment_status in ('pending', 'failed')
     and ((p_checkout_id is not null and provider_checkout_id = p_checkout_id)
       or (p_checkout_id is null and p_payment_intent_id is not null
           and provider_payment_intent_id = p_payment_intent_id));
  get diagnostics v_count = row_count;

  return case when v_count > 0 then 'marked_' || p_status else 'no_pending_payment' end;
end;
$$;

-- ---------------------------------------------------------------------------
-- A webhook event, once
-- ---------------------------------------------------------------------------
-- Called by `paymongo-webhook` after it has checked the signature. The event
-- id is claimed first: a second delivery of the same event finds it claimed
-- and returns 'duplicate' without doing anything again. The claim and its
-- effect commit together, so a failure leaves neither and PayMongo's retry
-- tries again.
create or replace function public.billing_handle_webhook_event(
  p_event_id text,
  p_event_type text,
  p_livemode boolean,
  p_checkout_id text,
  p_payment_intent_id text,
  p_provider_payment_id text,
  p_amount_centavos bigint,
  p_currency text,
  p_paid_at timestamptz
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result text;
  v_status text;
begin
  if p_event_id is null or p_event_id !~ '^evt_[A-Za-z0-9]+$' then
    raise exception 'Not a PayMongo event id' using errcode = 'check_violation';
  end if;

  insert into public.paymongo_webhook_event
    (provider_event_id, event_type, event_livemode, processing_status, processing_result)
  values (p_event_id, coalesce(p_event_type, ''), coalesce(p_livemode, false), 'ignored', 'claimed')
  on conflict (provider_event_id) do nothing;

  if not found then
    return 'duplicate';
  end if;

  if p_livemode then
    -- This integration is sandbox only; a live event is never applied.
    v_status := 'rejected';
    v_result := 'livemode_not_accepted';
  elsif p_event_type = 'checkout_session.payment.paid' then
    v_result := public.billing_apply_paid_checkout(
      p_checkout_id, p_provider_payment_id, p_amount_centavos, p_currency, p_paid_at);
    v_status := case when v_result = 'activated' then 'processed' else 'ignored' end;
  elsif p_event_type = 'payment.failed' then
    v_result := public.billing_mark_unpaid(p_checkout_id, p_payment_intent_id, 'failed');
    v_status := case when v_result = 'marked_failed' then 'processed' else 'ignored' end;
  else
    v_status := 'ignored';
    v_result := 'event_type_not_handled';
  end if;

  update public.paymongo_webhook_event
     set processing_status = v_status,
         processing_result = v_result,
         event_processed_at = now()
   where provider_event_id = p_event_id;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Lapsed paid periods
-- ---------------------------------------------------------------------------
create or replace function public.expire_lapsed_subscriptions()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_count integer := 0;
begin
  for v_row in
    select subscription_id, clinic_id
      from public.clinic_subscription
     where subscription_status = 'active'
       and plan_code in ('basic', 'premium')
       and subscription_period_end <= now()
     for update skip locked
  loop
    update public.clinic_subscription
       set subscription_status = 'expired', subscription_updated_at = now()
     where subscription_id = v_row.subscription_id;

    insert into public.clinic_subscription
      (clinic_id, plan_code, subscription_status, subscription_billing_interval)
    values (v_row.clinic_id, 'free', 'active', 'forever');

    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.billing_checkout_quote(uuid, text) from public, anon, authenticated;
revoke all on function public.billing_record_checkout(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.billing_apply_paid_checkout(text, text, bigint, text, timestamptz) from public, anon, authenticated;
revoke all on function public.billing_mark_unpaid(text, text, text) from public, anon, authenticated;
revoke all on function public.billing_handle_webhook_event(text, text, boolean, text, text, text, bigint, text, timestamptz) from public, anon, authenticated;
revoke all on function public.expire_lapsed_subscriptions() from public, anon, authenticated;

grant execute on function public.billing_checkout_quote(uuid, text) to service_role;
grant execute on function public.billing_record_checkout(uuid, text, text, text) to service_role;
grant execute on function public.billing_apply_paid_checkout(text, text, bigint, text, timestamptz) to service_role;
grant execute on function public.billing_mark_unpaid(text, text, text) to service_role;
grant execute on function public.billing_handle_webhook_event(text, text, boolean, text, text, text, bigint, text, timestamptz) to service_role;
grant execute on function public.expire_lapsed_subscriptions() to service_role;

-- ---------------------------------------------------------------------------
-- The Super Admin's figures
-- ---------------------------------------------------------------------------
-- Platform totals only, as migration 46: subscribers per plan (distinct
-- clinics with an active subscription) and revenue sums. No clinic id or
-- name, no person, no payment reference, no event.
create or replace function public.super_admin_subscription_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_this_month date := date_trunc('month', now() at time zone 'Asia/Manila')::date;
begin
  perform app_private.require_super_admin();

  return jsonb_build_object(
    'total_subscribers', (
      select count(distinct s.clinic_id)
        from public.clinic_subscription s
       where s.subscription_status = 'active'
    ),
    'plans', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'code', p.plan_code,
               'name', p.plan_name,
               'price_centavos', p.plan_price_centavos,
               'billing_interval', p.plan_billing_interval,
               'subscribers', (
                 select count(distinct s.clinic_id)
                   from public.clinic_subscription s
                  where s.subscription_status = 'active'
                    and s.plan_code = p.plan_code
               )
             ) order by p.plan_sort_order), '[]'::jsonb)
        from public.subscription_plan p
    ),
    'revenue', jsonb_build_object(
      'currency', 'PHP',
      'lifetime_centavos', (
        select coalesce(sum(payment_amount_centavos), 0)
          from public.subscription_payment
         where payment_status = 'paid'
      ),
      'this_month_centavos', (
        select coalesce(sum(payment_amount_centavos), 0)
          from public.subscription_payment
         where payment_status = 'paid'
           and (payment_paid_at at time zone 'Asia/Manila') >= v_this_month
      ),
      -- The last twelve Asia/Manila months, oldest first, each one present.
      'monthly', (
        select jsonb_agg(jsonb_build_object(
                 'month', to_char(m.month_start, 'YYYY-MM'),
                 'centavos', coalesce((
                   select sum(sp.payment_amount_centavos)
                     from public.subscription_payment sp
                    where sp.payment_status = 'paid'
                      and (sp.payment_paid_at at time zone 'Asia/Manila') >= m.month_start
                      and (sp.payment_paid_at at time zone 'Asia/Manila') < m.month_start + interval '1 month'
                 ), 0)
               ) order by m.month_start)
          from (
            select (v_this_month - make_interval(months => g))::date as month_start
              from generate_series(0, 11) g
          ) m
      ),
      'by_plan', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'code', p.plan_code,
                 'centavos', coalesce((
                   select sum(sp.payment_amount_centavos)
                     from public.subscription_payment sp
                    where sp.payment_status = 'paid'
                      and sp.plan_code = p.plan_code
                 ), 0)
               ) order by p.plan_sort_order), '[]'::jsonb)
          from public.subscription_plan p
         where p.plan_code <> 'free'
      )
    ),
    'generated_at', now()
  );
end;
$$;

comment on function public.super_admin_subscription_overview() is
  'Platform-wide subscriber counts per plan and revenue PayMongo confirmed '
  'paid, by Asia/Manila month and by plan. Totals only. Super Admin only '
  '(migration 68).';

revoke all on function public.super_admin_subscription_overview() from public, anon;
grant execute on function public.super_admin_subscription_overview() to authenticated;

-- ---------------------------------------------------------------------------
-- The schedule
-- ---------------------------------------------------------------------------
-- Guarded on pg_cron as migration 64 is: the PGlite test harness has none.
-- Every 15 minutes, at 7, 22, 37 and 52 past, clear of the other jobs.
do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice
      'pg_cron is not available; the subscription expiry job was NOT scheduled. '
      'Call expire_lapsed_subscriptions() every 15 minutes with the service role instead.';
    return;
  end if;

  create extension if not exists pg_cron;

  perform cron.schedule(
    'recoverease-expire-lapsed-subscriptions',
    '7,22,37,52 * * * *',
    $job$ select public.expire_lapsed_subscriptions() $job$
  );
end
$$;

reset lock_timeout;
