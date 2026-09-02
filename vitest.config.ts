import { fileURLToPath, URL } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

/**
 * Two very different kinds of test live in this repo, so they are split into
 * separate Vitest projects rather than sharing one environment:
 *
 *   unit - React component, hook and pure-function behaviour, in jsdom.
 *   db   - SQL schema, constraint and Row Level Security policy behaviour,
 *          executed against a real Postgres running in-process via PGlite.
 *          These need the node environment and a far longer boot budget.
 *
 * Run everything with `npm test`, or one project with `npm run test:db`.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.d.ts',
        'src/main.tsx',
        'src/types/database.types.ts',
      ],
    },
    // Playwright drives e2e/ in a real browser; Vitest must not pick those up.
    exclude: ['**/node_modules/**', '**/dist/**', 'e2e/**'],
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'jsdom',
          setupFiles: ['./tests/setup.ts'],
          include: [
            'tests/unit/**/*.test.{ts,tsx}',
            'src/**/*.test.{ts,tsx}',
          ],
          // `src/lib/env.ts` validates configuration at import time and throws
          // when it is missing — deliberately, so a misconfigured deployment
          // fails loudly at startup rather than at the first sign-in. Tests
          // import modules that sit downstream of it, so they need values.
          //
          // These are obvious placeholders pointing nowhere. No test makes a
          // network call: everything either exercises pure functions or
          // renders components with data supplied directly.
          env: {
            VITE_SUPABASE_URL: 'http://localhost:54321',
            VITE_SUPABASE_PUBLISHABLE_KEY: 'test-publishable-key',
          },
        },
      },
      {
        extends: true,
        test: {
          name: 'db',
          environment: 'node',
          include: ['tests/db/**/*.test.ts'],
          // PGlite compiles and boots a WASM Postgres per suite, then replays
          // every migration into it. That is slow but it is real Postgres.
          testTimeout: 60_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
})
