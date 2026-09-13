import { afterEach, describe, expect, it, vi } from 'vitest'

import { registerServiceWorker } from '@/lib/register-service-worker'

/**
 * Registering the worker that makes RecoverEase installable: production only,
 * for the whole app, checked against the server on every visit, and silent if
 * the browser declines.
 */

function container(result: Promise<unknown> = Promise.resolve({})) {
  return { register: vi.fn(() => result) } as unknown as ServiceWorkerContainer & {
    register: ReturnType<typeof vi.fn>
  }
}

/** Registration waits for the page to load; make sure it has. */
function finishLoading() {
  window.dispatchEvent(new Event('load'))
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('registering the service worker', () => {
  it('registers /sw.js for the whole app, bypassing the HTTP cache, in production', () => {
    const worker = container()
    registerServiceWorker({ container: worker, isProduction: true })
    finishLoading()

    expect(worker.register).toHaveBeenCalledTimes(1)
    expect(worker.register).toHaveBeenCalledWith('/sw.js', {
      scope: '/',
      updateViaCache: 'none',
    })
  })

  it('registers nothing in development', () => {
    const worker = container()
    registerServiceWorker({ container: worker, isProduction: false })
    finishLoading()

    expect(worker.register).not.toHaveBeenCalled()
  })

  it('does nothing where the browser has no service workers', () => {
    expect(() => {
      registerServiceWorker({ container: undefined, isProduction: true })
      finishLoading()
    }).not.toThrow()
  })

  it('treats a refused registration as nothing the user needs to know about', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const worker = container(Promise.reject(new Error('refused')))
    registerServiceWorker({ container: worker, isProduction: true })
    finishLoading()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(worker.register).toHaveBeenCalledTimes(1)
    expect(consoleError).not.toHaveBeenCalled()
  })
})
