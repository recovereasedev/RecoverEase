import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Module 7.1, what `sendNotificationToPatient` sends: one insert, under the
 * id the form chose, and a duplicate of that id answered as "already sent".
 */

const client = vi.hoisted(() => {
  const state = {
    inserted: [] as unknown[],
    error: null as { code?: string; message: string } | null,
  }
  const supabase = {
    from: vi.fn((table: string) => ({
      insert: async (row: unknown) => {
        state.inserted.push({ table, row })
        return { data: null, error: state.error }
      },
    })),
  }
  return { state, supabase }
})

vi.mock('@/lib/supabase/client', () => ({ supabase: client.supabase }))

const { sendNotificationToPatient } = await import('@/features/notifications/api')

const MESSAGE = {
  userId: '11111111-1111-4111-8111-111111111111',
  type: 'general' as const,
  message: 'Bring your medication list on Thursday.',
}

beforeEach(() => {
  client.state.inserted.length = 0
  client.state.error = null
})

describe('sendNotificationToPatient', () => {
  it('inserts one general notification under the id it was given', async () => {
    await sendNotificationToPatient({ ...MESSAGE, notificationId: 'n-1' })

    expect(client.state.inserted).toEqual([
      {
        table: 'notification',
        row: {
          notification_id: 'n-1',
          user_id: MESSAGE.userId,
          notification_type: 'general',
          notification_message: MESSAGE.message,
        },
      },
    ])
  })

  it('answers a duplicate of its own id as sent: the first attempt landed', async () => {
    client.state.error = { code: '23505', message: 'duplicate key value violates unique constraint' }

    await expect(
      sendNotificationToPatient({ ...MESSAGE, notificationId: 'n-1' }),
    ).resolves.toBeUndefined()
  })

  it('still fails on every other refusal, and on a duplicate it did not choose', async () => {
    client.state.error = { code: '42501', message: 'new row violates row-level security policy' }
    await expect(
      sendNotificationToPatient({ ...MESSAGE, notificationId: 'n-1' }),
    ).rejects.toMatchObject({ code: '42501' })

    client.state.error = { code: '23505', message: 'duplicate key value violates unique constraint' }
    await expect(sendNotificationToPatient(MESSAGE)).rejects.toMatchObject({ code: '23505' })
  })

  it('lets the database choose the id when none is given', async () => {
    await sendNotificationToPatient(MESSAGE)

    expect((client.state.inserted[0] as { row: object }).row).not.toHaveProperty('notification_id')
  })
})
