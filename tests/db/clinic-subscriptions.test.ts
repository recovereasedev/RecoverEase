import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { addClinic, liftSingleClinicGate } from './helpers/clinics'
import { createTestDatabase, expectDenied, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'
import { assuredSuperAdmin, claimsFor, createSignIn, openSession, type Claims } from './helpers/super-admin'

/**
 * Migration 68: plans, one current subscription per clinic, PayMongo sandbox
 * payments applied once, and the Super Admin's subscriber and revenue totals.
 *
 * The service-role functions are called here as the owner, the way the Edge
 * Functions call them with the service key; what a signed-in user may reach
 * is called as that user.
 */

type Overview = {
  total_subscribers: number
  plans: { code: string; name: string; price_centavos: number | null; billing_interval: string; subscribers: number }[]
  revenue: {
    currency: string
    lifetime_centavos: number
    this_month_centavos: number
    monthly: { month: string; centavos: number }[]
    by_plan: { code: string; centavos: number }[]
  }
  generated_at: string
}

const MIGRATION_68 = 'supabase/migrations/20260902100068_clinic_subscriptions.sql'
const ROLLBACK_68 = 'supabase/rollbacks/20260902100068_clinic_subscriptions.down.sql'
const script = (path: string) => readFile(join(process.cwd(), path), 'utf8')

let checkoutSeq = 0
const nextCheckout = () => `cs_test${(++checkoutSeq).toString().padStart(6, '0')}`
const nextEvent = () => `evt_test${(++checkoutSeq).toString().padStart(6, '0')}`
const nextPayment = () => `pay_test${(++checkoutSeq).toString().padStart(6, '0')}`

async function overview(database: TestDatabase, claims: Claims): Promise<Overview> {
  const [row] = await database.asClaims<{ o: Overview }>(
    claims,
    'select public.super_admin_subscription_overview() as o',
  )
  return row!.o
}

async function activePlans(database: TestDatabase, clinicId: string) {
  return database.asService<{ plan_code: string; subscription_period_end: string | null }>(
    `select plan_code, subscription_period_end from public.clinic_subscription
      where clinic_id = $1 and subscription_status = 'active'`,
    [clinicId],
  )
}

async function startCheckout(database: TestDatabase, userId: string, plan: string) {
  const checkoutId = nextCheckout()
  const [row] = await database.asService<{ payment_id: string; payment_amount_centavos: string }>(
    `select payment_id, payment_amount_centavos
       from public.billing_record_checkout($1, $2, $3, $4)`,
    [userId, plan, checkoutId, `pi_${checkoutId.slice(3)}`],
  )
  return { checkoutId, paymentId: row!.payment_id, amount: Number(row!.payment_amount_centavos) }
}

async function webhook(
  database: TestDatabase,
  event: {
    id?: string
    type: string
    livemode?: boolean
    checkoutId?: string | null
    intentId?: string | null
    paymentId?: string | null
    amount?: number | null
    currency?: string | null
    paidAt?: string | null
  },
): Promise<string> {
  const [row] = await database.asService<{ r: string }>(
    `select public.billing_handle_webhook_event($1, $2, $3, $4, $5, $6, $7, $8, $9) as r`,
    [
      event.id ?? nextEvent(),
      event.type,
      event.livemode ?? false,
      event.checkoutId ?? null,
      event.intentId ?? null,
      event.paymentId ?? null,
      event.amount ?? null,
      event.currency ?? null,
      event.paidAt ?? null,
    ],
  )
  return row!.r
}

async function payCheckout(
  database: TestDatabase,
  checkout: { checkoutId: string; amount: number },
  paidAt: string | null = null,
) {
  return webhook(database, {
    type: 'checkout_session.payment.paid',
    checkoutId: checkout.checkoutId,
    paymentId: nextPayment(),
    amount: checkout.amount,
    currency: 'PHP',
    paidAt,
  })
}

/** A Clinic Admin of a second clinic, made as the provisioning path would. */
async function secondClinicAdmin(database: TestDatabase, clinicId: string): Promise<string> {
  const userId = await createSignIn(database, 'second.admin@alder.test')
  await database.asService(
    `insert into public.user_account (user_id, user_email, user_role) values ($1, 'second.admin@alder.test', 'admin')`,
    [userId],
  )
  await database.asService(
    `insert into public.admin (user_id, admin_first_name, admin_last_name, clinic_id) values ($1, 'Rosa', 'Lim', $2)`,
    [userId, clinicId],
  )
  return userId
}

describe('clinic subscriptions (migration 68)', () => {
  let database: TestDatabase
  let fx: Fixture
  let clinicId: string
  let superAdmin: { userId: string; claims: Claims }

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
    superAdmin = await assuredSuperAdmin(database)
    const [row] = await database.asService<{ clinic_id: string }>(
      'select clinic_id from public.admin where user_id = $1',
      [fx.adminUserId],
    )
    clinicId = row!.clinic_id
  })

  afterAll(async () => {
    await database?.close()
  })

  describe('plans', () => {
    it('seeds the four plans with prices in centavos and no Enterprise list price', async () => {
      const plans = await database.asService(
        `select plan_code, plan_name, plan_price_centavos::int as price, plan_billing_interval
           from public.subscription_plan order by plan_sort_order`,
      )
      expect(plans).toEqual([
        { plan_code: 'free', plan_name: 'Free', price: 0, plan_billing_interval: 'forever' },
        { plan_code: 'basic', plan_name: 'Basic', price: 99900, plan_billing_interval: 'month' },
        { plan_code: 'premium', plan_name: 'Premium', price: 249900, plan_billing_interval: 'month' },
        { plan_code: 'enterprise', plan_name: 'Enterprise', price: null, plan_billing_interval: 'custom' },
      ])
    })

    it('never invents an Enterprise price', async () => {
      await expect(
        database.asService(`update public.subscription_plan set plan_price_centavos = 1800000 where plan_code = 'enterprise'`),
      ).rejects.toThrow(/subscription_plan_price_rules/)
    })

    it('is readable by anyone signed in, writable by no one signed in, and hidden from visitors', async () => {
      const rows = await database.asUser(fx.aliceUserId, 'select plan_code from public.subscription_plan')
      expect(rows).toHaveLength(4)
      await expect(
        database.asUser(fx.adminUserId, `update public.subscription_plan set plan_price_centavos = 1 where plan_code = 'basic'`),
      ).rejects.toThrow(/permission denied/)
      await expect(database.asAnon('select * from public.subscription_plan')).rejects.toThrow(/permission denied/)
    })
  })

  describe('every clinic on a plan', () => {
    it('backfilled the existing clinic onto Free', async () => {
      expect(await activePlans(database, clinicId)).toEqual([
        { plan_code: 'free', subscription_period_end: null },
      ])
    })

    it('starts a new clinic on Free', async () => {
      await liftSingleClinicGate(database)
      const alder = await addClinic(database, 'Alder Clinic', 'Asia/Manila')
      expect(await activePlans(database, alder)).toEqual([{ plan_code: 'free', subscription_period_end: null }])
    })

    it('refuses a second active subscription for one clinic', async () => {
      await expect(
        database.asService(
          `insert into public.clinic_subscription (clinic_id, plan_code, subscription_status, subscription_billing_interval)
           values ($1, 'free', 'active', 'forever')`,
          [clinicId],
        ),
      ).rejects.toThrow(/clinic_subscription_one_active/)
    })

    it('requires an agreed price on Enterprise, and only there', async () => {
      await expect(
        database.asService(
          `insert into public.clinic_subscription (clinic_id, plan_code, subscription_status, subscription_billing_interval)
           values ($1, 'enterprise', 'expired', 'custom')`,
          [clinicId],
        ),
      ).rejects.toThrow(/clinic_subscription_agreed_price/)
      await expect(
        database.asService(
          `insert into public.clinic_subscription (clinic_id, plan_code, subscription_status, subscription_billing_interval, subscription_agreed_price_centavos)
           values ($1, 'free', 'expired', 'forever', 100)`,
          [clinicId],
        ),
      ).rejects.toThrow(/clinic_subscription_agreed_price/)
    })
  })

  describe('checkout', () => {
    it('prices a checkout from the plan table for the caller’s own clinic', async () => {
      const [quote] = await database.asService(
        `select clinic_id, plan_code, amount_centavos::int as amount, currency from public.billing_checkout_quote($1, 'premium')`,
        [fx.adminUserId],
      )
      expect(quote).toEqual({ clinic_id: clinicId, plan_code: 'premium', amount: 249900, currency: 'PHP' })
    })

    it('refuses doctors, patients, Free and Enterprise', async () => {
      for (const userId of [fx.doctorAUserId, fx.aliceUserId, superAdmin.userId]) {
        await expect(
          database.asService(`select * from public.billing_checkout_quote($1, 'basic')`, [userId]),
        ).rejects.toThrow(/Only a Clinic Admin/)
      }
      for (const plan of ['free', 'enterprise', 'gold']) {
        await expect(
          database.asService(`select * from public.billing_checkout_quote($1, $2)`, [fx.adminUserId, plan]),
        ).rejects.toThrow(/Only Basic or Premium/)
      }
    })

    it('gives signed-in users and visitors no way to call the server-only functions', async () => {
      for (const sql of [
        `select * from public.billing_checkout_quote('${fx.adminUserId}', 'basic')`,
        `select * from public.billing_record_checkout('${fx.adminUserId}', 'basic', 'cs_x', null)`,
        `select public.billing_apply_paid_checkout('cs_x', 'pay_x', 99900, 'PHP', now())`,
        `select public.billing_mark_unpaid('cs_x', null, 'failed')`,
        `select public.billing_handle_webhook_event('evt_x', 'checkout_session.payment.paid', false, 'cs_x', null, 'pay_x', 99900, 'PHP', now())`,
        `select public.expire_lapsed_subscriptions()`,
      ]) {
        await expect(database.asUser(fx.adminUserId, sql)).rejects.toThrow(/permission denied/)
        await expect(database.asAnon(sql)).rejects.toThrow(/permission denied/)
      }
    })
  })

  describe('payments and webhooks', () => {
    it('a pending checkout does not activate a plan and is not revenue', async () => {
      const before = await overview(database, superAdmin.claims)
      await startCheckout(database, fx.adminUserId, 'basic')
      expect((await activePlans(database, clinicId))[0]!.plan_code).toBe('free')
      expect((await overview(database, superAdmin.claims)).revenue.lifetime_centavos).toBe(
        before.revenue.lifetime_centavos,
      )
    })

    it('a failed payment does not activate a plan and is not revenue', async () => {
      const before = await overview(database, superAdmin.claims)
      const checkout = await startCheckout(database, fx.adminUserId, 'basic')
      const result = await webhook(database, { type: 'payment.failed', intentId: `pi_${checkout.checkoutId.slice(3)}` })
      expect(result).toBe('marked_failed')
      const [row] = await database.asService<{ payment_status: string }>(
        'select payment_status from public.subscription_payment where payment_id = $1',
        [checkout.paymentId],
      )
      expect(row!.payment_status).toBe('failed')
      expect((await activePlans(database, clinicId))[0]!.plan_code).toBe('free')
      expect((await overview(database, superAdmin.claims)).revenue).toEqual(before.revenue)
    })

    it('a cancelled checkout does not activate a plan and is not revenue', async () => {
      const before = await overview(database, superAdmin.claims)
      const checkout = await startCheckout(database, fx.adminUserId, 'premium')
      const [row] = await database.asService<{ r: string }>(
        `select public.billing_mark_unpaid($1, null, 'cancelled') as r`,
        [checkout.checkoutId],
      )
      expect(row!.r).toBe('marked_cancelled')
      expect((await activePlans(database, clinicId))[0]!.plan_code).toBe('free')
      expect((await overview(database, superAdmin.claims)).revenue).toEqual(before.revenue)
    })

    it('refuses an amount that is not the amount recorded at checkout', async () => {
      const checkout = await startCheckout(database, fx.adminUserId, 'basic')
      const result = await webhook(database, {
        type: 'checkout_session.payment.paid',
        checkoutId: checkout.checkoutId,
        paymentId: nextPayment(),
        amount: 100,
        currency: 'PHP',
      })
      expect(result).toBe('amount_mismatch')
      expect((await activePlans(database, clinicId))[0]!.plan_code).toBe('free')
    })

    it('never applies a live-mode event', async () => {
      const checkout = await startCheckout(database, fx.adminUserId, 'basic')
      const result = await webhook(database, {
        type: 'checkout_session.payment.paid',
        livemode: true,
        checkoutId: checkout.checkoutId,
        paymentId: nextPayment(),
        amount: checkout.amount,
        currency: 'PHP',
      })
      expect(result).toBe('livemode_not_accepted')
      expect((await activePlans(database, clinicId))[0]!.plan_code).toBe('free')
    })

    it('a successful Basic payment activates Basic for a month and counts once, even delivered twice', async () => {
      const before = await overview(database, superAdmin.claims)
      const checkout = await startCheckout(database, fx.adminUserId, 'basic')
      const event = {
        id: nextEvent(),
        type: 'checkout_session.payment.paid',
        checkoutId: checkout.checkoutId,
        paymentId: nextPayment(),
        amount: 99900,
        currency: 'PHP',
      }
      expect(await webhook(database, event)).toBe('activated')
      expect(await webhook(database, event)).toBe('duplicate')
      // The same payment under a different event id changes nothing either.
      expect(await webhook(database, { ...event, id: nextEvent() })).toBe('duplicate')

      const active = await activePlans(database, clinicId)
      expect(active).toHaveLength(1)
      expect(active[0]!.plan_code).toBe('basic')
      const [period] = await database.asService<{ months: number }>(
        `select extract(month from age(subscription_period_end, subscription_period_start))::int as months
           from public.clinic_subscription where clinic_id = $1 and subscription_status = 'active'`,
        [clinicId],
      )
      expect(period!.months).toBe(1)

      const after = await overview(database, superAdmin.claims)
      expect(after.revenue.lifetime_centavos - before.revenue.lifetime_centavos).toBe(99900)
      expect(after.revenue.this_month_centavos - before.revenue.this_month_centavos).toBe(99900)
      const basic = (o: Overview) => o.revenue.by_plan.find((p) => p.code === 'basic')!.centavos
      expect(basic(after) - basic(before)).toBe(99900)
    })

    it('a second Basic payment renews: one subscription, one month longer', async () => {
      const [before] = await database.asService<{ subscription_id: string; subscription_period_end: string }>(
        `select subscription_id, subscription_period_end from public.clinic_subscription
          where clinic_id = $1 and subscription_status = 'active'`,
        [clinicId],
      )
      expect(await payCheckout(database, await startCheckout(database, fx.adminUserId, 'basic'))).toBe('activated')
      const [after] = await database.asService<{ subscription_id: string; months: number }>(
        `select subscription_id,
                extract(month from age(subscription_period_end, $2::timestamptz))::int as months
           from public.clinic_subscription where clinic_id = $1 and subscription_status = 'active'`,
        [clinicId, before!.subscription_period_end],
      )
      expect(after).toEqual({ subscription_id: before!.subscription_id, months: 1 })
    })

    it('a successful Premium payment changes plan: Basic is replaced, the clinic is counted once', async () => {
      const before = await overview(database, superAdmin.claims)
      expect(await payCheckout(database, await startCheckout(database, fx.adminUserId, 'premium'))).toBe('activated')

      const history = await database.asService<{ plan_code: string; subscription_status: string }>(
        `select plan_code, subscription_status from public.clinic_subscription
          where clinic_id = $1 order by subscription_created_at, subscription_status`,
        [clinicId],
      )
      expect(history.filter((s) => s.subscription_status === 'active')).toEqual([
        { plan_code: 'premium', subscription_status: 'active' },
      ])
      expect(history.some((s) => s.plan_code === 'basic' && s.subscription_status === 'replaced')).toBe(true)

      const after = await overview(database, superAdmin.claims)
      expect(after.total_subscribers).toBe(before.total_subscribers)
      const premium = (o: Overview) => o.revenue.by_plan.find((p) => p.code === 'premium')!.centavos
      expect(premium(after) - premium(before)).toBe(249900)
    })

    it('revenue keeps the price paid even after the list price changes', async () => {
      const before = await overview(database, superAdmin.claims)
      await database.asService(`update public.subscription_plan set plan_price_centavos = 129900 where plan_code = 'basic'`)
      const after = await overview(database, superAdmin.claims)
      expect(after.revenue).toEqual(before.revenue)
      expect(after.plans.find((p) => p.code === 'basic')!.price_centavos).toBe(129900)
      await database.asService(`update public.subscription_plan set plan_price_centavos = 99900 where plan_code = 'basic'`)
    })

    it('a lapsed paid period expires back to Free', async () => {
      await database.asService(
        `update public.clinic_subscription
            set subscription_period_start = now() - interval '2 months',
                subscription_period_end = now() - interval '1 minute'
          where clinic_id = $1 and subscription_status = 'active'`,
        [clinicId],
      )
      const [row] = await database.asService<{ n: number }>('select public.expire_lapsed_subscriptions() as n')
      expect(row!.n).toBe(1)
      expect(await activePlans(database, clinicId)).toEqual([{ plan_code: 'free', subscription_period_end: null }])
      const [again] = await database.asService<{ n: number }>('select public.expire_lapsed_subscriptions() as n')
      expect(again!.n).toBe(0)
    })
  })

  describe('Enterprise', () => {
    it('counts the agreed price actually paid, not any list price', async () => {
      const before = await overview(database, superAdmin.claims)
      const alder = await addClinic(database, 'Birch Clinic', 'Asia/Manila')
      await database.asService(
        `update public.clinic_subscription set subscription_status = 'replaced', subscription_period_end = now() + interval '1 second'
          where clinic_id = $1 and subscription_status = 'active'`,
        [alder],
      )
      const [sub] = await database.asService<{ subscription_id: string }>(
        `insert into public.clinic_subscription
           (clinic_id, plan_code, subscription_status, subscription_billing_interval, subscription_agreed_price_centavos)
         values ($1, 'enterprise', 'active', 'custom', 1750000) returning subscription_id`,
        [alder],
      )
      await database.asService(
        `insert into public.subscription_payment
           (clinic_id, subscription_id, plan_code, plan_name_snapshot, payment_amount_centavos,
            payment_status, provider_payment_id, payment_paid_at)
         values ($1, $2, 'enterprise', 'Enterprise', 1750000, 'paid', 'pay_enterprise0001', now())`,
        [alder, sub!.subscription_id],
      )
      const after = await overview(database, superAdmin.claims)
      const enterprise = (o: Overview) => o.revenue.by_plan.find((p) => p.code === 'enterprise')!.centavos
      expect(enterprise(after) - enterprise(before)).toBe(1750000)
      expect(after.plans.find((p) => p.code === 'enterprise')).toMatchObject({ price_centavos: null, subscribers: 1 })
    })
  })

  describe('the Super Admin overview', () => {
    it('counts distinct clinics per active plan, and never a person', async () => {
      const result = await overview(database, superAdmin.claims)
      const [clinics] = await database.asService<{ n: number }>('select count(*)::int as n from public.clinic')
      expect(result.total_subscribers).toBe(clinics!.n)
      expect(result.plans.map((p) => p.code)).toEqual(['free', 'basic', 'premium', 'enterprise'])
      expect(result.plans.reduce((sum, p) => sum + p.subscribers, 0)).toBe(result.total_subscribers)
      expect(result.plans.find((p) => p.code === 'free')).toMatchObject({ price_centavos: 0, subscribers: 2 })
    })

    it('excludes pending, failed and cancelled payments from every revenue figure', async () => {
      const result = await overview(database, superAdmin.claims)
      const [paid] = await database.asService<{ n: number }>(
        `select coalesce(sum(payment_amount_centavos), 0)::int as n from public.subscription_payment where payment_status = 'paid'`,
      )
      const [unpaid] = await database.asService<{ n: number }>(
        `select count(*)::int as n from public.subscription_payment where payment_status <> 'paid'`,
      )
      expect(unpaid!.n).toBeGreaterThanOrEqual(5)
      expect(result.revenue.lifetime_centavos).toBe(paid!.n)
      expect(result.revenue.by_plan.reduce((sum, p) => sum + p.centavos, 0)).toBe(paid!.n)
      expect(result.revenue.monthly.reduce((sum, m) => sum + m.centavos, 0)).toBe(paid!.n)
    })

    it('puts a payment in its Asia/Manila month', async () => {
      const [b] = await database.asService<{ start: string; month: string; prev: string }>(
        `select (date_trunc('month', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila')::text as start,
                to_char(date_trunc('month', now() at time zone 'Asia/Manila'), 'YYYY-MM') as month,
                to_char(date_trunc('month', now() at time zone 'Asia/Manila') - interval '1 month', 'YYYY-MM') as prev`,
      )
      const before = await overview(database, superAdmin.claims)
      const alderAdmin = await secondClinicAdmin(database, await addClinic(database, 'Cedar Clinic', 'Asia/Manila'))
      // 30 minutes before Manila's month began: last month. 30 after: this month.
      expect(
        await payCheckout(
          database,
          await startCheckout(database, alderAdmin, 'basic'),
          new Date(Date.parse(b!.start) - 30 * 60_000).toISOString(),
        ),
      ).toBe('activated')
      expect(
        await payCheckout(
          database,
          await startCheckout(database, alderAdmin, 'basic'),
          new Date(Date.parse(b!.start) + 30 * 60_000).toISOString(),
        ),
      ).toBe('activated')

      const after = await overview(database, superAdmin.claims)
      const month = (o: Overview, m: string) => o.revenue.monthly.find((x) => x.month === m)!.centavos
      expect(after.revenue.monthly).toHaveLength(12)
      expect(after.revenue.monthly.at(-1)!.month).toBe(b!.month)
      expect(month(after, b!.month) - month(before, b!.month)).toBe(99900)
      expect(month(after, b!.prev) - month(before, b!.prev)).toBe(99900)
      expect(after.revenue.this_month_centavos - before.revenue.this_month_centavos).toBe(99900)
    })

    it('returns totals only: no clinic, person, payment reference or event', async () => {
      const text = JSON.stringify(await overview(database, superAdmin.claims))
      const identifiers = await database.asService<{ v: string }>(
        `select clinic_id::text as v from public.clinic
         union all select clinic_name from public.clinic
         union all select user_email from public.user_account
         union all select pat_first_name from public.patient
         union all select doc_last_name from public.doctor
         union all select provider_checkout_id from public.subscription_payment where provider_checkout_id is not null
         union all select provider_payment_id from public.subscription_payment where provider_payment_id is not null
         union all select provider_event_id from public.paymongo_webhook_event`,
      )
      expect(identifiers.length).toBeGreaterThan(10)
      for (const { v } of identifiers) expect(text).not.toContain(v)
    })

    it('refuses anyone but an assured Super Admin', async () => {
      const sql = 'select public.super_admin_subscription_overview()'
      await expect(database.asUser(fx.adminUserId, sql)).rejects.toThrow()
      await expect(database.asUser(fx.doctorAUserId, sql)).rejects.toThrow()
      await expect(database.asUser(fx.aliceUserId, sql)).rejects.toThrow()
      await expect(database.asAnon(sql)).rejects.toThrow(/permission denied/)
      // The Super Admin without the authenticator step.
      const aal1 = await openSession(database, superAdmin.userId, { aal: 'aal1' })
      await expect(database.asClaims(claimsFor(superAdmin.userId, aal1, 'aal1'), sql)).rejects.toThrow()
    })
  })

  describe('who reads billing', () => {
    it('a Clinic Admin reads their own clinic’s subscriptions and payments, never another clinic’s', async () => {
      const own = await database.asUser<{ clinic_id: string }>(fx.adminUserId, 'select clinic_id from public.subscription_payment')
      expect(own.length).toBeGreaterThan(0)
      expect(new Set(own.map((r) => r.clinic_id))).toEqual(new Set([clinicId]))
      const subs = await database.asUser<{ clinic_id: string }>(fx.adminUserId, 'select clinic_id from public.clinic_subscription')
      expect(new Set(subs.map((r) => r.clinic_id))).toEqual(new Set([clinicId]))
    })

    it('doctors and patients read no subscription, payment or webhook record', async () => {
      for (const userId of [fx.doctorAUserId, fx.aliceUserId]) {
        await expectDenied(() => database.asUser(userId, 'select * from public.clinic_subscription'))
        await expectDenied(() => database.asUser(userId, 'select * from public.subscription_payment'))
        await expectDenied(() => database.asUser(userId, 'select * from public.paymongo_webhook_event'))
      }
      await expectDenied(() => database.asUser(fx.adminUserId, 'select * from public.paymongo_webhook_event'))
      await expect(database.asAnon('select * from public.paymongo_webhook_event')).rejects.toThrow(/permission denied/)
      await expect(
        database.asUser(
          fx.adminUserId,
          `insert into public.paymongo_webhook_event (provider_event_id, event_type, event_livemode, processing_status, processing_result)
           values ('evt_fake', 'x', false, 'processed', 'x')`,
        ),
      ).rejects.toThrow(/permission denied/)
    })

    it('no one signed in can write a subscription or payment directly', async () => {
      await expect(
        database.asUser(fx.adminUserId, `update public.subscription_payment set payment_status = 'paid'`),
      ).rejects.toThrow(/permission denied/)
      await expect(
        database.asUser(
          fx.adminUserId,
          `insert into public.clinic_subscription (clinic_id, plan_code, subscription_status, subscription_billing_interval)
           values ('${clinicId}', 'premium', 'replaced', 'month')`,
        ),
      ).rejects.toThrow(/permission denied/)
    })
  })

  describe('a Clinic Admin moves to Free', () => {
    it('only a Clinic Admin, and only for their own clinic', async () => {
      await expect(database.asUser(fx.doctorAUserId, 'select public.clinic_admin_choose_free_plan()')).rejects.toThrow(/Only a Clinic Admin/)
      await expect(database.asUser(fx.aliceUserId, 'select public.clinic_admin_choose_free_plan()')).rejects.toThrow(/Only a Clinic Admin/)
      await expect(database.asAnon('select public.clinic_admin_choose_free_plan()')).rejects.toThrow(/permission denied/)

      expect(await payCheckout(database, await startCheckout(database, fx.adminUserId, 'premium'))).toBe('activated')
      await database.asUser(fx.adminUserId, 'select public.clinic_admin_choose_free_plan()')
      expect(await activePlans(database, clinicId)).toEqual([{ plan_code: 'free', subscription_period_end: null }])
      // Again: still one Free subscription.
      await database.asUser(fx.adminUserId, 'select public.clinic_admin_choose_free_plan()')
      expect(await activePlans(database, clinicId)).toHaveLength(1)
    })
  })
})

