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
