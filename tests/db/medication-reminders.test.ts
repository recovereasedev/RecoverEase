import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestDatabase, expectDenied, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * Modules 4.2, 4.7 and 4.9 — the medication reminder loop.
 *
 * A scheduler fires this repeatedly and unattended, so the properties that
 * matter are not "does it send a reminder" but "does it send exactly one,
 * only to people who want it, only when they asked to be contacted, and
 * never twice however often it runs".
 */
describe('medication reminders', () => {
  let database: TestDatabase
  let fx: Fixture

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
  })

  afterAll(async () => {
    await database?.close()
  })

  /** Puts a dose in the past so the dispatcher considers it overdue. */
  async function overdueDose(minutesAgo: number): Promise<string> {
    const [row] = await database.asService<{ medication_log_id: string }>(
      `insert into public.medication_log
         (medication_schedule_id, medication_log_scheduled_at)
       values ($1, now() - make_interval(mins => $2))
       returning medication_log_id`,
      [fx.aliceScheduleId, minutesAgo],
    )
    return row!.medication_log_id
  }

  async function dispatch(graceMinutes = 30): Promise<number> {
    const [row] = await database.asService<{
      dispatch_medication_reminders: number
    }>('select public.dispatch_medication_reminders($1)', [graceMinutes])
    return Number(row!.dispatch_medication_reminders)
  }

  async function aliceNotifications(): Promise<number> {
    const [row] = await database.asService<{ count: string }>(
      `select count(*) from public.notification
        where user_id = $1 and notification_type = 'medication'`,
      [fx.aliceUserId],
    )
    return Number(row!.count)
  }

  beforeEach(async () => {
    // Reset the reminder surface between cases so each starts from a known
    // state without rebuilding the whole fixture.
    await database.asService(
      `delete from public.notification where notification_type = 'medication'`,
    )
    await database.asService(
      `delete from public.medication_log
        where medication_log_scheduled_at < now()`,
    )
    await database.asService(
      `update public.patient
          set pat_reminder_is_enabled = true,
              pat_reminder_preferred_time = null`,
    )
  })

  // =========================================================================
  describe('dispatch', () => {
    it('chases a dose that came due and was not recorded', async () => {
      await overdueDose(120)

      expect(await dispatch()).toBe(1)
      expect(await aliceNotifications()).toBe(1)
    })

    it('names the medication and its due time in the message', async () => {
      await overdueDose(120)
      await dispatch()

      const [row] = await database.asService<{ notification_message: string }>(
        `select notification_message from public.notification
          where user_id = $1 and notification_type = 'medication'`,
        [fx.aliceUserId],
      )

      // A reminder that does not say which medication is not actionable for
      // a patient on several.
      expect(row?.notification_message).toContain('Paracetamol')
      expect(row?.notification_message).toContain('500mg')
    })

    it('stamps the dose so it is recorded as chased', async () => {
      const doseId = await overdueDose(120)
      await dispatch()

      const [row] = await database.asService<{
        medication_log_follow_up_sent_at: string | null
      }>(
        `select medication_log_follow_up_sent_at from public.medication_log
          where medication_log_id = $1`,
        [doseId],
      )

      expect(row?.medication_log_follow_up_sent_at).not.toBeNull()
    })

    it('is idempotent — running again sends nothing', async () => {
      await overdueDose(120)

      expect(await dispatch()).toBe(1)
      expect(await dispatch()).toBe(0)
      expect(await dispatch()).toBe(0)

      // The property that matters: a scheduler firing every 15 minutes must
      // not produce a reminder every 15 minutes.
      expect(await aliceNotifications()).toBe(1)
    })

    it('sends one reminder per dose, not one per run', async () => {
      await overdueDose(120)
      await overdueDose(180)
      await overdueDose(240)

      expect(await dispatch()).toBe(3)
      expect(await dispatch()).toBe(0)
      expect(await aliceNotifications()).toBe(3)
    })

    it('leaves a dose alone until the grace period has passed', async () => {
      // Due 10 minutes ago, 30-minute grace. The patient may simply not have
      // opened the app yet; chasing immediately would be nagging.
      await overdueDose(10)

      expect(await dispatch(30)).toBe(0)
      expect(await aliceNotifications()).toBe(0)
    })

    it('does not chase a dose the patient already recorded', async () => {
      const doseId = await overdueDose(120)
      await database.asService(
        `update public.medication_log
            set medication_log_status = 'taken'
          where medication_log_id = $1`,
        [doseId],
      )

      expect(await dispatch()).toBe(0)
    })

    it('does not chase a dose already marked missed', async () => {
      const doseId = await overdueDose(600)
      await database.asService(
        `update public.medication_log
            set medication_log_status = 'missed'
          where medication_log_id = $1`,
        [doseId],
      )

      expect(await dispatch()).toBe(0)
    })
  })

  // =========================================================================
  describe('patient preferences (module 4.9)', () => {
    it('sends nothing to a patient who turned reminders off', async () => {
      await database.asService(
        `update public.patient set pat_reminder_is_enabled = false
          where pat_id = $1`,
        [fx.alicePatId],
      )
      await overdueDose(120)

      expect(await dispatch()).toBe(0)
      expect(await aliceNotifications()).toBe(0)
    })

    it('waits until the preferred time of day has been reached', async () => {
      // Preferred time set to just under an hour from now, in clinic-local
      // terms, so "now" is definitively before it.
      await database.asService(
        `update public.patient
            set pat_reminder_preferred_time =
                  ((now() at time zone coalesce(
                     (select system_setting_value from public.system_setting
                       where system_setting_key = 'app.timezone'), 'UTC'
                   )) + interval '50 minutes')::time
          where pat_id = $1`,
        [fx.alicePatId],
      )
      await overdueDose(120)

      expect(await dispatch()).toBe(0)
    })

    it('sends once the preferred time has been reached', async () => {
      await database.asService(
        `update public.patient
            set pat_reminder_preferred_time =
                  ((now() at time zone coalesce(
                     (select system_setting_value from public.system_setting
                       where system_setting_key = 'app.timezone'), 'UTC'
                   )) - interval '50 minutes')::time
          where pat_id = $1`,
        [fx.alicePatId],
      )
      await overdueDose(120)

      expect(await dispatch()).toBe(1)
    })

    it('sends immediately when no preference is set', async () => {
      await overdueDose(120)
      expect(await dispatch()).toBe(1)
    })
  })

  // =========================================================================
  describe('reminders reach only their own patient', () => {
    it('notifies the dose owner and nobody else', async () => {
      await overdueDose(120)
      await dispatch()

      // Bob shares Alice's doctor. A join written one table too shallow would
      // fan the reminder out across the caseload.
      for (const userId of [fx.bobUserId, fx.carolUserId, fx.doctorAUserId]) {
        const [row] = await database.asService<{ count: string }>(
          `select count(*) from public.notification
            where user_id = $1 and notification_type = 'medication'`,
          [userId],
        )
        expect(Number(row!.count)).toBe(0)
      }
    })

    it('is readable only by its addressee', async () => {
      await overdueDose(120)
      await dispatch()

      const alice = await database.asUser(
        fx.aliceUserId,
        `select notification_id from public.notification
          where notification_type = 'medication'`,
      )
      expect(alice).toHaveLength(1)

      // The patient's own doctor cannot read it either: notifications are
      // addressed, and RLS scopes them to the addressee.
      const doctor = await database.asUser(
        fx.doctorAUserId,
        `select notification_id from public.notification
          where notification_type = 'medication'`,
      )
      expect(doctor).toEqual([])
    })
  })

  // =========================================================================
  describe('permissions', () => {
    it.each([
      'dispatch_medication_reminders(30)',
      'extend_all_medication_log_slots(30)',
      'mark_overdue_medication_logs(6)',
      'generate_medication_log_slots($1, 30)',
    ])('refuses %s to a signed-in user', async (call) => {
      const params = call.includes('$1') ? [fx.aliceScheduleId] : []
      await expectDenied(() =>
        database.asUser(fx.aliceUserId, `select public.${call}`, params),
      )
    })

    it('refuses the dispatcher to an anonymous caller', async () => {
      await expectDenied(() =>
        database.asAnon('select public.dispatch_medication_reminders(30)'),
      )
    })
  })

  // =========================================================================
  describe('slot generation', () => {
    it('is idempotent — regenerating creates no duplicates', async () => {
      const countSlots = async () => {
        const [row] = await database.asService<{ count: string }>(
          `select count(*) from public.medication_log
            where medication_schedule_id = $1`,
          [fx.aliceScheduleId],
        )
        return Number(row!.count)
      }

      const generate = async () => {
        const [row] = await database.asService<{
          generate_medication_log_slots: number
        }>('select public.generate_medication_log_slots($1, 30)', [
          fx.aliceScheduleId,
        ])
        return Number(row!.generate_medication_log_slots)
      }

      // Bring the window up to date first. The suite's beforeEach clears
      // past-dated doses, and regenerating legitimately restores today's
      // earlier slots — so the run that matters is the one after that.
      await generate()
      const settled = await countSlots()

      // The property: a second run over the same window inserts nothing.
      expect(await generate()).toBe(0)
      expect(await generate()).toBe(0)
      expect(await countSlots()).toBe(settled)
    })

    it('generates doses at the wall-clock time in the clinic zone', async () => {
      await database.asService(
        `insert into public.system_setting
           (system_setting_key, system_setting_value)
         values ('app.timezone', 'Asia/Manila')
         on conflict (system_setting_key)
           do update set system_setting_value = excluded.system_setting_value`,
      )

      const [prescription] = await database.asService<{
        prescription_id: string
      }>(
        `insert into public.prescription (pat_id, doc_id)
         values ($1, $2) returning prescription_id`,
        [fx.bobPatId, fx.doctorAId],
      )

      const [schedule] = await database.asService<{
        medication_schedule_id: string
      }>(
        `insert into public.medication_schedule
           (prescription_id, medication_schedule_name,
            medication_schedule_dosage, medication_schedule_frequency,
            medication_schedule_times)
         values ($1, 'Amoxicillin', '250mg', 1, '{08:00}'::time[])
         returning medication_schedule_id`,
        [prescription!.prescription_id],
      )

      const [slot] = await database.asService<{ local_time: string }>(
        `select to_char(
                  medication_log_scheduled_at at time zone 'Asia/Manila',
                  'HH24:MI'
                ) as local_time
           from public.medication_log
          where medication_schedule_id = $1
          order by medication_log_scheduled_at
          limit 1`,
        [schedule!.medication_schedule_id],
      )

      // A dose set for 08:00 must mean 08:00 where the patient lives. Stored
      // naively it would land at 08:00 UTC, which is 16:00 in Manila.
      expect(slot?.local_time).toBe('08:00')
    })
  })

  // =========================================================================
  describe('marking overdue doses', () => {
    it('writes off only pending doses past the grace period', async () => {
      const stale = await overdueDose(60 * 12) // 12 hours ago
      const recent = await overdueDose(60) // 1 hour ago

      const [row] = await database.asService<{
        mark_overdue_medication_logs: number
      }>('select public.mark_overdue_medication_logs(6)')
      expect(Number(row!.mark_overdue_medication_logs)).toBe(1)

      const statusOf = async (id: string) => {
        const [found] = await database.asService<{
          medication_log_status: string
        }>(
          `select medication_log_status from public.medication_log
            where medication_log_id = $1`,
          [id],
        )
        return found?.medication_log_status
      }

      expect(await statusOf(stale)).toBe('missed')
      expect(await statusOf(recent)).toBe('pending')
    })

    it('does not overwrite a dose the patient recorded late', async () => {
      const doseId = await overdueDose(60 * 12)
      await database.asService(
        `update public.medication_log
            set medication_log_status = 'taken'
          where medication_log_id = $1`,
        [doseId],
      )

      await database.asService('select public.mark_overdue_medication_logs(6)')

      const [row] = await database.asService<{ medication_log_status: string }>(
        `select medication_log_status from public.medication_log
          where medication_log_id = $1`,
        [doseId],
      )
      expect(row?.medication_log_status).toBe('taken')
    })
  })
})
