import { readFileSync } from 'node:fs'

import type { Plugin } from 'vite'

/**
 * The response headers `vercel.json` gives each path, served by `vite
 * preview` too.
 *
 * Production's security headers - the Content-Security-Policy above all -
 * are added by Vercel, so a build served without them is tested under a
 * policy it never meets there: Print's PDF frame was blocked in production
 * while every browser test passed (`src/lib/documents/print.ts`). The
 * preview server reads the same file Vercel does, so the two cannot drift
 * apart, and a `source` it cannot match exactly as Vercel would stops the
 * server rather than being skipped (`e2e/security-headers.spec.ts` checks
 * what it serves).
 */

export type HeaderRule = {
  source: string
  headers: { key: string; value: string }[]
}

/**
 * A `source` as a regular expression. Vercel's patterns allow far more; this
 * reproduces only what `vercel.json` uses - literal path text and `(.*)` -
 * and refuses anything else.
 */
export function sourcePattern(source: string): RegExp {
  const pieces = source.split('(.*)')
  if (!source.startsWith('/') || pieces.some((piece) => !/^[A-Za-z0-9/_.-]*$/.test(piece))) {
    throw new Error(`vercel.json: the preview server cannot match the source "${source}" as Vercel does`)
  }
  return new RegExp(`^${pieces.map((piece) => piece.replaceAll('.', '\\.')).join('.*')}$`)
}

/** The `headers` rules of a `vercel.json`, each source checked. */
export function readHeaderRules(file: string): HeaderRule[] {
  const config = JSON.parse(readFileSync(file, 'utf8')) as { headers?: HeaderRule[] }
  const rules = config.headers ?? []
  for (const rule of rules) sourcePattern(rule.source)
  return rules
}

/** The headers a path is served with: every matching rule, a later one winning a name. */
export function headersFor(rules: readonly HeaderRule[], pathname: string): [string, string][] {
  const headers = new Map<string, [string, string]>()
  for (const rule of rules) {
    if (!sourcePattern(rule.source).test(pathname)) continue
    for (const { key, value } of rule.headers) headers.set(key.toLowerCase(), [key, value])
  }
  return [...headers.values()]
}

/** `vite preview` sends `file`'s headers; the dev server and the build are untouched. */
export function vercelHeaders(file: string): Plugin {
  return {
    name: 'recoverease:vercel-headers',
    configurePreviewServer(server) {
      const rules = readHeaderRules(file)
      server.middlewares.use((request, response, next) => {
        const { pathname } = new URL(request.url ?? '/', 'http://preview.invalid')
        for (const [key, value] of headersFor(rules, pathname)) response.setHeader(key, value)
        next()
      })
    },
  }
}
