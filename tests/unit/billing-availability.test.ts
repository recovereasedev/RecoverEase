import { afterEach, describe, expect, it, vi } from 'vitest'

import { isOnlineCheckoutEnabled } from '@/features/billing/availability'

/**
 * Online checkout (PayMongo) is offered only when the build sets
 * VITE_PAYMONGO_CHECKOUT_ENABLED to exactly "true". Production leaves it
 * unset, so its Clinic Admins never get a button that cannot work.
 */
describe('isOnlineCheckoutEnabled', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('is off when the variable is unset', () => {
    vi.stubEnv('VITE_PAYMONGO_CHECKOUT_ENABLED', undefined)
    expect(isOnlineCheckoutEnabled()).toBe(false)
  })

  it.each(['', 'false', '1', 'yes', 'TRUE '])('is off for %j', (value) => {
    vi.stubEnv('VITE_PAYMONGO_CHECKOUT_ENABLED', value)
    expect(isOnlineCheckoutEnabled()).toBe(false)
  })

  it('is on only for "true"', () => {
    vi.stubEnv('VITE_PAYMONGO_CHECKOUT_ENABLED', 'true')
    expect(isOnlineCheckoutEnabled()).toBe(true)
  })
})
