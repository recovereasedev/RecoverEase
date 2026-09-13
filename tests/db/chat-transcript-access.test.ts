import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDatabase, expectDenied, type TestDatabase } from './helpers/database'
import { seedFixture, type Fixture } from './helpers/fixtures'

/**
 * Module 8.5 "View Patient Chat Transcript", and the critical-chat alert that
 * leads to it.
 *
 * The doctor's transcript view adds no policy. It reads `chat_session` and
 * `chat_message` through the existing ones, which admit the patient and their
 * assigned, active doctor and nobody else. These tests pin that down for the
 * conversation the view shows, and for the one extra read the alert makes:
 * resolving which patient a flagged conversation belongs to.
 */
describe('reading a patient’s guidance chat', () => {
  let database: TestDatabase
  let fx: Fixture

  beforeAll(async () => {
    database = await createTestDatabase()
    fx = await seedFixture(database)
  })

  afterAll(async () => {
    await database?.close()
  })

  const readSession = (userId: string) =>
    database.asUser<{ pat_id: string }>(
      userId,
      `select pat_id from public.chat_session where chat_session_id = $1`,
      [fx.aliceChatSessionId],
    )

  const readMessages = (userId: string) =>
    database.asUser<{ role: string; content: string }>(
      userId,
      `select chat_message_role as role, chat_message_content as content
         from public.chat_message where chat_session_id = $1
        order by chat_message_created_at`,
      [fx.aliceChatSessionId],
    )

  it('lets the assigned doctor read the conversation and its messages', async () => {
    expect(await readSession(fx.doctorAUserId)).toEqual([{ pat_id: fx.alicePatId }])
    expect(await readMessages(fx.doctorAUserId)).toEqual([
      { role: 'patient', content: 'Is swelling normal after two weeks?' },
    ])
  })

  it('still lets the patient read their own', async () => {
    expect(await readSession(fx.aliceUserId)).toEqual([{ pat_id: fx.alicePatId }])
    expect(await readMessages(fx.aliceUserId)).toHaveLength(1)
  })

  it.each([
    ['another doctor', 'doctorBUserId'],
    ['another patient of the same doctor', 'bobUserId'],
    ['an administrator', 'adminUserId'],
  ] as const)('shows %s nothing', async (_label, who) => {
    await expectDenied(() => readSession(fx[who]))
    await expectDenied(() => readMessages(fx[who]))
  })

  it('shows a visitor with no session nothing', async () => {
    await expectDenied(() =>
      database.asAnon(`select pat_id from public.chat_session where chat_session_id = $1`, [
        fx.aliceChatSessionId,
      ]),
    )
    await expectDenied(() =>
      database.asAnon(`select 1 from public.chat_message where chat_session_id = $1`, [
        fx.aliceChatSessionId,
      ]),
    )
  })

  describe('the critical-chat alert', () => {
    /** An alert as chatbot-reply writes it, addressed to `userId`. */
    async function alert(userId: string): Promise<string> {
      const [row] = await database.asService<{ id: string }>(
        `insert into public.notification
           (user_id, chat_session_id, notification_type, notification_message)
         values ($1, $2, 'chat_critical',
                 'A patient raised a concern in the guidance chat that may need your attention.')
         returning notification_id as id`,
        [userId, fx.aliceChatSessionId],
      )
      return row!.id
    }

    // The same read the notifications list makes: the alert, with its
    // conversation's patient embedded through the conversation's own policy.
    const resolve = (userId: string, notificationId: string) =>
      database.asUser<{ chat_session_id: string | null; pat_id: string | null }>(
        userId,
        `select n.chat_session_id, cs.pat_id
           from public.notification n
           left join public.chat_session cs on cs.chat_session_id = n.chat_session_id
          where n.notification_id = $1`,
        [notificationId],
      )

    it('resolves the conversation’s patient for the assigned doctor', async () => {
      const id = await alert(fx.doctorAUserId)

      expect(await resolve(fx.doctorAUserId, id)).toEqual([
        { chat_session_id: fx.aliceChatSessionId, pat_id: fx.alicePatId },
      ])
    })

    it('resolves no patient for a doctor the patient is not assigned to', async () => {
      // Not something chatbot-reply writes; the point is that even an alert
      // naming someone else's conversation leads nowhere.
      const id = await alert(fx.doctorBUserId)

      expect(await resolve(fx.doctorBUserId, id)).toEqual([
        { chat_session_id: fx.aliceChatSessionId, pat_id: null },
      ])
    })

    it('is readable only by the doctor it was sent to', async () => {
      const id = await alert(fx.doctorAUserId)

      await expectDenied(() => resolve(fx.doctorBUserId, id))
      await expectDenied(() => resolve(fx.aliceUserId, id))
    })
  })
})