describe('migration 68 rollback', () => {
  it('removes everything it added and can be applied again', async () => {
    const database = await createTestDatabase()
    try {
      await database.db.exec(await script(ROLLBACK_68))
      const [gone] = await database.asService<{ n: number }>(
        `select count(*)::int as n from pg_class
          where relname in ('subscription_plan', 'clinic_subscription', 'subscription_payment', 'paymongo_webhook_event')`,
      )
      expect(gone!.n).toBe(0)
      const [fn] = await database.asService<{ n: number }>(
        `select count(*)::int as n from pg_proc
          where proname in ('super_admin_subscription_overview', 'billing_handle_webhook_event', 'clinic_admin_choose_free_plan')`,
      )
      expect(fn!.n).toBe(0)
      await expect(database.db.exec(await script(ROLLBACK_68))).rejects.toThrow(/not applied/)

      await database.db.exec(await script(MIGRATION_68))
      const [free] = await database.asService<{ n: number }>(
        `select count(*)::int as n from public.clinic_subscription where subscription_status = 'active' and plan_code = 'free'`,
      )
      const [clinics] = await database.asService<{ n: number }>('select count(*)::int as n from public.clinic')
      expect(free!.n).toBe(clinics!.n)
    } finally {
      await database.close()
    }
  })
})
