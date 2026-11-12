import { describe, expect, it, vi } from 'vitest'

import {
  base64UrlDecode,
  base64UrlEncode,
  classifyResponse,
  PUSH_REQUEST_TIMEOUT_MS,
  encryptPayload,
  sendPush,
  vapidAuthorization,
} from '../../supabase/functions/_shared/web-push'

/**
 * The Web Push encryption and signing in `_shared/web-push.ts`, checked the
 * way a phone checks them: the message is decrypted with the device's own
 * private key (RFC 8291), and the VAPID token is verified with our public
 * key (RFC 8292). A mistake in either and Android silently drops the push,
 * so these are the only proof short of a real phone.
 */

const enc = new TextEncoder()
const dec = new TextDecoder()
const buf = (b: Uint8Array) => b.slice().buffer as ArrayBuffer

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) {
  const key = await crypto.subtle.importKey('raw', buf(ikm), 'HKDF', false, ['deriveBits'])
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: buf(info) }, key, length * 8),
  )
}

/** A browser's side: a key pair and an auth secret. */
async function device() {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const auth = crypto.getRandomValues(new Uint8Array(16))
  return {
    pair,
    publicKey,
    auth,
    subscription: {
      endpoint: 'https://fcm.googleapis.com/fcm/send/dEvIcE-token_0123456789:APA91bExample',
      p256dh: base64UrlEncode(publicKey),
      auth: base64UrlEncode(auth),
    },
  }
}

/** What the browser does with an incoming push (RFC 8291 section 3.4, receiving side). */
async function decrypt(body: Uint8Array, d: Awaited<ReturnType<typeof device>>) {
  const salt = body.slice(0, 16)
  const recordSize = new DataView(body.buffer, body.byteOffset).getUint32(16)
  const idLength = body[20]!
  const senderKey = body.slice(21, 21 + idLength)
  const ciphertext = body.slice(21 + idLength)

  const sender = await crypto.subtle.importKey('raw', buf(senderKey), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: sender }, d.pair.privateKey, 256),
  )
  const info = new Uint8Array([...enc.encode('WebPush: info\0'), ...d.publicKey, ...senderKey])
  const ikm = await hkdf(d.auth, shared, info, 32)
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12)
  const key = await crypto.subtle.importKey('raw', buf(cek), 'AES-GCM', false, ['decrypt'])
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(nonce) }, key, buf(ciphertext)))
  return { recordSize, idLength, delimiter: plain[plain.length - 1], text: dec.decode(plain.slice(0, -1)) }
}

async function vapidKeys() {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  return {
    pair,
    vapid: { publicKey: base64UrlEncode(publicKey), privateKey: jwk.d!, subject: 'mailto:ops@example.test' },
  }
}

describe('base64url', () => {
  it('round-trips bytes without padding', () => {
    const bytes = new Uint8Array([0, 255, 62, 63, 250, 1])
    const text = base64UrlEncode(bytes)
    expect(text).not.toMatch(/[+/=]/)
    expect(base64UrlDecode(text)).toEqual(bytes)
  })
})

describe('encryptPayload (RFC 8291)', () => {
  it('produces a message only the device can read', async () => {
    const d = await device()
    const body = await encryptPayload(d.subscription, enc.encode('{"title":"RecoverEase"}'))
    const opened = await decrypt(body, d)
    expect(opened.text).toBe('{"title":"RecoverEase"}')
    expect(opened.delimiter).toBe(2)
    expect(opened.recordSize).toBe(4096)
    expect(opened.idLength).toBe(65)
  })

  it('cannot be read with another device’s keys', async () => {
    const d = await device()
    const other = await device()
    const body = await encryptPayload(d.subscription, enc.encode('secret'))
    await expect(decrypt(body, { ...other, publicKey: d.publicKey, auth: d.auth })).rejects.toThrow()
  })

  it('uses fresh randomness each time', async () => {
    const d = await device()
    const a = await encryptPayload(d.subscription, enc.encode('same'))
    const b = await encryptPayload(d.subscription, enc.encode('same'))
    expect(base64UrlEncode(a)).not.toBe(base64UrlEncode(b))
  })

  it('refuses malformed device keys', async () => {
    const d = await device()
    await expect(
      encryptPayload({ ...d.subscription, p256dh: base64UrlEncode(new Uint8Array(10)) }, enc.encode('x')),
    ).rejects.toThrow(/P-256/)
    await expect(
      encryptPayload({ ...d.subscription, auth: base64UrlEncode(new Uint8Array(3)) }, enc.encode('x')),
    ).rejects.toThrow(/16 bytes/)
  })
})

