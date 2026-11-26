-- ===========================================================================
-- RecoverEase — 69. Revenue counts live payments only
-- ===========================================================================
-- Migration 68 counted every payment PayMongo confirmed paid as revenue. The
-- integration is sandbox only (a live event is refused), so every paid row is
-- a test-mode payment, and it would have shown in the Super Admin's figures
-- as real income. The owner decided test payments are excluded.
--
--   * subscription_payment.payment_livemode - true only for a payment taken
--     in PayMongo's live mode. It defaults to false, and nothing writes true
--     yet: live payments are not implemented. Every existing row is a
--     sandbox payment, so the default is also the right value for them.
--   * super_admin_subscription_overview() - every revenue figure (lifetime,
--     this month, the twelve months, by plan) now also requires
--     payment_livemode. Subscriber counts are unchanged.
--
-- A sandbox payment still moves its clinic onto the plan it paid for; it is
-- only kept out of revenue. Nothing signed in can write the column (68's
-- revokes cover the whole table). No other function changes.
--
-- Rollback: supabase/rollbacks/20260902100069_subscription_payment_livemode.down.sql
-- ===========================================================================

do $$
begin
  if to_regclass('public.subscription_payment') is null
     or to_regprocedure('public.super_admin_subscription_overview()') is null then
    raise exception 'Migration 69 needs migration 68 first. Nothing was applied.';
  end if;
end
$$;

-- Every migration from 41 waits at most 3 seconds for a lock. Reset at the end.
set lock_timeout = '3s';

alter table public.subscription_payment
  add column payment_livemode boolean not null default false;

comment on column public.subscription_payment.payment_livemode is
  'True only for a payment taken in PayMongo live mode. Only those are '
  'revenue; sandbox (test-mode) payments never are. Nothing writes true '
  'until live payments are implemented (migration 69).';

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
           and payment_livemode
      ),
      'this_month_centavos', (
        select coalesce(sum(payment_amount_centavos), 0)
          from public.subscription_payment
         where payment_status = 'paid'
           and payment_livemode
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
                      and sp.payment_livemode
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
                      and sp.payment_livemode
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
  'Platform-wide subscriber counts per plan and revenue: live payments '
  'PayMongo confirmed paid, by Asia/Manila month and by plan. Sandbox '
  '(test-mode) payments are never revenue. Totals only. Super Admin only '
  '(migrations 68, 69).';

revoke all on function public.super_admin_subscription_overview() from public, anon;
grant execute on function public.super_admin_subscription_overview() to authenticated;

reset lock_timeout;
