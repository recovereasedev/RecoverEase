import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Every Edge Function deploys with the import map it needs.
 *
 * `supabase functions deploy` (CLI 2.121) reads a function's import map from
 * that function's own folder - `deno.json`, `deno.jsonc`, then
 * `import_map.json` - or from `config.toml`, and never from
 * `supabase/functions/deno.json`. A bare import that only the root file maps
 * is left unresolved, and the bundle fails with `Relative import path "zod"
 * not prefixed with /, ./, or ../`: how `chatbot-reply` first failed to
 * deploy. The root file stays for editors and local Deno tooling, so the two
 * copies must not drift.
 *
 * Read from the files rather than run through a bundler: there is no Deno or
 * Docker here, and the rule is about which files exist and what they map.
 */

const FUNCTIONS = join(process.cwd(), 'supabase/functions')

const functionNames = readdirSync(FUNCTIONS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
  .map((entry) => entry.name)

function importsOf(denoJson: string): Record<string, string> {
  if (!existsSync(denoJson)) return {}
  return (JSON.parse(readFileSync(denoJson, 'utf8')).imports ?? {}) as Record<string, string>
}

/** `jsr:`, `npm:`, `node:`, `https:` and the like resolve without a map. */
const hasScheme = (specifier: string) => /^[a-z][a-z0-9+.-]*:/i.test(specifier)
const isRelative = (specifier: string) => specifier.startsWith('.') || specifier.startsWith('/')

/**
 * Module specifiers only: `import … from`, `export … from`, `import '…'` and
 * `import('…')` - not `.from('chat_message')` and other calls.
 */
const SPECIFIERS = [
  /^\s*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/gm,
  /^\s*import\s*['"]([^'"]+)['"]/gm,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
]

/** The bare specifiers a function's module graph imports, `_shared` included. */
function bareImports(entrypoint: string): string[] {
  const bare = new Set<string>()
  const seen = new Set<string>()
  const visit = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    const source = readFileSync(file, 'utf8')
    for (const pattern of SPECIFIERS) {
      for (const [, specifier] of source.matchAll(pattern)) {
        if (isRelative(specifier!)) visit(resolve(dirname(file), specifier!))
        else if (!hasScheme(specifier!)) bare.add(specifier!)
      }
    }
  }
  visit(entrypoint)
  return [...bare].sort()
}

function isMapped(specifier: string, imports: Record<string, string>): boolean {
  return Object.keys(imports).some(
    (key) => key === specifier || (key.endsWith('/') && specifier.startsWith(key)),
  )
}

describe('Edge Function import maps', () => {
  it('finds the functions', () => {
    expect(functionNames).toEqual(
      expect.arrayContaining([
        'chatbot-reply',
        'complete-password-setup',
        'create-account',
        'reset-account-password',
      ]),
    )
  })

  it.each(functionNames)('%s maps every bare import in its own deno.json', (name) => {
    const own = importsOf(join(FUNCTIONS, name, 'deno.json'))
    const unmapped = bareImports(join(FUNCTIONS, name, 'index.ts')).filter(
      (specifier) => !isMapped(specifier, own),
    )
    expect(unmapped).toEqual([])
  })

  it('chatbot-reply imports zod by name and pins it to one exact version', () => {
    expect(bareImports(join(FUNCTIONS, 'chatbot-reply/index.ts'))).toContain('zod')
    expect(importsOf(join(FUNCTIONS, 'chatbot-reply/deno.json')).zod).toMatch(
      /^npm:zod@\d+\.\d+\.\d+$/,
    )
  })

  it('keeps the root copy and chatbot-reply’s own in step', () => {
    expect(importsOf(join(FUNCTIONS, 'chatbot-reply/deno.json'))).toEqual(
      importsOf(join(FUNCTIONS, 'deno.json')),
    )
  })
})
