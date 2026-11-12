import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { isSupportedPushEndpoint } from '@/features/push/push-device'

import { isAllowedPushEndpoint, PUSH_ENDPOINT_PATTERN } from '../../supabase/functions/_shared/push-endpoint'
import { ALLOWED_ENDPOINTS, REFUSED_ENDPOINTS } from '../db/helpers/push-endpoints'

/**
 * Which push endpoints the server will make a signed request to.
 *
 * The endpoint comes from a browser, so without a rule the server could be
 * pointed at any host (SSRF). Only Chrome-on-Android's FCM endpoints are
 * allowed. The rule lives in three places - the Edge Function (checked just
 * before each request), the database (migration 53: on registration and on
 * claim) and the browser (to explain an unsupported browser) - and this
 * keeps all three the same. tests/db/web-push.test.ts runs the same lists
 * against the database's function.
 */

describe('the push endpoint allow-list', () => {
  it.each(ALLOWED_ENDPOINTS)('allows %s', (endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(true)
    expect(isSupportedPushEndpoint(endpoint)).toBe(true)
  })

  it.each(REFUSED_ENDPOINTS)('refuses %j', (endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(false)
    expect(isSupportedPushEndpoint(endpoint)).toBe(false)
  })

  it('refuses anything that is not a string', () => {
    for (const value of [null, undefined, 42, {}, ['https://fcm.googleapis.com/fcm/send/abcdefghijklmnop']]) {
      expect(isAllowedPushEndpoint(value)).toBe(false)
    }
  })

  it('is the same rule in the database, the Edge Function and the browser', () => {
    const pattern = PUSH_ENDPOINT_PATTERN.source.replace(/\\\//g, '/')
    const migration = readFileSync(
      join(process.cwd(), 'supabase/migrations/20260902100053_web_push_notifications.sql'),
      'utf8',
    )
    expect(migration).toContain(`endpoint ~ '${pattern}'`)
    const browser = readFileSync(join(process.cwd(), 'src/features/push/push-device.ts'), 'utf8')
    expect(browser).toContain(`const SUPPORTED_PUSH_ENDPOINT = /${PUSH_ENDPOINT_PATTERN.source}/`)
  })
})
