import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  PREVIEW_OUT_DIR,
  PREVIEW_SUPABASE_URL,
} from '../../e2e/preview/preview-env'

/**
 * The local Super Admin preview (playwright.preview.config.ts) must never
 * become part of the website, and must never reach a real Supabase project.
 *
 * The mock - the E2E stub, its in-memory platform, a signed-in Super Admin
 * and a passing authenticator code - lives under e2e/. These tests hold the
 * lines that keep it there: nothing the website is built from imports it;
 * the deployed build is unchanged; the preview is built against an address
 * that cannot exist; and its build is refused if any real project address
 * gets in.
 */

const ROOT = process.cwd()

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx|js|jsx|css|html)$/.test(entry.name) ? [path] : []
  })
}

describe('the website never contains the preview', () => {
  it('imports nothing from e2e/, the stub, or the preview', () => {
    const offenders = sourceFiles(resolve(ROOT, 'src')).filter((file) => {
      const text = readFileSync(file, 'utf8')
      return (
        /from\s+['"][^'"]*\be2e\//.test(text) ||
        /supabase-stub|platform-preview|preview-env|super-admin\.preview/.test(text) ||
        text.includes(new URL(PREVIEW_SUPABASE_URL).host)
      )
    })
    expect(offenders).toEqual([])
  })

  it('leaves the deployed build exactly as it was', () => {
    const vercel = JSON.parse(readFileSync(resolve(ROOT, 'vercel.json'), 'utf8')) as {
      buildCommand: string
      outputDirectory: string
    }
    const scripts = (
      JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>
      }
    ).scripts

    expect(vercel.buildCommand).toBe('npm run build')
    expect(vercel.outputDirectory).toBe('dist')
    expect(scripts['build']).toBe('tsc -b && vite build')
    expect(PREVIEW_OUT_DIR).not.toBe('dist')
    expect(readFileSync(resolve(ROOT, '.gitignore'), 'utf8')).toContain(`${PREVIEW_OUT_DIR}/`)
  })

  it('is not one of the browser tests, so `npm run test:e2e` never opens it', () => {
    // Playwright's default test file pattern, which playwright.config.ts uses.
    const defaultTestMatch = /\.(test|spec)\.[cm]?[jt]sx?$/
    expect(readdirSync(resolve(ROOT, 'e2e/preview')).filter((name) => defaultTestMatch.test(name))).toEqual([])
    expect(readFileSync(resolve(ROOT, 'playwright.config.ts'), 'utf8')).not.toMatch(/preview\//)
  })
})

describe('the preview cannot reach a real Supabase project', () => {
  it('is built against an address on .invalid, a domain that cannot exist', () => {
    expect(new URL(PREVIEW_SUPABASE_URL).hostname.endsWith('.invalid')).toBe(true)
  })

  it('checks its build before serving it, and serves on this machine only', () => {
    const config = readFileSync(resolve(ROOT, 'playwright.preview.config.ts'), 'utf8')
    expect(config).toMatch(/check-preview-build\.ts \$\{PREVIEW_OUT_DIR\} \$\{PREVIEW_SUPABASE_URL\}/)
    expect(config).toMatch(/vite preview --outDir \$\{PREVIEW_OUT_DIR\} --host 127\.0\.0\.1/)
    expect(config).toMatch(/VITE_SUPABASE_URL: PREVIEW_SUPABASE_URL/)
    expect(config).toMatch(/reuseExistingServer: false/)
  })

  describe('scripts/check-preview-build.ts', () => {
    const made: string[] = []
    afterEach(() => {
      for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true })
    })

    function check(files: Record<string, string>, expected = PREVIEW_SUPABASE_URL) {
      const directory = mkdtempSync(join(tmpdir(), 'preview-build-'))
      made.push(directory)
      for (const [name, text] of Object.entries(files)) writeFileSync(join(directory, name), text)
      try {
        const output = execFileSync(
          process.execPath,
          ['--experimental-strip-types', resolve(ROOT, 'scripts/check-preview-build.ts'), directory, expected],
          { encoding: 'utf8', stdio: 'pipe' },
        )
        return { passed: true, output }
      } catch (error) {
        return { passed: false, output: String((error as { stderr?: string }).stderr ?? '') }
      }
    }

    it('passes a build that uses only the preview address', () => {
      expect(check({ 'index.js': `createClient("${PREVIEW_SUPABASE_URL}","x")` }).passed).toBe(true)
    })

    it('refuses a build containing any real Supabase project address', () => {
      const result = check({
        'index.js': `createClient("${PREVIEW_SUPABASE_URL}","x")`,
        'chunk.js': 'fetch("https://abcdefghijklmnopqrst.supabase.co/rest/v1/")',
      })
      expect(result.passed).toBe(false)
      expect(result.output).toMatch(/real Supabase project address/)
    })

    it('refuses a build that is not using the preview address at all', () => {
      expect(check({ 'index.js': 'createClient("https://example.test","x")' }).passed).toBe(false)
    })

    it('refuses to vouch for any address that is not on .invalid', () => {
      const result = check({ 'index.js': 'https://staging.example.com' }, 'https://staging.example.com')
      expect(result.passed).toBe(false)
      expect(result.output).toMatch(/\.invalid/)
    })
  })
})
