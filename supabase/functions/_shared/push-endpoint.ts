/**
 * Which push endpoints RecoverEase will send to.
 *
 * An endpoint comes from a browser, and the server then makes a signed
 * request to it - so a made-up endpoint would turn the server into a way to
 * reach other hosts (SSRF). The first release supports Chrome on Android,
 * whose subscriptions are issued by Firebase Cloud Messaging in one of two
 * forms (Chromium, components/push_messaging/push_messaging_constants.cc):
 *
 *   https://fcm.googleapis.com/fcm/send/<token>
 *   https://fcm.googleapis.com/wp/<token>
 *
 * Only those are allowed: that exact host over https on the default port,
 * no user, query or fragment, and a token of the characters FCM uses. An IP
 * address, localhost, an internal name, another Google host, a look-alike
 * (`fcm.googleapis.com.evil.example`, `fcm.googleapis.com.`, `evil@fcm...`),
 * an explicit port or http are all refused, because none of them is that
 * exact string. The host is a fixed public name, so there is no DNS answer
 * of the user's choosing to resolve.
 *
 * The same rule is in the database (`app_private.push_endpoint_is_allowed`,
 * migration 53), checked when a device registers and when a delivery is
 * claimed; this is the check immediately before the request is made.
 * `src/features/push/push-device.ts` repeats it to explain an unsupported
 * browser before asking the server. tests/unit/push-endpoint.test.ts keeps
 * the three in step.
 */

export const PUSH_ENDPOINT_PATTERN = /^https:\/\/fcm\.googleapis\.com\/(fcm\/send|wp)\/[A-Za-z0-9_:-]{16,}$/

export const PUSH_ENDPOINT_MAX_LENGTH = 1024

export function isAllowedPushEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length > PUSH_ENDPOINT_MAX_LENGTH) return false
  if (!PUSH_ENDPOINT_PATTERN.test(endpoint)) return false

  // Belt and braces: what the URL parser will actually connect to must be
  // the same thing the pattern accepted.
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return false
  }
  return (
    url.href === endpoint &&
    url.protocol === 'https:' &&
    url.hostname === 'fcm.googleapis.com' &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    url.hash === ''
  )
}
