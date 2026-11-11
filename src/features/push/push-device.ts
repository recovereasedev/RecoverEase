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
  /** The endpoints the server has for the signed-in user. */
  savedEndpoints(): Promise<string[]>
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
    async savedEndpoints() {
      const { data, error } = await supabase.from('push_subscription').select('push_endpoint')
      if (error) throw error
      return (data ?? []).map((row) => row.push_endpoint)
    },
  }
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

/** The state the switch shows. Reads only; never prompts. */
export async function readPushState(env: PushEnvironment = browserPushEnvironment()): Promise<PushState> {
  if (!env.serviceWorker || !env.hasPushManager || !env.notification) return 'unsupported'
  if (!env.vapidPublicKey) return 'unavailable'
  if (env.notification.permission === 'denied') return 'blocked'
  const registration = await workerRegistration(env)
  if (!registration) return 'no-worker'
  const subscription = await registration.pushManager.getSubscription()
  if (!subscription || env.notification.permission !== 'granted') return 'off'
  const saved = await env.savedEndpoints()
  return saved.includes(subscription.endpoint) ? 'on' : 'off'
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
  await env.register({
    endpoint: json.endpoint,
    p256dh: json.keys['p256dh'],
    auth: json.keys['auth'],
    userAgent: env.userAgent.slice(0, 512),
  })
}

/** Removes this device on the server first, then in the browser. */
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
