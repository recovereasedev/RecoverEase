import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { headersFor, readHeaderRules, sourcePattern } from '../../scripts/vercel-headers'

/**
 * The browser tests are served with production's headers, read from
 * `vercel.json` itself (`scripts/vercel-headers.ts`). Pinned here: that every
 * rule in the file is one the preview server reproduces, that it gives each
 * path what Vercel would, and that the policy still lets Print frame the PDF
 * it builds without loosening anything else.
 */

const FILE = join(process.cwd(), 'vercel.json')
const config = JSON.parse(readFileSync(FILE, 'utf8')) as {
  headers: { source: string; headers: { key: string; value: string }[] }[]
}
const rules = readHeaderRules(FILE)
const everyPath = config.headers.find((rule) => rule.source === '/(.*)')!

/** A Content-Security-Policy as each directive's sources. */
function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy
      .split(';')
      .map((part) => part.trim().split(/\s+/))
      .filter(([name]) => name)
      .map(([name, ...sources]) => [name!, sources]),
  )
}

describe('the headers vercel.json gives production, in the preview server', () => {
  it('reproduces every rule in the file', () => {
    expect(rules).toHaveLength(config.headers.length)
    for (const rule of config.headers) expect(() => sourcePattern(rule.source), rule.source).not.toThrow()
  })

  it('gives a page the headers of every path, and nothing else', () => {
    for (const path of ['/', '/patient/medications', '/doctor/patients/p-1', '/offline.html']) {
      expect(headersFor(rules, path), path).toEqual(everyPath.headers.map(({ key, value }) => [key, value]))
    }
  })

  it('adds the long-lived caching to a built asset only', () => {
    const asset = new Map(headersFor(rules, '/assets/index-Bx12.js'))
    expect(asset.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
    expect(asset.get('Content-Security-Policy')).toBe(
      everyPath.headers.find(({ key }) => key === 'Content-Security-Policy')!.value,
    )
    expect(new Map(headersFor(rules, '/assets')).has('Cache-Control')).toBe(false)
  })

  it('refuses a source it cannot match as Vercel does, rather than skipping it', () => {
    for (const source of ['/:path*', '/(a|b)', '/docs/(.+)', 'assets/(.*)']) {
      expect(() => sourcePattern(source), source).toThrow(/cannot match/)
    }
  })
})

describe('the Content-Security-Policy', () => {
  const policy = directives(everyPath.headers.find(({ key }) => key === 'Content-Security-Policy')!.value)

  it('lets Print load the PDF it built into its hidden frame, and nothing more', () => {
    // `src/lib/documents/print.ts`: the frame's address is the PDF's blob: URL.
    expect(policy.get('frame-src')).toEqual(["'self'", 'blob:'])
  })

  it('keeps every other restriction', () => {
    expect(policy.get('default-src')).toEqual(["'self'"])
    expect(policy.get('script-src')).toEqual(["'self'"])
    expect(policy.get('object-src')).toEqual(["'none'"])
    expect(policy.get('frame-ancestors')).toEqual(["'none'"])
    expect(policy.get('base-uri')).toEqual(["'self'"])
    expect(policy.get('form-action')).toEqual(["'self'"])
    expect(policy.get('connect-src')).toEqual(["'self'", 'https://*.supabase.co', 'wss://*.supabase.co'])
    expect(policy.get('img-src')).toEqual(["'self'", 'data:'])
  })
})
