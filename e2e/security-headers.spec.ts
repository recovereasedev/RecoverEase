import { fileURLToPath } from 'node:url'

import { expect, test } from '@playwright/test'

import { headersFor, readHeaderRules } from '../scripts/vercel-headers'

/**
 * The browser suite is served with the headers `vercel.json` gives
 * production (`scripts/vercel-headers.ts`), so every spec runs under the
 * Content-Security-Policy the site is served with. Checked here against what
 * the preview server actually sends - a page, a deep link, the static files
 * and a built asset - so a server started without them, or a rule it stopped
 * applying, fails here rather than letting the suite pass under no policy.
 */

const rules = readHeaderRules(fileURLToPath(new URL('../vercel.json', import.meta.url)))

test('the preview server sends production’s headers on every kind of path', async ({ request }) => {
  const index = await (await request.get('/')).text()
  const asset = index.match(/\/assets\/[^"']+\.js/)?.[0]
  expect(asset, 'a built script named in index.html').toBeTruthy()

  for (const path of ['/', '/patient/medications', '/doctor/patients/p-1', '/offline.html', '/sw.js', asset!]) {
    const response = await request.get(path)
    expect(response.status(), path).toBe(200)
    const served = response.headers()
    const expected = headersFor(rules, path)
    expect(expected.length, path).toBeGreaterThan(0)
    for (const [key, value] of expected) {
      expect(served[key.toLowerCase()], `${key} on ${path}`).toBe(value)
    }
  }
})
