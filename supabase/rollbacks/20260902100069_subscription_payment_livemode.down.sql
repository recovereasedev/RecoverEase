-- ===========================================================================
-- Rollback of migration 69 (subscription_payment_livemode)
-- ===========================================================================
-- Puts back migration 68's super_admin_subscription_overview(), which counts
-- every paid payment as revenue, sandbox ones included, and drops
-- subscription_payment.payment_livemode with its values.
--
-- Nothing writes true to the column while live payments are not implemented,
-- so dropping it loses nothing; check `select count(*) from
-- public.subscription_payment where payment_livemode` is 0 first.
-- ===========================================================================

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'subscription_payment'
       and column_name = 'payment_livemode'
  ) then
    raise exception 'Migration 69 is not applied. Nothing was changed.';
  end if;
end
$$;

set lock_timeout = '3s';

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

alter table public.subscription_payment drop column payment_livemode;

reset lock_timeout;
