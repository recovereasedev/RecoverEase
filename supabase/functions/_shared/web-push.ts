/**
 * Web Push, by the standards, with WebCrypto only (no library).
 *
 *   - RFC 8291: the message is encrypted to the device's own key, so the
 *     push service (Google's, for Android Chrome) carries it without being
 *     able to read it. Content coding `aes128gcm` (RFC 8188), one record.
 *   - RFC 8292 (VAPID): every request is signed with this deployment's key
 *     pair, so the push service accepts it only from us, and a device that
 *     subscribed with our public key receives only our messages.
 *
 * Runs unchanged in Deno (the Edge Function) and Node (the unit tests): both
 * have `crypto.subtle`, `fetch` and `btoa`/`atob`.
 */

export type PushSubscriptionKeys = {
  endpoint: string
  /** The device's P-256 public key, base64url (65 bytes uncompressed). */
  p256dh: string
  /** The device's 16-byte auth secret, base64url. */
  auth: string
}

export type VapidKeys = {
  /** base64url, 65-byte uncompressed P-256 point - the browser's applicationServerKey. */
  publicKey: string
  /** base64url, the 32-byte private scalar. */
  privateKey: string
  /** `mailto:` or `https:` contact the push service may use about abuse. */
  subject: string
}

const encoder = new TextEncoder()

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64UrlDecode(text: string): Uint8Array {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** WebCrypto wants an ArrayBuffer-backed view; copying gives exactly that. */
const buf = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) {
  const key = await crypto.subtle.importKey('raw', buf(ikm), 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: buf(info) },
    key,
    length * 8,
  )
  return new Uint8Array(bits)
}

/** The device's public key as an ECDH key. */
function importDeviceKey(raw: Uint8Array) {
  return crypto.subtle.importKey('raw', buf(raw), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
}

/**
 * Encrypts `plaintext` for one device (RFC 8291 section 3.4).
 * `ephemeral` and `salt` are for tests only; production always draws new ones.
 */
export async function encryptPayload(
  subscription: PushSubscriptionKeys,
  plaintext: Uint8Array,
  options: { ephemeral?: CryptoKeyPair; salt?: Uint8Array } = {},
): Promise<Uint8Array> {
  const deviceKeyBytes = base64UrlDecode(subscription.p256dh)
  const authSecret = base64UrlDecode(subscription.auth)
  if (deviceKeyBytes.length !== 65 || deviceKeyBytes[0] !== 4) {
    throw new Error('The device key is not an uncompressed P-256 point.')
  }
  if (authSecret.length !== 16) throw new Error('The device auth secret is not 16 bytes.')

  const ephemeral =
    options.ephemeral ??
    ((await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
      'deriveBits',
    ])) as CryptoKeyPair)
  const serverPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey))
  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16))

  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: await importDeviceKey(deviceKeyBytes) },
      ephemeral.privateKey,
      256,
    ),
  )

  const keyInfo = concat(encoder.encode('WebPush: info\0'), deviceKeyBytes, serverPublic)
  const ikm = await hkdf(authSecret, sharedSecret, keyInfo, 32)
  const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12)

  // One record: the plaintext, then the 0x02 "last record" delimiter.
  const record = concat(plaintext, new Uint8Array([2]))
  const aesKey = await crypto.subtle.importKey('raw', buf(cek), 'AES-GCM', false, ['encrypt'])
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(nonce) }, aesKey, buf(record)),
  )

  // Header: salt (16) | record size (4, big-endian) | key id length (1) | key id.
  const recordSize = 4096
  const header = new Uint8Array(16 + 4 + 1)
  header.set(salt, 0)
  new DataView(header.buffer).setUint32(16, recordSize)
  header[20] = serverPublic.length
  return concat(header, serverPublic, ciphertext)
}

/** The VAPID `Authorization` header for one push service origin (RFC 8292). */
export async function vapidAuthorization(
  endpoint: string,
  vapid: VapidKeys,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const publicBytes = base64UrlDecode(vapid.publicKey)
  if (publicBytes.length !== 65 || publicBytes[0] !== 4) {
    throw new Error('VAPID_PUBLIC_KEY is not an uncompressed P-256 public key.')
  }
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: base64UrlEncode(publicBytes.slice(1, 33)),
    y: base64UrlEncode(publicBytes.slice(33, 65)),
    d: vapid.privateKey,
    ext: false,
  }
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
  ])

  const header = base64UrlEncode(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = base64UrlEncode(
    encoder.encode(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        // 12 hours: inside the 24-hour maximum the RFC allows.
        exp: nowSeconds + 12 * 60 * 60,
        sub: vapid.subject,
      }),
    ),
  )
  const unsigned = `${header}.${claims}`
  // WebCrypto's ECDSA signature is already r||s, the form JWS (ES256) uses.
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, buf(encoder.encode(unsigned))),
  )
  return `vapid t=${unsigned}.${base64UrlEncode(signature)}, k=${vapid.publicKey}`
}

export type PushResult =
  | { outcome: 'sent'; status: number }
  | { outcome: 'gone'; status: number }
  | { outcome: 'retry'; status: number | null; error: string; retryAfterSeconds: number | null }
  | { outcome: 'failed'; status: number; error: string }

/**
 * What a push service's answer means for the queue:
 *   2xx           delivered to the push service;
 *   404, 410      the subscription no longer exists - forget the device;
 *   429, 5xx      try again later (Retry-After honoured);
 *   anything else (400 bad request, 401/403 VAPID refused, 413 too large)
 *                 retrying the same request cannot help.
 */
export function classifyResponse(status: number, retryAfter: string | null, body: string): PushResult {
  if (status >= 200 && status < 300) return { outcome: 'sent', status }
  if (status === 404 || status === 410) return { outcome: 'gone', status }
  const error = `push service answered ${status}${body ? `: ${body.slice(0, 200)}` : ''}`
  if (status === 429 || status >= 500) {
    const seconds = retryAfter !== null && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) : null
    return { outcome: 'retry', status, error, retryAfterSeconds: seconds }
  }
  return { outcome: 'failed', status, error }
}

/** Sends one encrypted message. Network errors are retryable. */
export async function sendPush(
  subscription: PushSubscriptionKeys,
  payload: string,
  vapid: VapidKeys,
  options: { topic?: string; ttlSeconds?: number; fetcher?: typeof fetch } = {},
): Promise<PushResult> {
  const endpoint = new URL(subscription.endpoint)
  if (endpoint.protocol !== 'https:') {
    return { outcome: 'failed', status: 0, error: 'endpoint is not https' }
  }
  const body = await encryptPayload(subscription, encoder.encode(payload))
  const headers: Record<string, string> = {
    Authorization: await vapidAuthorization(subscription.endpoint, vapid),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(options.ttlSeconds ?? 60 * 60),
    Urgency: 'high',
  }
  // A Topic replaces an undelivered message with the same topic at the push
  // service: if a retry follows a send that did get through, the phone still
  // shows it once.
  if (options.topic) headers['Topic'] = options.topic

  try {
    const response = await (options.fetcher ?? fetch)(subscription.endpoint, {
      method: 'POST',
      headers,
      body: buf(body),
    })
    const text = response.ok ? '' : await response.text().catch(() => '')
    return classifyResponse(response.status, response.headers.get('Retry-After'), text)
  } catch (error) {
    return {
      outcome: 'retry',
      status: null,
      error: `network error: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300),
      retryAfterSeconds: null,
    }
  }
}