describe('vapidAuthorization (RFC 8292)', () => {
  it('signs a token for the push service origin that our public key verifies', async () => {
    const { pair, vapid } = await vapidKeys()
    const header = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', vapid, 1_000_000)
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)
    expect(match).not.toBeNull()
    const [, h, c, s, k] = match!
    expect(k).toBe(vapid.publicKey)
    expect(JSON.parse(dec.decode(base64UrlDecode(h!)))).toEqual({ typ: 'JWT', alg: 'ES256' })
    expect(JSON.parse(dec.decode(base64UrlDecode(c!)))).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: 1_000_000 + 12 * 3600,
      sub: 'mailto:ops@example.test',
    })
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pair.publicKey,
      buf(base64UrlDecode(s!)),
      buf(enc.encode(`${h}.${c}`)),
    )
    expect(valid).toBe(true)
  })

  it('refuses a public key that is not a P-256 point', async () => {
    const { vapid } = await vapidKeys()
    await expect(
      vapidAuthorization('https://x.test/1', { ...vapid, publicKey: base64UrlEncode(new Uint8Array(33)) }),
    ).rejects.toThrow(/VAPID_PUBLIC_KEY/)
  })
})

describe('classifyResponse', () => {
  it.each([
    [201, 'sent', undefined],
    [202, 'sent', undefined],
    [404, 'gone', undefined],
    [410, 'gone', undefined],
    [429, 'retry', 'provider_429'],
    [500, 'retry', 'provider_5xx'],
    [503, 'retry', 'provider_5xx'],
    [301, 'failed', 'unexpected_redirect'],
    [307, 'failed', 'unexpected_redirect'],
    [0, 'failed', 'unexpected_redirect'],
    [400, 'failed', 'provider_4xx'],
    [401, 'failed', 'invalid_vapid'],
    [403, 'failed', 'invalid_vapid'],
    [413, 'failed', 'payload_too_large'],
  ])('%i is %s (%s)', (status, outcome, errorCode) => {
    const result = classifyResponse(status, null)
    expect(result.outcome).toBe(outcome)
    expect('errorCode' in result ? result.errorCode : undefined).toBe(errorCode)
  })

  it('reads Retry-After seconds, and ignores anything that is not a plain number', () => {
    expect(classifyResponse(429, '120')).toMatchObject({ outcome: 'retry', retryAfterSeconds: 120 })
    expect(classifyResponse(503, 'Wed, 21 Oct 2026 07:28:00 GMT')).toMatchObject({ retryAfterSeconds: null })
  })
})

