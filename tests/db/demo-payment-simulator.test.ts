import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { addClinic, liftSingleClinicGate } from './helpers/clinics'
import { createTestDatabase, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'
import { assuredSuperAdmin, claimsFor, createSignIn, type Claims } from './helpers/super-admin'

/**
 * Migration 70: the internal demo payment simulator.
 *
 * The cross-role scenario the oral defense shows runs here against the real
 * migrations: a Clinic Admin of the allowed clinic simulates a payment, and
 * the Super Admin's activity list and subscription overview read the same
 * rows. The browser half (tests/e2e) runs on stubbed Supabase.
 */

type Result = {
  result: 'activated' | 'failed' | 'cancelled' | 'duplicate'
  payment_id: string
  reference: string
  status: string
  plan_code: string
  plan_name: string
  amount_centavos: number
  method: string
  period_end: string | null
}

type Activity = {
  summary: { total: number; paid: number; failed: number; cancelled: number; pending: number; demo_volume_centavos: number }
  total_matching: number
  rows: {
    payment_id: string
    reference: string
    clinic_id: string
    clinic_name: string
    plan_code: string
    plan_name: string
    amount_centavos: number
    method: string
    status: string
    created_at: string
    paid_at: string | null
  }[]
  clinics: { clinic_id: string; clinic_name: string }[]
}

type Overview = {
  total_subscribers: number
  plans: { code: string; subscribers: number }[]
  revenue: { lifetime_centavos: number; this_month_centavos: number }
}

const ROLLBACK_70 = 'supabase/rollbacks/20260902100070_demo_payment_simulator.down.sql'

describe('demo payment simulator (migration 70)', () => {
  let database: TestDatabase
  let fx: Fixture
  let otherClinic: string
  let demoClinic: string
  let demoAdmin: string
  let superAdmin: { userId: string; claims: Claims }

  const simulate = async (
    userId: string,
    plan: string,
    method: string,
    outcome: string,
    requestId: string = randomUUID(),
  ): Promise<Result> => {
    const [row] = await database.asUser<{ r: Result }>(
      userId,
      'select public.clinic_admin_simulate_demo_payment($1, $2, $3, $4) as r',
      [plan, method, outcome, requestId],
    )
    return row!.r
  }

  const activity = async (args: { clinic?: string; status?: string; method?: string; from?: string; to?: string; page?: number; size?: number } = {}) => {
    const [row] = await database.asClaims<{ a: Activity }>(
      superAdmin.claims,
      'select public.super_admin_demo_payment_activity($1, $2, $3, $4, $5, $6, $7) as a',
      [args.clinic ?? null, args.status ?? null, args.method ?? null, args.from ?? null, args.to ?? null, args.page ?? 0, args.size ?? 20],
    )
    return row!.a
  }

  const overview = async () => {
    const [row] = await database.asClaims<{ o: Overview }>(superAdmin.claims, 'select public.super_admin_subscription_overview() as o')
    return row!.o
  }

  const subscribers = (o: Overview, code: string) => o.plans.find((p) => p.code === code)!.subscribers

  const activePlan = async (clinicId: string) => {
    const [row] = await database.asService<{ plan_code: string; subscription_period_end: string | null }>(
      `select plan_code, subscription_period_end from public.clinic_subscription
        where clinic_id = $1 and subscription_status = 'active'`,
      [clinicId],
    )
    return row!
  }

  const available = async (userId: string) => {
    const [row] = await database.asUser<{ a: boolean }>(userId, 'select public.demo_payment_simulator_available() as a')
    return row!.a
  }

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
    superAdmin = await assuredSuperAdmin(database)
    const [row] = await database.asService<{ clinic_id: string }>('select clinic_id from public.admin where user_id = $1', [fx.adminUserId])
    otherClinic = row!.clinic_id

    await liftSingleClinicGate(database)
    demoClinic = await addClinic(database, 'RecoverEase Defense Demo Clinic', 'Asia/Manila')
    demoAdmin = await createSignIn(database, 'demo.admin@recoverease.test')
    await database.asService(
      `insert into public.user_account (user_id, user_email, user_role) values ($1, 'demo.admin@recoverease.test', 'admin')`,
      [demoAdmin],
    )
    await database.asService(
      `insert into public.admin (user_id, admin_first_name, admin_last_name, clinic_id) values ($1, 'Demo', 'Admin', $2)`,
      [demoAdmin, demoClinic],
    )
    // The allowlist row production gets from the migration's seed.
    await database.asService('insert into app_private.demo_payment_simulator_clinic (clinic_id) values ($1)', [demoClinic])
  })

  afterAll(async () => {
    await database?.close()
  })

  describe('the switch and allowlist', () => {
    it('seeds nothing where the Defense Demo Clinic does not exist', async () => {
      const rows = await database.asService<{ clinic_id: string }>('select clinic_id from app_private.demo_payment_simulator_clinic')
      expect(rows).toEqual([{ clinic_id: demoClinic }])
    })

    it('is hidden from every API role', async () => {
      await expect(database.asUser(demoAdmin, 'select * from app_private.demo_payment_simulator_clinic')).rejects.toThrow(/permission denied/)
      await expect(database.asClaims(superAdmin.claims, 'select * from app_private.demo_payment_simulator_clinic')).rejects.toThrow(/permission denied/)
      await expect(database.asAnon('select public.demo_payment_simulator_available()')).rejects.toThrow(/permission denied/)
    })

    it('tells only the allowed clinic’s Clinic Admin it is available', async () => {
      expect(await available(demoAdmin)).toBe(true)
      for (const userId of [fx.adminUserId, fx.doctorAUserId, fx.aliceUserId, superAdmin.userId]) {
        expect(await available(userId)).toBe(false)
      }
    })
  })

  describe('access', () => {
    it('refuses the other clinic’s Clinic Admin, a doctor, a patient and the Super Admin', async () => {
      for (const userId of [fx.adminUserId, fx.doctorAUserId, fx.aliceUserId, superAdmin.userId]) {
        await expect(simulate(userId, 'basic', 'qr_wallet', 'paid')).rejects.toThrow(/only for the Clinic Admin of a clinic it is enabled for/)
      }
      await expect(
        database.asClaims(superAdmin.claims, `select public.clinic_admin_simulate_demo_payment('basic', 'card', 'paid', $1)`, [randomUUID()]),
      ).rejects.toThrow(/only for the Clinic Admin/)
      expect(await activePlan(otherClinic)).toMatchObject({ plan_code: 'free' })
    })

    it('refuses visitors', async () => {
      await expect(
        database.asAnon(`select public.clinic_admin_simulate_demo_payment('basic', 'card', 'paid', '${randomUUID()}')`),
      ).rejects.toThrow(/permission denied/)
    })

    it('refuses while the clinic is inactive or the simulator is switched off', async () => {
      await database.asService(`update public.clinic set clinic_status = 'inactive' where clinic_id = $1`, [demoClinic])
      await expect(simulate(demoAdmin, 'basic', 'card', 'paid')).rejects.toThrow(/only for the Clinic Admin/)
      expect(await available(demoAdmin)).toBe(false)
      await database.asService(`update public.clinic set clinic_status = 'active' where clinic_id = $1`, [demoClinic])

      await database.asService('update app_private.demo_payment_simulator_clinic set enabled = false where clinic_id = $1', [demoClinic])
      await expect(simulate(demoAdmin, 'basic', 'card', 'paid')).rejects.toThrow(/only for the Clinic Admin/)
      await database.asService('update app_private.demo_payment_simulator_clinic set enabled = true where clinic_id = $1', [demoClinic])

      const [count] = await database.asService<{ n: number }>(`select count(*)::int n from public.subscription_payment`)
      expect(count!.n).toBe(0)
    })

    it('refuses Free, Enterprise, unknown methods and outcomes, and a missing request id', async () => {
      for (const plan of ['free', 'enterprise', 'gold']) {
        await expect(simulate(demoAdmin, plan, 'card', 'paid')).rejects.toThrow(/Only Basic or Premium/)
      }
      await expect(simulate(demoAdmin, 'basic', 'gcash', 'paid')).rejects.toThrow(/QR \/ Wallet Demo or Card Demo/)
      await expect(simulate(demoAdmin, 'basic', 'card', 'refunded')).rejects.toThrow(/Unknown demo outcome/)
      await expect(
        database.asUser(demoAdmin, `select public.clinic_admin_simulate_demo_payment('basic', 'card', 'paid', null)`),
      ).rejects.toThrow(/request id/)
    })

    it('gives signed-in users no direct write to payments or subscriptions', async () => {
      await expect(
        database.asUser(demoAdmin, `update public.subscription_payment set payment_status = 'paid'`),
      ).rejects.toThrow(/permission denied/)
      await expect(
        database.asUser(demoAdmin, `insert into public.subscription_payment (clinic_id, plan_code, plan_name_snapshot, payment_amount_centavos, payment_provider) values ('${demoClinic}', 'basic', 'Basic', 1, 'demo_simulator')`),
      ).rejects.toThrow(/permission denied/)
    })
  })

  describe('outcomes, seen from both sides', () => {
    let before: Overview

    beforeAll(async () => {
      before = await overview()
    })

    it('a failed payment is recorded and changes no subscription', async () => {
      const result = await simulate(demoAdmin, 'basic', 'card', 'failed')
      expect(result).toMatchObject({ result: 'failed', status: 'failed', plan_code: 'basic', amount_centavos: 99900, method: 'card' })
      expect(result.reference).toMatch(/^RE-[0-9A-F]{10}$/)
      expect(await activePlan(demoClinic)).toMatchObject({ plan_code: 'free', subscription_period_end: null })

      const seen = await activity({ status: 'failed' })
      expect(seen.rows).toHaveLength(1)
      expect(seen.rows[0]).toMatchObject({ reference: result.reference, clinic_name: 'RecoverEase Defense Demo Clinic', plan_name: 'Basic', amount_centavos: 99900, method: 'card', status: 'failed', paid_at: null })
      const after = await overview()
      expect(subscribers(after, 'free')).toBe(subscribers(before, 'free'))
      expect(after.revenue.lifetime_centavos).toBe(before.revenue.lifetime_centavos)
    })

    it('a cancelled payment is recorded and changes no subscription', async () => {
      const result = await simulate(demoAdmin, 'premium', 'qr_wallet', 'cancelled')
      expect(result).toMatchObject({ result: 'cancelled', status: 'cancelled', amount_centavos: 249900, method: 'qr_wallet' })
      expect(await activePlan(demoClinic)).toMatchObject({ plan_code: 'free' })
      expect((await activity({ status: 'cancelled' })).rows[0]).toMatchObject({ reference: result.reference, status: 'cancelled' })
      expect((await overview()).revenue.lifetime_centavos).toBe(before.revenue.lifetime_centavos)
    })

    it('a paid Basic payment moves the clinic to Basic, counts the subscriber, and is never revenue', async () => {
      const result = await simulate(demoAdmin, 'basic', 'qr_wallet', 'paid')
      expect(result).toMatchObject({ result: 'activated', status: 'paid', plan_code: 'basic', amount_centavos: 99900, method: 'qr_wallet' })
      expect(result.period_end).not.toBeNull()
      expect(await activePlan(demoClinic)).toMatchObject({ plan_code: 'basic' })
      expect(await activePlan(otherClinic)).toMatchObject({ plan_code: 'free' })

      const [row] = await database.asService<Record<string, unknown>>(
        `select payment_provider, payment_livemode, payment_demo_method, provider_checkout_id, provider_payment_id, provider_payment_intent_id
           from public.subscription_payment where payment_id = $1`,
        [result.payment_id],
      )
      expect(row).toMatchObject({ payment_provider: 'demo_simulator', payment_livemode: false, payment_demo_method: 'qr_wallet', provider_payment_intent_id: null })
      expect(row!.provider_checkout_id).toMatch(/^demo_cs_[0-9a-f]{32}$/)
      expect(row!.provider_payment_id).toMatch(/^demo_pay_[0-9a-f]{32}$/)

      const after = await overview()
      expect(after.total_subscribers).toBe(before.total_subscribers)
      expect(subscribers(after, 'free')).toBe(subscribers(before, 'free') - 1)
      expect(subscribers(after, 'basic')).toBe(subscribers(before, 'basic') + 1)
      expect(after.revenue.lifetime_centavos).toBe(before.revenue.lifetime_centavos)
      expect(after.revenue.this_month_centavos).toBe(before.revenue.this_month_centavos)

      const seen = await activity({ status: 'paid' })
      expect(seen.rows[0]).toMatchObject({ reference: result.reference, clinic_name: 'RecoverEase Defense Demo Clinic', plan_name: 'Basic', amount_centavos: 99900, method: 'qr_wallet', status: 'paid' })
      expect(seen.rows[0]!.paid_at).not.toBeNull()
    })

    it('the Clinic Admin reads their own demo rows; the other clinic reads none', async () => {
      const own = await database.asUser<{ payment_provider: string }>(demoAdmin, 'select payment_provider from public.subscription_payment')
      expect(own).toHaveLength(3)
      expect(own.every((r) => r.payment_provider === 'demo_simulator')).toBe(true)
      expect(await database.asUser(fx.adminUserId, 'select * from public.subscription_payment')).toEqual([])
      expect(await database.asUser(fx.doctorAUserId, 'select * from public.subscription_payment')).toEqual([])
    })

    it('a repeat of the same request changes nothing', async () => {
      const requestId = randomUUID()
      const first = await simulate(demoAdmin, 'basic', 'card', 'paid', requestId)
      const end = (await activePlan(demoClinic)).subscription_period_end
      const again = await simulate(demoAdmin, 'basic', 'card', 'paid', requestId)
      expect(again).toMatchObject({ result: 'duplicate', payment_id: first.payment_id, reference: first.reference, status: 'paid' })
      expect((await activePlan(demoClinic)).subscription_period_end).toEqual(end)
      // A different outcome with the same id is still the first request.
      expect(await simulate(demoAdmin, 'premium', 'qr_wallet', 'failed', requestId)).toMatchObject({ result: 'duplicate', status: 'paid', plan_code: 'basic' })
      const [count] = await database.asService<{ n: number }>(
        `select count(*)::int n from public.subscription_payment where provider_checkout_id = 'demo_cs_' || replace($1, '-', '')`,
        [requestId],
      )
      expect(count!.n).toBe(1)
    })

    it('paying for the plan held extends it by one month from its end', async () => {
      const before = new Date((await activePlan(demoClinic)).subscription_period_end!)
      await simulate(demoAdmin, 'basic', 'card', 'paid')
      const after = new Date((await activePlan(demoClinic)).subscription_period_end!)
      const days = (after.getTime() - before.getTime()) / 86_400_000
      expect(days).toBeGreaterThanOrEqual(28)
      expect(days).toBeLessThanOrEqual(31)
    })

    it('a paid Premium payment replaces Basic at the database’s Premium price', async () => {
      await database.asService(`update public.subscription_plan set plan_price_centavos = 259900 where plan_code = 'premium'`)
      try {
        const result = await simulate(demoAdmin, 'premium', 'card', 'paid')
        expect(result).toMatchObject({ result: 'activated', plan_code: 'premium', amount_centavos: 259900 })
      } finally {
        await database.asService(`update public.subscription_plan set plan_price_centavos = 249900 where plan_code = 'premium'`)
      }
      expect(await activePlan(demoClinic)).toMatchObject({ plan_code: 'premium' })
      const rows = await database.asService<{ plan_code: string; subscription_status: string }>(
        `select plan_code, subscription_status from public.clinic_subscription where clinic_id = $1 order by subscription_created_at`,
        [demoClinic],
      )
      expect(rows.filter((r) => r.subscription_status === 'active')).toEqual([{ plan_code: 'premium', subscription_status: 'active' }])

      const after = await overview()
      expect(subscribers(after, 'premium')).toBe(subscribers(before, 'premium') + 1)
      expect(after.revenue.lifetime_centavos).toBe(before.revenue.lifetime_centavos)
    })
  })

  describe('the Super Admin’s activity', () => {
    it('summarises every demo transaction, with paid ones as demo volume only', async () => {
      const seen = await activity()
      expect(seen.summary).toEqual({ total: 6, paid: 4, failed: 1, cancelled: 1, pending: 0, demo_volume_centavos: 99900 * 3 + 259900 })
      expect(seen.total_matching).toBe(6)
      expect(seen.rows.map((r) => r.created_at)).toEqual([...seen.rows.map((r) => r.created_at)].sort().reverse())
      expect(seen.clinics).toEqual([{ clinic_id: demoClinic, clinic_name: 'RecoverEase Defense Demo Clinic' }])
      expect(JSON.stringify(seen)).not.toMatch(/@|demo_cs_|demo_pay_|user_id/)
    })

    it('filters by clinic, status, method and date, and pages', async () => {
      expect((await activity({ clinic: otherClinic })).rows).toEqual([])
      expect((await activity({ method: 'card' })).rows.every((r) => r.method === 'card')).toBe(true)
      expect((await activity({ status: 'paid', method: 'qr_wallet' })).total_matching).toBe(1)
      expect((await activity({ from: '2000-01-01', to: '2000-01-02' })).total_matching).toBe(0)
      const first = await activity({ size: 4 })
      const second = await activity({ size: 4, page: 1 })
      expect(first.rows).toHaveLength(4)
      expect(second.rows).toHaveLength(2)
      expect(new Set([...first.rows, ...second.rows].map((r) => r.payment_id)).size).toBe(6)
      await expect(activity({ status: 'refunded' })).rejects.toThrow(/Unknown payment status/)
    })

    it('needs an assured Super Admin', async () => {
      const call = 'select public.super_admin_demo_payment_activity() as a'
      await expect(database.asUser(demoAdmin, call)).rejects.toThrow()
      await expect(database.asClaims(claimsFor(superAdmin.userId, null, 'aal1'), call)).rejects.toThrow()
      await expect(database.asAnon(call)).rejects.toThrow(/permission denied/)
    })
  })

  describe('the rules on every payment row', () => {
    it('never lets a demo row be live, and never lets a PayMongo row carry a demo reference', async () => {
      await expect(
        database.asService(`update public.subscription_payment set payment_livemode = true where payment_provider = 'demo_simulator'`),
      ).rejects.toThrow(/subscription_payment_demo_rules/)
      await expect(
        database.asService(
          `insert into public.subscription_payment (clinic_id, plan_code, plan_name_snapshot, payment_amount_centavos, provider_checkout_id)
           values ($1, 'basic', 'Basic', 99900, 'demo_cs_00000000000000000000000000000000')`,
          [otherClinic],
        ),
      ).rejects.toThrow(/subscription_payment_demo_rules/)
      await expect(
        database.asService(
          `insert into public.subscription_payment (clinic_id, plan_code, plan_name_snapshot, payment_amount_centavos, payment_demo_method)
           values ($1, 'basic', 'Basic', 99900, 'card')`,
          [otherClinic],
        ),
      ).rejects.toThrow(/subscription_payment_demo_rules/)
    })

    it('leaves PayMongo checkouts working alongside', async () => {
      const [row] = await database.asService<{ payment_provider: string; payment_demo_method: string | null }>(
        `select payment_provider, payment_demo_method from public.billing_record_checkout($1, 'basic', 'cs_test000001', 'pi_test000001')`,
        [fx.adminUserId],
      )
      expect(row).toEqual({ payment_provider: 'paymongo', payment_demo_method: null })
      // The PayMongo functions never match a demo row.
      const [marked] = await database.asService<{ r: string }>(
        `select public.billing_mark_unpaid(null, null, 'failed') as r`,
      )
      expect(marked!.r).toBe('no_pending_payment')
    })
  })

  describe('rollback', () => {
    it('refuses while demo payments exist', async () => {
      const rollback = await readFile(join(process.cwd(), ROLLBACK_70), 'utf8')
      await expect(database.db.exec(rollback)).rejects.toThrow(/demo simulator payments/)
      const [still] = await database.asService<{ n: number }>(`select count(*)::int n from public.subscription_payment where payment_provider = 'demo_simulator'`)
      expect(still!.n).toBe(6)
    })
  })
})
