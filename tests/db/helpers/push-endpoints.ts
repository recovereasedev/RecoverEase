/**
 * Push endpoints that must be accepted, and ones that must be refused, by
 * every copy of the allow-list: the Edge Function and the browser
 * (tests/unit/push-endpoint.test.ts) and the database
 * (tests/db/web-push.test.ts).
 */

export const ALLOWED_ENDPOINTS = [
  // The two forms Chromium issues (push_messaging_constants.cc).
  'https://fcm.googleapis.com/fcm/send/dA1b2C3d4E5:APA91bHun4MxP5egoKMwt2KZFBaFUH-1RYqx',
  'https://fcm.googleapis.com/wp/dA1b2C3d4E5:APA91bHun4MxP5egoKMwt2KZFBaFUH-1RYqx_abc',
  'https://fcm.googleapis.com/fcm/send/abcdefghijklmnop',
]

export const REFUSED_ENDPOINTS = [
  // Not https.
  'http://fcm.googleapis.com/fcm/send/abcdefghijklmnopqrstuvwx',
  // Private, loopback, link-local and internal destinations.
  'https://127.0.0.1/fcm/send/abcdefghijklmnopqrstuvwx',
  'https://localhost/fcm/send/abcdefghijklmnopqrstuvwx',
  'https://10.0.0.5/fcm/send/abcdefghijklmnopqrstuvwx',
  'https://192.168.1.10/fcm/send/abcdefghijklmnopqrstuvwx',
  'https://169.254.169.254/latest/meta-data/iam/security-credentials',
  'https://[::1]/fcm/send/abcdefghijklmnopqrstuvwx',
  'https://[fd00::1]/fcm/send/abcdefghijklmnopqrstuvwx',
  'https://2130706433/fcm/send/abcdefghijklmnopqrstuvwx',
  'https://0x7f000001/fcm/send/abcdefghijklmnopqrstuvwx',
  'https://kubernetes.default.svc/fcm/send/abcdefghijklmnopqrstuvwx',
  'https://db.internal/fcm/send/abcdefghijklmnopqrstuvwx',
  // Hostname tricks.
  'https://fcm.googleapis.com.evil.example/fcm/send/abcdefghijklmnopqrstuvwx',
  'https://fcm.googleapis.com./fcm/send/abcdefghijklmnopqrstuvwx',
  'https://evilfcm.googleapis.com/fcm/send/abcdefghijklmnopqrstuvwx',
  'https://fcm.googleapis.com@evil.example/fcm/send/abcdefghijklmnopqrstuvwx',
  'https://user:pass@fcm.googleapis.com/fcm/send/abcdefghijklmnopqrstuvwx',
  'https://FCM.GOOGLEAPIS.COM/fcm/send/abcdefghijklmnopqrstuvwx',
  'https://fcm.googleapis.com\\@evil.example/fcm/send/abcdefghijklmnopqrstuvwx',
  'https://fcm.googleapis.com%2eevil.example/fcm/send/abcdefghijklmnopqrstuvwx',
  'https://fcm.googleapis.com．evil.example/fcm/send/abcdefghijklmnopqrstuvwx',
  // Other Google hosts are not the push service.
  'https://www.googleapis.com/fcm/send/abcdefghijklmnopqrstuvwx',
  'https://storage.googleapis.com/fcm/send/abcdefghijklmnopqrstuvwx',
  // Ports, queries, fragments, other paths, traversal.
  'https://fcm.googleapis.com:8443/fcm/send/abcdefghijklmnopqrstuvwx',
  'https://fcm.googleapis.com:443/fcm/send/abcdefghijklmnopqrstuvwx',
  'https://fcm.googleapis.com/fcm/send/abcdefghijklmnopqrstuvwx?next=https://evil.example',
  'https://fcm.googleapis.com/fcm/send/abcdefghijklmnopqrstuvwx#x',
  'https://fcm.googleapis.com/v1/projects/x/messages:send',
  'https://fcm.googleapis.com/fcm/send/../../v1/projects/abcdefghijklmnop',
  'https://fcm.googleapis.com/fcm/send/abc%2F..%2Fdefghijklmnopqrstu',
  'https://fcm.googleapis.com/fcm/send/short',
  'https://fcm.googleapis.com/fcm/send/',
  // Other browsers' services: not supported in this release.
  'https://updates.push.services.mozilla.com/wpush/v2/abcdefghijklmnopqrstuvwx',
  'https://web.push.apple.com/abcdefghijklmnopqrstuvwx',
  // Malformed.
  ' https://fcm.googleapis.com/fcm/send/abcdefghijklmnopqrstuvwx',
  'https://fcm.googleapis.com/fcm/send/abcdefghijklmnopqrstuvwx\nHost: evil.example',
  'javascript:alert(1)',
  'not a url',
  '',
  `https://fcm.googleapis.com/fcm/send/${'a'.repeat(1100)}`,
]
