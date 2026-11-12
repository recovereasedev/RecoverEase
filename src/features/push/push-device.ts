import { supabase } from '@/lib/supabase/client'

/**
 * This device's Web Push subscription (migration 53).
 *
 * Push is per device, not per account: switching it on here says nothing
 * about the patient's other phone. The browser holds the subscription; the
 * server holds a copy of its endpoint and public keys so it can encrypt to
 * them. "On" therefore means both: the browser has a subscription for our
 * key AND the server has it under the signed-in patient. Either alone is
 * "off", and switching on again repairs it.
 *
 * Android Chrome is the target. It needs the service worker, which is
 * registered in production builds only (`register-service-worker.ts`), so
 * in development the switch says push is unavailable rather than hanging.
 */

export type PushState =
  /** This browser cannot receive Web Push at all. */
  | 'unsupported'
  /** The deployment has no VAPID public key yet: push is not switched on server-side. */
  | 'unavailable'
  /** No service worker is running (a development build, or not yet installed). */
  | 'no-worker'
  /** The patient refused notifications for this site in the browser. */
  | 'blocked'
  | 'off'
  | 'on'

export type PushSetupReason = 'blocked' | 'dismissed' | 'no-worker' | 'unavailable' | 'unsupported'

export class PushSetupError extends Error {
  readonly reason: PushSetupReason
  constructor(reason: PushSetupReason, message: string) {
    super(message)
    this.name = 'PushSetupError'
    this.reason = reason
  }
}

/** What the module reaches outside itself for: replaced in the unit tests. */
export type PushEnvironment = {
  vapidPublicKey: string | undefined
  serviceWorker: ServiceWorkerContainer | undefined
  notification: { permission: NotificationPermission; requestPermission(): Promise<NotificationPermission> } | undefined
  hasPushManager: boolean
  userAgent: string
  register(subscription: { endpoint: string; p256dh: string; auth: string; userAgent: string }): Promise<void>
  unregister(endpoint: string): Promise<void>
  /**
   * Whether the server holds this endpoint under the signed-in user: a yes
   * or a no. The browser never reads a stored endpoint or key back.
   */
  isRegistered(endpoint: string): Promise<boolean>
}

export function browserPushEnvironment(): PushEnvironment {
  const hasWindow = typeof window !== 'undefined'
  return {
    vapidPublicKey: (import.meta.env['VITE_VAPID_PUBLIC_KEY'] as string | undefined)?.trim() || undefined,
    serviceWorker:
      typeof navigator !== 'undefined' && 'serviceWorker' in navigator ? navigator.serviceWorker : undefined,
    notification: hasWindow && 'Notification' in window ? window.Notification : undefined,
    hasPushManager: hasWindow && 'PushManager' in window,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    async register({ endpoint, p256dh, auth, userAgent }) {
      const { error } = await supabase.rpc('register_push_subscription', {
        endpoint,
        p256dh,
        auth_key: auth,
        user_agent: userAgent,
      })
      if (error) throw error
    },
    async unregister(endpoint) {
      const { error } = await supabase.rpc('unregister_push_subscription', { endpoint })
      if (error) throw error
    },
    async isRegistered(endpoint) {
      const { data, error } = await supabase.rpc('push_device_registered', { endpoint })
      if (error) throw error
      return data === true
    },
  }
}

/**
 * The push services RecoverEase sends to: Chrome on Android's, which is
 * Firebase Cloud Messaging. The same rule as the server's
 * (`supabase/functions/_shared/push-endpoint.ts`, and the database's in
 * migration 53), repeated here only to explain an unsupported browser
 * before asking; the server decides.
 */
const SUPPORTED_PUSH_ENDPOINT = /^https:\/\/fcm\.googleapis\.com\/(fcm\/send|wp)\/[A-Za-z0-9_:-]{16,}$/

export function isSupportedPushEndpoint(endpoint: string): boolean {
  return endpoint.length <= 1024 && SUPPORTED_PUSH_ENDPOINT.test(endpoint)
}

