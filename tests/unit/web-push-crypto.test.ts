import { describe, expect, it, vi } from 'vitest'

import {
  base64UrlDecode,
  base64UrlEncode,
  classifyResponse,
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
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
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
    [201, 'sent'],
    [202, 'sent'],
    [404, 'gone'],
    [410, 'gone'],
    [429, 'retry'],
    [500, 'retry'],
    [503, 'retry'],
    [400, 'failed'],
    [403, 'failed'],
    [413, 'failed'],
  ])('%i is %s', (status, outcome) => {
    expect(classifyResponse(status, null, '').outcome).toBe(outcome)
  })

  it('reads Retry-After seconds', () => {
    const result = classifyResponse(429, '120', 'slow down')
    expect(result).toMatchObject({ outcome: 'retry', retryAfterSeconds: 120 })
  })
})

describe('sendPush', () => {
  it('posts an encrypted, signed request with a Topic, and reports a network error as retryable', async () => {
    const d = await device()
    const { vapid } = await vapidKeys()
    const fetcher = vi.fn(async () => new Response(null, { status: 201 }))
    const result = await sendPush(d.subscription, '{"a":1}', vapid, { topic: 'abc', fetcher })
    expect(result).toEqual({ outcome: 'sent', status: 201 })

    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(d.subscription.endpoint)
    const headers = init.headers as Record<string, string>
    expect(headers['Content-Encoding']).toBe('aes128gcm')
    expect(headers['Topic']).toBe('abc')
    expect(headers['Authorization']).toMatch(/^vapid t=/)
    const opened = await decrypt(new Uint8Array(init.body as ArrayBuffer), d)
    expect(opened.text).toBe('{"a":1}')

    const offline = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    expect((await sendPush(d.subscription, 'x', vapid, { fetcher: offline })).outcome).toBe('retry')
  })

  it('refuses a non-https endpoint without sending', async () => {
    const d = await device()
    const { vapid } = await vapidKeys()
    const fetcher = vi.fn()
    const result = await sendPush({ ...d.subscription, endpoint: 'http://x.test/1' }, 'x', vapid, {
      fetcher: fetcher as unknown as typeof fetch,
    })
    expect(result.outcome).toBe('failed')
    expect(fetcher).not.toHaveBeenCalled()
  })
})
