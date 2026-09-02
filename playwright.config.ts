import { defineConfig, devices } from '@playwright/test'

const PORT = 4173
const BASE_URL = `http://localhost:${PORT}`

/**
 * Browser tests run against a production build served by `vite preview`, not
 * the dev server. The dev server transforms modules on demand and serves
 * unminified code with different chunking; testing it would leave the artefact
 * that actually ships unexercised — including the lazy route chunks, which are
 * where a code-splitting mistake shows up.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? 'list' : [['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'] },
      // responsive.spec.ts asserts the small-screen layout; running it at
      // desktop width would fail on a bottom bar that is correctly absent.
      testIgnore: /responsive\.spec\.ts/,
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'] },
      testMatch: /responsive\.spec\.ts/,
    },
  ],

  webServer: {
    command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env['CI'],
    timeout: 180_000,
    // Supplied here rather than from .env.local so the suite runs in CI, where
    // no local env file exists. Both are placeholders: every Supabase request
    // is intercepted before it leaves the browser.
    env: {
      VITE_SUPABASE_URL: 'https://stub.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'stub-publishable-key',
    },
  },
})
