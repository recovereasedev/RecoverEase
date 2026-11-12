import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

import {
  PUSH_BODIES,
  PUSH_TITLE,
  PUSH_URLS,
} from '../../supabase/functions/send-push/payload'

/**
 * public/sw.js's Web Push half, in a sandbox: what a push shows and where a
 * tap goes. The lock screen must only ever say the generic words, and a tap
 * must only ever open one of the patient's own signed-in pages - whatever
 * the message says.
 */

const source = readFileSync(join(process.cwd(), 'public/sw.js'), 'utf8')

type Listener = (event: Record<string, unknown>) => void

function loadWorker(windows: { url: string; navigate?: () => Promise<unknown> }[] = []) {
  const listeners: Record<string, Listener> = {}
  const shown: { title: string; options: Record<string, unknown> }[] = []
  const opened: string[] = []
  const navigated: string[] = []

  const clients = windows.map((w) => {
    const client: Record<string, unknown> = {
      url: w.url,
      focus: vi.fn(async () => client),
      navigate: vi.fn(async (url: string) => {
        if (w.navigate) return w.navigate()
        navigated.push(url)
        return client
      }),
    }
    return client
  })

  const self = {
    addEventListener: (type: string, listener: Listener) => {
      listeners[type] = listener
    },
    location: { origin: 'https://recoverease-web.vercel.app' },
    registration: {
      showNotification: vi.fn(async (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options })
      }),
    },
    clients: {
      claim: vi.fn(),
      matchAll: vi.fn(async () => clients),
      openWindow: vi.fn(async (url: string) => {
        opened.push(url)
        return null
      }),
    },
    skipWaiting: vi.fn(),
  }

  runInNewContext(source, { self, caches: {}, fetch: vi.fn(), Request: class {}, Response: {}, URL })

  async function fire(type: string, event: Record<string, unknown>) {
    let pending: Promise<unknown> = Promise.resolve()
    listeners[type]!({ ...event, waitUntil: (p: Promise<unknown>) => (pending = p) })
    await pending
  }

  return {
    shown,
    opened,
    navigated,
    push: (data: unknown) =>
      fire('push', {
        data:
          data === undefined
            ? null
            : {
                json: () => {
                  if (data instanceof Error) throw data
                  return data
                },
              },
      }),
    click: (url: unknown) => {
      const close = vi.fn()
      return fire('notificationclick', { notification: { data: { url }, close } }).then(() => close)
    },
  }
}

describe('a push arriving', () => {
  it('shows the reminder sentence for a reminder, with the page to open', async () => {
    const worker = loadWorker()
    await worker.push({ purpose: 'reminder', url: '/patient/medications', tag: 'recoverease-abc' })
    expect(worker.shown).toEqual([
      {
        title: 'RecoverEase',
        options: expect.objectContaining({
          body: 'You have a reminder in RecoverEase.',
          tag: 'recoverease-abc',
          data: { url: '/patient/medications' },
        }),
      },
    ])
  })

  it('shows the appointment-update sentence for a cancellation, never "reminder"', async () => {
    const worker = loadWorker()
    await worker.push({ purpose: 'appointment_update', url: '/patient/appointments', tag: 'recoverease-def' })
    expect(worker.shown[0]).toEqual({
      title: 'RecoverEase',
      options: expect.objectContaining({
        body: 'You have an appointment update in RecoverEase.',
        data: { url: '/patient/appointments' },
      }),
    })
    expect(JSON.stringify(worker.shown)).not.toMatch(/reminder in/i)
  })

  it('never shows words the message carries', async () => {
    const worker = loadWorker()
    await worker.push({
      purpose: 'reminder',
      title: 'Take your Sertraline 50mg',
      body: 'Amoxicillin 500mg is due at 08:00 - Dr. Reyes',
      url: '/patient/appointments',
    })
    await worker.push({ purpose: 'Your appointment with Dr. Reyes on Monday is cancelled' })
    const text = JSON.stringify(worker.shown)
    expect(text).not.toMatch(/Sertraline|Amoxicillin|mg|Reyes|08:00|Monday|cancelled/)
    expect(worker.shown.map((s) => s.title)).toEqual(['RecoverEase', 'RecoverEase'])
  })

  it('shows a neutral sentence - not "reminder" - for an empty, unknown or unreadable message', async () => {
    const worker = loadWorker()
    await worker.push(undefined)
    await worker.push(new Error('not JSON'))
    await worker.push({ purpose: 'something new' })
    await worker.push({ purpose: 'constructor' })
    await worker.push('just a string')
    expect(worker.shown).toHaveLength(5)
    for (const { title, options } of worker.shown) {
      expect(title).toBe('RecoverEase')
      expect(options['body']).toBe('You have a new notification in RecoverEase.')
      expect(options['data']).toEqual({ url: '/patient/notifications' })
      expect(options['tag']).toBe('recoverease-reminder')
    }
  })

  it('opens only the patient pages on its list', async () => {
    const worker = loadWorker()
    for (const url of ['https://evil.example/phish', '//evil.example', '/doctor/patients', 'javascript:alert(1)']) {
      await worker.push({ purpose: 'reminder', url })
    }
    expect(worker.shown.map((s) => (s.options['data'] as { url: string }).url)).toEqual([
      '/patient/notifications',
      '/patient/notifications',
      '/patient/notifications',
      '/patient/notifications',
    ])
  })

  it('agrees with the server on the words and the pages', () => {
    expect(source).toContain(`const PUSH_TITLE = '${PUSH_TITLE}'`)
    for (const [purpose, body] of Object.entries(PUSH_BODIES)) {
      expect(source).toContain(`  ${purpose}: '${body}',`)
    }
    for (const url of PUSH_URLS) expect(source).toContain(`'${url}'`)
  })

  it('writes nothing: no fetch, no medication record', () => {
    const pushHalf = source.slice(source.indexOf('// Web Push (migration 53)'))
    expect(pushHalf).not.toMatch(/fetch\(|supabase\.co|createClient|\.rpc\(|\.from\(|medication_log/)
  })
})

describe('tapping the notification', () => {
  it('opens a new window when RecoverEase is not open', async () => {
    const worker = loadWorker()
    const close = await worker.click('/patient/appointments')
    expect(close).toHaveBeenCalled()
    expect(worker.opened).toEqual(['/patient/appointments'])
  })

  it('reuses an open RecoverEase window', async () => {
    const worker = loadWorker([{ url: 'https://recoverease-web.vercel.app/patient' }])
    await worker.click('/patient/medications')
    expect(worker.navigated).toEqual(['/patient/medications'])
    expect(worker.opened).toEqual([])
  })

  it('opens a window if the open one cannot be steered', async () => {
    const worker = loadWorker([
      { url: 'https://recoverease-web.vercel.app/patient', navigate: () => Promise.reject(new TypeError('uncontrolled')) },
    ])
    await worker.click('/patient/medications')
    expect(worker.opened).toEqual(['/patient/medications'])
  })

  it('ignores windows of other sites and URLs off the list', async () => {
    const worker = loadWorker([{ url: 'https://other.example/' }])
    await worker.click('https://evil.example/')
    expect(worker.opened).toEqual(['/patient/notifications'])
  })
})
