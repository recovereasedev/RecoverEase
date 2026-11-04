import { defineConfig, devices } from '@playwright/test'

import {
  PREVIEW_ORIGIN,
  PREVIEW_OUT_DIR,
  PREVIEW_PORT,
  PREVIEW_PUBLISHABLE_KEY,
  PREVIEW_SUPABASE_URL,
  type PreviewState,
} from './e2e/preview/preview-env'

/**
 * A local-only preview of the Super Admin console, for looking at it and
 * clicking through it before any real Super Admin exists.
 *
 *   npm run preview:super-admin                       every state, in turn
 *   npm run preview:super-admin -- --project=console  just the console
 *
 * Nothing here reaches production, three ways over:
 *
 *  - The website is built for this preview alone, into its own folder, with
 *    a Supabase address on `.invalid` - a domain that cannot exist - and no
 *    key. scripts/check-preview-build.ts refuses to serve it if any real
 *    Supabase project address is in it.
 *  - Every Supabase request is answered in the browser by the E2E stub
 *    (e2e/support), the same one the browser tests use, with an in-memory
 *    platform behind it. The signed-in Super Admin, their authenticator and
 *    their session exist only in that stub.
 *  - A network guard aborts any request that is not to this local server or
 *    the stub's address (e2e/preview/super-admin.preview.ts).
 *
 * The website's own build (`npm run build`, which Vercel runs) never sees
 * any of it: the mock lives under e2e/, which nothing in src/ imports.
 *
 * Set PREVIEW_SMOKE=1 to run it headless and have it click through each
 * state by itself, as a check that the preview still works.
 */
const smoke = process.env['PREVIEW_SMOKE'] === '1'

export default defineConfig<{ previewState: PreviewState }>({
  testDir: './e2e/preview',
  testMatch: /\.preview\.ts$/,
  // Waits for you to close the window; the smoke run sets its own limit.
  timeout: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],

  use: {
    ...devices['Desktop Chrome'],
    baseURL: PREVIEW_ORIGIN,
    headless: smoke,
    serviceWorkers: 'block',
    // `vite preview` sends production's Content-Security-Policy (vercel.json),
    // whose connect-src allows only *.supabase.co, so the browser would refuse
    // the preview's .invalid address before the stub could answer it. That
    // policy is not what keeps the preview off production - it allows every
    // *.supabase.co project, production's included - the network guard is.
    bypassCSP: true,
    trace: 'off',
  },

  projects: [
    // A new Super Admin: set up an authenticator, then the console.
    { name: 'enrol', use: { previewState: 'enrol' } },
    // A later sign-in: enter the code, then the console.
    { name: 'verify', use: { previewState: 'verify' } },
    // Already verified this session: straight to the console.
    { name: 'console', use: { previewState: 'console' } },
  ],

  webServer: {
    command: [
      `npx vite build --outDir ${PREVIEW_OUT_DIR} --emptyOutDir`,
      `node --experimental-strip-types scripts/check-preview-build.ts ${PREVIEW_OUT_DIR} ${PREVIEW_SUPABASE_URL}`,
      `npx vite preview --outDir ${PREVIEW_OUT_DIR} --host 127.0.0.1 --port ${PREVIEW_PORT} --strictPort`,
    ].join(' && '),
    url: PREVIEW_ORIGIN,
    // Always built afresh for the preview: a server already on this port may
    // have been built with some other configuration.
    reuseExistingServer: false,
    timeout: 180_000,
    // Set here, they override anything in .env files for this build only.
    env: {
      VITE_SUPABASE_URL: PREVIEW_SUPABASE_URL,
      VITE_SUPABASE_PUBLISHABLE_KEY: PREVIEW_PUBLISHABLE_KEY,
    },
  },
})
