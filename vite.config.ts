import { fileURLToPath, URL } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    // Surface accidental bundle bloat rather than silently shipping it.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        /**
         * Split the large, slow-moving dependencies into their own chunks.
         *
         * Without this, Rollup folds them into whichever shared chunk it
         * happens to name first, so a one-line change to a component
         * invalidates the cached copy of Supabase for every returning user.
         * Pinning them by package keeps those chunks stable across deploys.
         */
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined

          // Only dependencies that are genuinely needed at boot are named
          // here. Grouping a lazy-only dependency has the opposite of the
          // intended effect: naming a chunk pins it into the entry's preload
          // graph, so it is fetched before first paint even though nothing on
          // the first screen uses it.
          //
          // Measured: adding Zod and React Hook Form to a `forms` chunk moved
          // 31 kB gzipped from the sign-in route onto the landing page. They
          // are deliberately left unnamed so they load with the auth pages.
          //
          // Order matters below: `react-router` also contains the substring
          // "react", so the specific packages are matched first.
          if (id.includes('@supabase')) return 'supabase'
          if (id.includes('react-router')) return 'router'
          if (id.includes('@tanstack')) return 'query'
          if (id.includes('date-fns')) return 'dates'
          if (id.includes('lucide-react')) return 'icons'
          if (id.includes('/react-dom/') || id.includes('/react/')) {
            return 'react'
          }

          return undefined
        },
      },
    },
  },
})