/** base64url (the VAPID key's form) to the bytes `subscribe` wants. */
export function applicationServerKey(base64Url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function sameKey(subscription: PushSubscription, key: Uint8Array): boolean {
  const current = subscription.options?.applicationServerKey
  if (!current) return true // Older browsers do not report it; assume ours.
  const bytes = new Uint8Array(current)
  return bytes.length === key.length && bytes.every((byte, i) => byte === key[i])
}

async function workerRegistration(env: PushEnvironment) {
  return env.serviceWorker ? env.serviceWorker.getRegistration() : undefined
}

/**
 * The state the switch shows. Reads only; never prompts.
 *
 * A device the server still holds is 'on' whatever else is true - a missing
 * VAPID key or a blocked permission stops it being switched ON, never OFF.
 * So the saved device is looked for first, and only when there is none do
 * the reasons it cannot be switched on apply. The device is identified by
 * the subscription this browser holds; without one there is nothing here to
 * remove, and no other device's subscription is ever reachable from here.
 */
export async function readPushState(env: PushEnvironment = browserPushEnvironment()): Promise<PushState> {
  if (!env.serviceWorker || !env.hasPushManager) return 'unsupported'
  const registration = await workerRegistration(env)
  const subscription = registration ? await registration.pushManager.getSubscription() : null
  if (subscription && (await env.isRegistered(subscription.endpoint))) return 'on'

  if (!env.notification) return 'unsupported'
  if (!env.vapidPublicKey) return 'unavailable'
  if (env.notification.permission === 'denied') return 'blocked'
  if (!registration) return 'no-worker'
  return 'off'
}

/**
 * Why a device that is 'on' may not actually be showing anything, so the
 * switch can say so while still offering to switch it off.
 */
export function pushDeliveryProblem(env: PushEnvironment = browserPushEnvironment()): 'blocked' | 'unavailable' | null {
  if (env.notification?.permission === 'denied') return 'blocked'
  if (!env.vapidPublicKey) return 'unavailable'
  return null
}

/**
 * Asks for permission (the browser's own prompt, only ever from a tap),
 * subscribes this device, and saves it for the signed-in patient.
 */
export async function enablePush(env: PushEnvironment = browserPushEnvironment()): Promise<void> {
  if (!env.serviceWorker || !env.hasPushManager || !env.notification) {
    throw new PushSetupError('unsupported', 'This browser cannot show RecoverEase notifications.')
  }
  if (!env.vapidPublicKey) {
    throw new PushSetupError('unavailable', 'Phone notifications are not available yet.')
  }

  const permission =
    env.notification.permission === 'granted' ? 'granted' : await env.notification.requestPermission()
  if (permission === 'denied') {
    throw new PushSetupError('blocked', 'Notifications are blocked for RecoverEase in your browser settings.')
  }
  if (permission !== 'granted') {
    throw new PushSetupError('dismissed', 'Notifications were not allowed. Try again when you are ready.')
  }

  const registration = await workerRegistration(env)
  if (!registration) {
    throw new PushSetupError('no-worker', 'Open RecoverEase from your home screen app, then try again.')
  }

  const key = applicationServerKey(env.vapidPublicKey)
  let subscription = await registration.pushManager.getSubscription()
  if (subscription && !sameKey(subscription, key)) {
    // Made for a key this deployment no longer uses: it could never deliver.
    await subscription.unsubscribe()
    subscription = null
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })

  const json = subscription.toJSON()
  if (!json.endpoint || !json.keys?.['p256dh'] || !json.keys?.['auth']) {
    throw new Error('The browser returned an incomplete push subscription.')
  }
  if (!isSupportedPushEndpoint(json.endpoint)) {
    // Another browser's push service. The server would refuse it too
    // (migration 53); leave nothing half-set-up on this device.
    await subscription.unsubscribe().catch(() => undefined)
    throw new PushSetupError(
      'unsupported',
      'Phone reminders work in Chrome on Android for now. This browser is not supported yet.',
    )
  }
  await env.register({
    endpoint: json.endpoint,
    p256dh: json.keys['p256dh'],
    auth: json.keys['auth'],
    userAgent: env.userAgent.slice(0, 512),
  })
}

/**
 * Removes this device on the server first, then in the browser. Needs
 * neither the VAPID key nor notification permission - only the browser's
 * own subscription, which says which device this is. If the server refuses
 * or cannot be reached this throws and the browser's subscription is kept,
 * so the switch stays on rather than claiming something that is not true.
 */
export async function disablePush(env: PushEnvironment = browserPushEnvironment()): Promise<void> {
  const registration = await workerRegistration(env)
  const subscription = registration ? await registration.pushManager.getSubscription() : null
  if (!subscription) return
  await env.unregister(subscription.endpoint)
  await subscription.unsubscribe()
}

/**
 * On sign-out: this phone stops receiving the account's reminders, so the
 * next person to sign in on it does not get them. Best effort - a failure
 * must never keep anyone signed in.
 */
export async function forgetPushOnSignOut(env: PushEnvironment = browserPushEnvironment()): Promise<void> {
  try {
    await disablePush(env)
  } catch {
    // Signed out regardless. The server also moves the endpoint to whoever
    // registers it next, dropping anything queued for this account.
  }
}