describe('sendPush', () => {
  it('posts an encrypted, signed request with a Topic, never following redirects', async () => {
    const d = await device()
    const { vapid } = await vapidKeys()
    const fetcher = vi.fn(async () => new Response(null, { status: 201 }))
    const result = await sendPush(d.subscription, '{"a":1}', vapid, { topic: 'abc', fetcher })
    expect(result).toEqual({ outcome: 'sent', status: 201 })

    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(d.subscription.endpoint)
    expect(init.redirect).toBe('manual')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    const headers = init.headers as Record<string, string>
    expect(headers['Content-Encoding']).toBe('aes128gcm')
    expect(headers['Topic']).toBe('abc')
    expect(headers['Authorization']).toMatch(/^vapid t=/)
    const opened = await decrypt(new Uint8Array(init.body as ArrayBuffer), d)
    expect(opened.text).toBe('{"a":1}')
  })

  it('treats a redirect as a failure and does not go where it points', async () => {
    const d = await device()
    const { vapid } = await vapidKeys()
    const fetcher = vi.fn(
      async () => new Response(null, { status: 307, headers: { Location: 'http://169.254.169.254/latest/meta-data/' } }),
    )
    const result = await sendPush(d.subscription, 'x', vapid, { fetcher })
    expect(result).toEqual({ outcome: 'failed', status: 307, errorCode: 'unexpected_redirect' })
    expect(fetcher).toHaveBeenCalledTimes(1)

    // What fetch hands back for `redirect: 'manual'` in a browser-like runtime.
    const opaque = vi.fn(async () => ({ type: 'opaqueredirect', status: 0, headers: new Headers(), body: null }))
    expect(await sendPush(d.subscription, 'x', vapid, { fetcher: opaque as unknown as typeof fetch })).toEqual({
      outcome: 'failed',
      status: null,
      errorCode: 'unexpected_redirect',
    })
  })

  it('aborts a request that never answers, and reports it as a retryable timeout', async () => {
    const d = await device()
    const { vapid } = await vapidKeys()
    let signal: AbortSignal | undefined
    // Honours the abort signal, as real fetch does.
    const hanging = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init?.signal ?? undefined
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
    const started = Date.now()
    const result = await sendPush(d.subscription, 'x', vapid, { fetcher: hanging as typeof fetch, timeoutMs: 50 })
    expect(result).toEqual({ outcome: 'retry', status: null, errorCode: 'network_timeout', retryAfterSeconds: null })
    expect(signal?.aborted).toBe(true)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('returns on time even when the fetch ignores its abort signal', async () => {
    const d = await device()
    const { vapid } = await vapidKeys()
    const deaf = vi.fn(() => new Promise<Response>(() => undefined))
    const result = await sendPush(d.subscription, 'x', vapid, { fetcher: deaf as typeof fetch, timeoutMs: 50 })
    expect(result).toMatchObject({ outcome: 'retry', errorCode: 'network_timeout' })
  })

  it('has a ten-second limit by default', () => {
    expect(PUSH_REQUEST_TIMEOUT_MS).toBe(10_000)
  })

  it('reports a network error as a category, keeping nothing of its text', async () => {
    const d = await device()
    const { vapid } = await vapidKeys()
    const offline = vi.fn(async () => {
      throw new TypeError(`fetch failed: connect ECONNREFUSED ${d.subscription.endpoint}`)
    })
    const result = await sendPush(d.subscription, 'x', vapid, { fetcher: offline })
    expect(result).toEqual({ outcome: 'retry', status: null, errorCode: 'network_error', retryAfterSeconds: null })
    expect(JSON.stringify(result)).not.toContain('googleapis')
  })

  it('keeps nothing of what the push service says back', async () => {
    const d = await device()
    const { vapid } = await vapidKeys()
    const fetcher = vi.fn(
      async () => new Response(`<html>Internal error for ${d.subscription.endpoint}</html>`, { status: 500 }),
    )
    const result = await sendPush(d.subscription, 'x', vapid, { fetcher })
    expect(result).toEqual({ outcome: 'retry', status: 500, errorCode: 'provider_5xx', retryAfterSeconds: null })
  })

  it.each([
    'http://fcm.googleapis.com/fcm/send/abcdefghijklmnopqrstuvwx',
    'https://127.0.0.1/fcm/send/abcdefghijklmnopqrstuvwx',
    'https://169.254.169.254/latest/meta-data/iam/security-credentials',
    'https://internal.service.local/fcm/send/abcdefghijklmnopqrstuvwx',
    'https://fcm.googleapis.com.evil.example/fcm/send/abcdefghijklmnopqrstuvwx',
  ])('refuses %s without making a request or signing anything', async (endpoint) => {
    const d = await device()
    const { vapid } = await vapidKeys()
    const fetcher = vi.fn()
    const result = await sendPush({ ...d.subscription, endpoint }, 'x', vapid, {
      fetcher: fetcher as unknown as typeof fetch,
    })
    expect(result).toEqual({ outcome: 'failed', status: null, errorCode: 'invalid_endpoint' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('fails a device whose stored keys are not keys, without sending', async () => {
    const d = await device()
    const { vapid } = await vapidKeys()
    const fetcher = vi.fn()
    const result = await sendPush({ ...d.subscription, p256dh: 'AAAA' }, 'x', vapid, {
      fetcher: fetcher as unknown as typeof fetch,
    })
    expect(result).toEqual({ outcome: 'failed', status: null, errorCode: 'invalid_subscription' })
    expect(fetcher).not.toHaveBeenCalled()
  })
})
