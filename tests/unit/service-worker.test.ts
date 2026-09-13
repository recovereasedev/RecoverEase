import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

/**
 * public/sw.js, run in a sandbox with the Service Worker globals stood in.
 *
 * What matters in a healthcare app is what the worker leaves alone: it must
 * never answer, or keep, an API, sign-in or data request. It answers page
 * loads only - from the network, with the offline page as the one fallback -
 * and the only thing it ever stores is that page.
 */

const source = readFileSync(join(process.cwd(), 'public/sw.js'), 'utf8')

type Listener = (event: Record<string, unknown>) => void

class FakeRequest {
  url: string
  cache: string | undefined
  constructor(url: string, init?: { cache?: string }) {
    this.url = url
    this.cache = init?.cache
  }
}

function loadWorker({
  network,
  existingCaches = [],
}: {
  network: (request: unknown) => Promise<unknown>
  existingCaches?: string[]
}) {
  const listeners: Record<string, Listener> = {}
  const stores = new Map<string, Map<string, unknown>>(
    existingCaches.map((name) => [name, new Map()]),
  )
  const added: FakeRequest[] = []
  const put = vi.fn()

  const caches = {
    keys: vi.fn(async () => [...stores.keys()]),
    open: vi.fn(async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map())
      const store = stores.get(name) as Map<string, unknown>
      return {
        add: vi.fn(async (request: FakeRequest) => {
          added.push(request)
          store.set(request.url, { offlinePage: request.url })
        }),
        put,
      }
    }),
    match: vi.fn(async (url: string) => {
      for (const store of stores.values()) if (store.has(url)) return store.get(url)
      return undefined
    }),
    delete: vi.fn(async (name: string) => stores.delete(name)),
  }

  const self = {
    addEventListener: (type: string, listener: Listener) => {
      listeners[type] = listener
    },
    skipWaiting: vi.fn(async () => undefined),
    clients: { claim: vi.fn(async () => undefined) },
  }
  const fetch = vi.fn(network)
  const ResponseStub = { error: () => ({ type: 'error' }) }

  runInNewContext(source, { self, caches, fetch, Request: FakeRequest, Response: ResponseStub })

  async function lifecycle(type: 'install' | 'activate') {
    let pending: Promise<unknown> = Promise.resolve()
    listeners[type]?.({ waitUntil: (promise: Promise<unknown>) => (pending = promise) })
    await pending
  }

  async function request(init: { url: string; mode: string; method?: string }) {
    const respondWith = vi.fn()
    listeners.fetch?.({ request: { method: 'GET', ...init }, respondWith })
    const answered = respondWith.mock.calls.length > 0
    return { answered, response: answered ? await respondWith.mock.calls[0]?.[0] : undefined }
  }

  return { lifecycle, request, stores, added, put, fetch, self, caches }
}

describe('installing', () => {
  it('stores the offline page, fresh from the server, and nothing else', async () => {
    const worker = loadWorker({ network: async () => ({}) })
    await worker.lifecycle('install')

    expect(worker.added.map((request) => [request.url, request.cache])).toEqual([
      ['/offline.html', 'reload'],
    ])
    expect([...worker.stores.keys()]).toEqual(['recoverease-offline-v1'])
    expect(worker.self.skipWaiting).toHaveBeenCalledTimes(1)
  })
})

describe('taking over from an older worker', () => {
  it('removes older RecoverEase storage, leaves anything else, and takes control', async () => {
    const worker = loadWorker({
      network: async () => ({}),
      existingCaches: ['recoverease-offline-v0', 'recoverease-offline-v1', 'unrelated-cache'],
    })
    await worker.lifecycle('activate')

    expect([...worker.stores.keys()].sort()).toEqual(['recoverease-offline-v1', 'unrelated-cache'])
    expect(worker.self.clients.claim).toHaveBeenCalledTimes(1)
  })
})

describe('requests it leaves alone', () => {
  it.each([
    ['a Supabase data read', { url: 'https://abc.supabase.co/rest/v1/patient?select=*', mode: 'cors' }],
    ['a sign-in', { url: 'https://abc.supabase.co/auth/v1/token', mode: 'cors', method: 'POST' }],
    ['an Edge Function call', { url: 'https://abc.supabase.co/functions/v1/chatbot-reply', mode: 'cors', method: 'POST' }],
    ['the app’s own code', { url: '/assets/index-abc123.js', mode: 'cors' }],
    ['a stylesheet', { url: '/assets/index-abc123.css', mode: 'no-cors' }],
    ['a posted page', { url: '/sign-in', mode: 'navigate', method: 'POST' }],
  ])('does not answer %s', async (_label, init) => {
    const worker = loadWorker({ network: async () => ({}) })
    const { answered } = await worker.request(init)

    expect(answered).toBe(false)
    expect(worker.fetch).not.toHaveBeenCalled()
  })
})

describe('page loads', () => {
  it('come from the network and are never stored', async () => {
    const live = { live: true }
    const worker = loadWorker({ network: async () => live })
    await worker.lifecycle('install')

    const { answered, response } = await worker.request({ url: '/patient/medications', mode: 'navigate' })

    expect(answered).toBe(true)
    expect(response).toBe(live)
    expect(worker.put).not.toHaveBeenCalled()
    expect([...(worker.stores.get('recoverease-offline-v1') as Map<string, unknown>).keys()]).toEqual([
      '/offline.html',
    ])
  })

  it('show the offline page when the network cannot be reached', async () => {
    const worker = loadWorker({ network: async () => Promise.reject(new TypeError('Failed to fetch')) })
    await worker.lifecycle('install')

    const { response } = await worker.request({ url: '/patient/medications', mode: 'navigate' })

    expect(response).toEqual({ offlinePage: '/offline.html' })
  })

  it('fail as the browser would if even the offline page is missing', async () => {
    const worker = loadWorker({ network: async () => Promise.reject(new TypeError('Failed to fetch')) })

    const { response } = await worker.request({ url: '/', mode: 'navigate' })

    expect(response).toEqual({ type: 'error' })
  })
})

it('has no code path that stores a response', () => {
  expect(source).not.toMatch(/\.put\(/)
})
