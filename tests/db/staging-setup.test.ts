import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDatabase, type TestDatabase } from './helpers/database'
import { seedFixture } from './helpers/fixtures'
import { createSignIn } from './helpers/super-admin'

/**
 * The PayMongo staging kit (docs/paymongo-staging.md), offline.
 *
 * Staging gets exactly the migrations production has: every file except 34
 * (held in production). This replays that set, runs the synthetic seed, and
 * walks each sandbox scenario through the same database functions the two
 * Edge Functions call, checking that no test payment is ever revenue.
 */

const STAGING_ADMIN = 'staging.clinic.admin@recoverease.test'
const HELD_IN_PRODUCTION = '20260902100034'
const LAST_BEFORE_HELD = '20260902100033'
const sql = (path: string) => readFile(join(process.cwd(), path), 'utf8')

/** Every migration production has, in apply order: all files but 34. */
async function productionSet(): Promise<string[]> {
  const files = (await readdir(join(process.cwd(), 'supabase/migrations'))).filter((f) => f.endsWith('.sql')).sort()
  return files.map((f) => f.slice(0, 14)).filter((v) => v > LAST_BEFORE_HELD && v !== HELD_IN_PRODUCTION)
}

async function stagingDatabase(): Promise<TestDatabase> {
  const database = await createTestDatabase({ stopAfter: LAST_BEFORE_HELD })
  for (const version of await productionSet()) await database.applyMigration(version)
  return database
}

let seq = 0
const id = (prefix: string) => `${prefix}_staging${(++seq).toString().padStart(6, '0')}`

