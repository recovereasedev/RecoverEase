-- READ-ONLY. Billing state on the staging project, after each sandbox test.
-- live_revenue_centavos must stay 0: every PayMongo test-mode payment is
-- sandbox (payment_livemode false), and only live payments are revenue
-- (migration 69). patients must stay 0: staging holds no clinical record.
select
  (select json_agg(json_build_object(
            'clinic', c.clinic_name, 'plan', s.plan_code, 'status', s.subscription_status,
            'period_end', s.subscription_period_end))
     from public.clinic_subscription s join public.clinic c using (clinic_id)
    where s.subscription_status = 'active')                                      as active_plans,
  (select json_object_agg(payment_status, n)
     from (select payment_status, count(*) as n from public.subscription_payment group by 1) x) as payments_by_status,
  (select coalesce(sum(payment_amount_centavos), 0) from public.subscription_payment
    where payment_status = 'paid' and payment_livemode)                          as live_revenue_centavos,
  (select coalesce(sum(payment_amount_centavos), 0) from public.subscription_payment
    where payment_status = 'paid' and not payment_livemode)                      as sandbox_paid_centavos,
  (select json_agg(json_build_object('type', event_type, 'livemode', event_livemode,
            'status', processing_status, 'result', processing_result) order by event_received_at desc)
     from (select * from public.paymongo_webhook_event order by event_received_at desc limit 20) e) as recent_events,
  (select count(*) from public.patient)                                          as patients,
  now()                                                                          as checked_at;
