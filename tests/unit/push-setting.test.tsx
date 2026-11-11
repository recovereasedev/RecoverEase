import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { PushEnvironment } from '@/features/push/push-device'

/**
 * The patient's "Reminders on this phone" switch (migration 53), with the
 * browser's push machinery and the database replaced by a fake device.
 *
 * What matters: the switch shows the truth for this device; switching on
 * asks for permission only from the tap and saves this device; switching
 * off removes it from the server before the browser; a blocked or
 * unsupported browser is explained rather than offered a switch that
 * cannot work; and signing out forgets the device.
 */

vi.mock('@/features/auth/auth-context', () => ({
  useCurrentUser: () => ({ userId: 'u-alice', role: 'patient', profile: { kind: 'patient' } }),
}))

const { PushSetting } = await import('@/features/push/components/push-setting')
const { forgetPushOnSignOut, applicationServerKey, readPushState } = await import('@/features/push/push-device')

const VAPID = 'B' + 'A'.repeat(86)

function fakeDevice(options: {
  permission?: NotificationPermission
  answer?: NotificationPermission
  worker?: boolean
  vapid?: string | undefined
  existing?: boolean
  saved?: boolean
} = {}) {
  let permission = options.permission ?? 'default'
  let subscription: PushSubscription | null = null
  const saved = new Set<string>()

  const makeSubscription = (endpoint: string) =>
    ({
      endpoint,
      options: { applicationServerKey: applicationServerKey(VAPID).buffer },
      toJSON: () => ({ endpoint, keys: { p256dh: 'device-key', auth: 'device-auth' } }),
      unsubscribe: vi.fn(async () => {
        subscription = null
        return true
      }),
    }) as unknown as PushSubscription

  if (options.existing) subscription = makeSubscription('https://fcm.googleapis.com/fcm/send/existing')
  if (options.saved && subscription) saved.add(subscription.endpoint)

  const pushManager = {
    getSubscription: vi.fn(async () => subscription),
    subscribe: vi.fn(async () => {
      subscription = makeSubscription('https://fcm.googleapis.com/fcm/send/new')
      return subscription
    }),
  }
  const requestPermission = vi.fn(async () => {
    permission = options.answer ?? 'granted'
    return permission
  })

  const env: PushEnvironment = {
    vapidPublicKey: 'vapid' in options ? options.vapid : VAPID,
    serviceWorker: {
      getRegistration: vi.fn(async () => (options.worker === false ? undefined : { pushManager })),
    } as unknown as ServiceWorkerContainer,
    notification: {
      get permission() {
        return permission
      },
      requestPermission,
    },
    hasPushManager: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/140',
    register: vi.fn(async ({ endpoint }) => {
      saved.add(endpoint)
    }),
    unregister: vi.fn(async (endpoint) => {
      saved.delete(endpoint)
    }),
    savedEndpoints: vi.fn(async () => [...saved]),
  }
  return { env, pushManager, requestPermission, saved, current: () => subscription }
}

function renderSetting(env: PushEnvironment) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <PushSetting environment={env} />
    </QueryClientProvider>,
  )
}

const toggle = () => screen.getByRole('switch', { name: /reminders on this phone/i })

describe('the switch', () => {
  it('says what the lock screen shows, before anything is switched on', async () => {
    renderSetting(fakeDevice().env)
    expect(screen.getByText(/You have a reminder in RecoverEase\./)).toBeInTheDocument()
    expect(screen.getByText(/never shows a medicine/i)).toBeInTheDocument()
    await waitFor(() => expect(toggle()).toBeEnabled())
    expect(toggle()).toHaveAttribute('aria-checked', 'false')
  })

  it('switching on asks for permission from the tap, subscribes and saves this device', async () => {
    const device = fakeDevice()
    renderSetting(device.env)
    await waitFor(() => expect(toggle()).toBeEnabled())
    expect(device.requestPermission).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(toggle())
    })

    await waitFor(() => expect(toggle()).toHaveAttribute('aria-checked', 'true'))
    expect(device.requestPermission).toHaveBeenCalledTimes(1)
    expect(device.pushManager.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true }),
    )
    expect(device.env.register).toHaveBeenCalledWith({
      endpoint: 'https://fcm.googleapis.com/fcm/send/new',
      p256dh: 'device-key',
      auth: 'device-auth',
      userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/140',
    })
  })

  it('switching off removes the device on the server, then in the browser', async () => {
    const device = fakeDevice({ permission: 'granted', existing: true, saved: true })
    renderSetting(device.env)
    await waitFor(() => expect(toggle()).toHaveAttribute('aria-checked', 'true'))

    await act(async () => {
      fireEvent.click(toggle())
    })

    await waitFor(() => expect(toggle()).toHaveAttribute('aria-checked', 'false'))
    expect(device.env.unregister).toHaveBeenCalledWith('https://fcm.googleapis.com/fcm/send/existing')
    expect(device.current()).toBeNull()
  })

  it('shows off when the browser has a subscription the server no longer has', async () => {
    const device = fakeDevice({ permission: 'granted', existing: true, saved: false })
    expect(await readPushState(device.env)).toBe('off')
  })

  it('explains a refused permission and stays off', async () => {
    const device = fakeDevice({ answer: 'denied' })
    renderSetting(device.env)
    await waitFor(() => expect(toggle()).toBeEnabled())
    await act(async () => {
      fireEvent.click(toggle())
    })
    expect(await screen.findByText(/blocked for RecoverEase/i)).toBeInTheDocument()
    expect(device.env.register).not.toHaveBeenCalled()
  })

  it.each([
    [{ permission: 'denied' as const }, /Notifications are blocked/],
    [{ worker: false }, /from the app on your home screen/],
    [{ vapid: undefined }, /not available yet/],
  ])('cannot be switched when it cannot work (%o)', async (options, message) => {
    renderSetting(fakeDevice(options).env)
    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(toggle()).toBeDisabled()
  })

  it('explains a browser with no Web Push', async () => {
    const { env } = fakeDevice()
    renderSetting({ ...env, hasPushManager: false })
    expect(await screen.findByText(/cannot show RecoverEase notifications/)).toBeInTheDocument()
    expect(toggle()).toBeDisabled()
  })
})

describe('signing out', () => {
  it('forgets this device, and never throws', async () => {
    const device = fakeDevice({ permission: 'granted', existing: true, saved: true })
    await forgetPushOnSignOut(device.env)
    expect(device.saved.size).toBe(0)
    expect(device.current()).toBeNull()

    const failing = fakeDevice({ permission: 'granted', existing: true, saved: true })
    failing.env.unregister = vi.fn(async () => {
      throw new Error('offline')
    })
    await expect(forgetPushOnSignOut(failing.env)).resolves.toBeUndefined()
  })
})