describe('the staging kit', () => {
  let database: TestDatabase
  let adminId: string

  async function checkout(plan: 'basic' | 'premium') {
    const checkoutId = id('cs')
    const [row] = await database.asService<{ payment_amount_centavos: string }>(
      'select payment_amount_centavos from public.billing_record_checkout($1, $2, $3, $4)',
      [adminId, plan, checkoutId, id('pi')],
    )
    return { checkoutId, amount: Number(row!.payment_amount_centavos) }
  }

  async function event(type: string, fields: { checkoutId?: string; amount?: number; livemode?: boolean; eventId?: string; paymentId?: string }) {
    const [row] = await database.asService<{ r: string }>(
      'select public.billing_handle_webhook_event($1, $2, $3, $4, null, $5, $6, $7, now()) as r',
      [
        fields.eventId ?? id('evt'),
        type,
        fields.livemode ?? false,
        fields.checkoutId ?? null,
        fields.paymentId ?? id('pay'),
        fields.amount ?? null,
        fields.amount === undefined ? null : 'PHP',
      ],
    )
    return row!.r
  }

  async function plan() {
    const [row] = await database.asService<{ plan_code: string }>(
      "select plan_code from public.clinic_subscription where subscription_status = 'active'",
    )
    return row!.plan_code
  }

  async function billing() {
    const [row] = await database.asService<{ live_revenue_centavos: string; sandbox_paid_centavos: string; patients: string; payments_by_status: Record<string, number> }>(
      await sql('supabase/staging/verify-billing.sql'),
    )
    return {
      live_revenue_centavos: Number(row!.live_revenue_centavos),
      sandbox_paid_centavos: Number(row!.sandbox_paid_centavos),
      patients: Number(row!.patients),
      payments_by_status: row!.payments_by_status,
    }
  }

  beforeAll(async () => {
    database = await stagingDatabase()
    adminId = await createSignIn(database, STAGING_ADMIN)
    await database.db.exec(await sql('supabase/staging/seed-synthetic.sql'))
  })

  afterAll(async () => {
    await database?.close()
  })

  it('production’s migration set (all but 34) replays, with 68 and 69 in it', async () => {
    const set = await productionSet()
    expect(set).toContain('20260902100068')
    expect(set).toContain('20260902100069')
    expect(set).not.toContain(HELD_IN_PRODUCTION)
    // 34 not applied: the single-clinic gate is still there, as in production.
    const [gate] = await database.asService<{ n: number }>(
      "select count(*)::int as n from pg_indexes where indexname = 'clinic_single_clinic_gate'",
    )
    expect(gate!.n).toBe(1)
    const [column] = await database.asService<{ n: number }>(
      "select count(*)::int as n from information_schema.columns where table_name = 'subscription_payment' and column_name = 'payment_livemode'",
    )
    expect(column!.n).toBe(1)
  })

  it('the seed makes one synthetic clinic on Free and its Clinic Admin, and nothing clinical', async () => {
    const [clinic] = await database.asService<{ clinic_name: string }>('select clinic_name from public.clinic')
    expect(clinic!.clinic_name).toBe('Staging Synthetic Clinic')
    const [admin] = await database.asService<{ n: number }>('select count(*)::int as n from public.admin where user_id = $1', [adminId])
    expect(admin!.n).toBe(1)
    expect(await plan()).toBe('free')
    expect((await billing()).patients).toBe(0)
    // Twice changes nothing more.
    await database.db.exec(await sql('supabase/staging/seed-synthetic.sql'))
    const [admins] = await database.asService<{ n: number }>('select count(*)::int as n from public.admin')
    expect(admins!.n).toBe(1)
  })

  it('a successful Basic payment activates Basic, and is not revenue', async () => {
    const basic = await checkout('basic')
    expect(basic.amount).toBe(99900)
    expect(await event('checkout_session.payment.paid', { checkoutId: basic.checkoutId, amount: basic.amount })).toBe('activated')
    expect(await plan()).toBe('basic')
    const state = await billing()
    expect(state.live_revenue_centavos).toBe(0)
    expect(state.sandbox_paid_centavos).toBe(99900)
  })

  it('a successful Premium payment replaces Basic, and is not revenue', async () => {
    const premium = await checkout('premium')
    expect(premium.amount).toBe(249900)
    expect(await event('checkout_session.payment.paid', { checkoutId: premium.checkoutId, amount: premium.amount })).toBe('activated')
    expect(await plan()).toBe('premium')
    expect((await billing()).live_revenue_centavos).toBe(0)
  })

  it('a failed payment changes nothing', async () => {
    const before = await billing()
    const pending = await checkout('basic')
    const [row] = await database.asService<{ r: string }>("select public.billing_mark_unpaid($1, null, 'failed') as r", [pending.checkoutId])
    expect(row!.r).toBe('marked_failed')
    expect(await plan()).toBe('premium')
    expect((await billing()).sandbox_paid_centavos).toBe(before.sandbox_paid_centavos)
  })

  it('a cancelled checkout changes nothing', async () => {
    const pending = await checkout('basic')
    const [row] = await database.asService<{ r: string }>("select public.billing_mark_unpaid($1, null, 'cancelled') as r", [pending.checkoutId])
    expect(row!.r).toBe('marked_cancelled')
    expect(await plan()).toBe('premium')
  })

  it('an abandoned checkout stays pending and changes nothing', async () => {
    const before = await billing()
    await checkout('basic')
    const after = await billing()
    expect(after.payments_by_status['pending']).toBe((before.payments_by_status['pending'] ?? 0) + 1)
    expect(after.sandbox_paid_centavos).toBe(before.sandbox_paid_centavos)
    expect(await plan()).toBe('premium')
  })

  it('a duplicate webhook applies once', async () => {
    const basic = await checkout('basic')
    const fields = { eventId: id('evt'), paymentId: id('pay'), checkoutId: basic.checkoutId, amount: basic.amount }
    const before = await billing()
    expect(await event('checkout_session.payment.paid', fields)).toBe('activated')
    expect(await event('checkout_session.payment.paid', fields)).toBe('duplicate')
    expect((await billing()).sandbox_paid_centavos - before.sandbox_paid_centavos).toBe(99900)
  })

  it('a tampered amount activates nothing', async () => {
    const premium = await checkout('premium')
    expect(await event('checkout_session.payment.paid', { checkoutId: premium.checkoutId, amount: 100 })).toBe('amount_mismatch')
    expect(await plan()).toBe('basic')
  })

  it('a live-mode event is refused, and live revenue is still 0', async () => {
    const premium = await checkout('premium')
    expect(await event('checkout_session.payment.paid', { checkoutId: premium.checkoutId, amount: premium.amount, livemode: true })).toBe('livemode_not_accepted')
    expect(await plan()).toBe('basic')
    const state = await billing()
    expect(state.live_revenue_centavos).toBe(0)
    expect(state.patients).toBe(0)
  })
})

describe('the staging kit refuses a real database', () => {
  it('the seed refuses a database with patients, doctors or other accounts', async () => {
    const database = await stagingDatabase()
    try {
      await seedFixture(database)
      await createSignIn(database, STAGING_ADMIN)
      await expect(database.db.exec(await sql('supabase/staging/seed-synthetic.sql'))).rejects.toThrow(/real-looking records/)
      const [clinic] = await database.asService<{ n: number }>("select count(*)::int as n from public.clinic where clinic_name = 'Staging Synthetic Clinic'")
      expect(clinic!.n).toBe(0)
    } finally {
      await database.close()
    }
  })

  it('the seed needs the staging auth user first', async () => {
    const database = await stagingDatabase()
    try {
      await expect(database.db.exec(await sql('supabase/staging/seed-synthetic.sql'))).rejects.toThrow(/Create the auth user/)
    } finally {
      await database.close()
    }
  })

  it('the default-privileges step refuses once public has tables', async () => {
    const database = await stagingDatabase()
    try {
      await expect(database.db.exec(await sql('supabase/staging/00-default-privileges.sql'))).rejects.toThrow(/not a new, empty staging project/)
    } finally {
      await database.close()
    }
  })
})
