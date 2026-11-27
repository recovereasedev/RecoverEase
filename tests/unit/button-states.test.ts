import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { buttonVariants } from '@/components/ui/button'

/**
 * Phase 2B: pressing on a filled control makes it deeper, never lighter.
 * A button that brightens under the pointer looks as if it had gone weaker,
 * or switched off. Read against the light theme's fill tokens; the dark
 * theme keeps the same fills (theme-tokens.test.ts).
 */

const css = readFileSync(join(process.cwd(), 'src/index.css'), 'utf8')
// The light values: the first declaration of each token in the file.
const fill = (token: string): string => {
  const match = css.match(new RegExp(`--color-${token}:\\s*(#[0-9a-fA-F]{6})`))
  if (!match?.[1]) throw new Error(`no colour for --color-${token}`)
  return match[1]
}

const luminance = (hex: string): number => {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}

const fillOf = (classes: string, prefix: '' | 'hover:' | 'active:') =>
  classes
    .split(/\s+/)
    .find((c) => c.startsWith(`${prefix}bg-fill-`))
    ?.slice(`${prefix}bg-`.length)

describe('the shared button', () => {
  it.each(['primary', 'accent', 'danger'] as const)(
    '%s goes deeper on hover, and deeper again when pressed',
    (variant) => {
      const classes = buttonVariants({ variant })
      const rest = fillOf(classes, '')
      const hover = fillOf(classes, 'hover:')
      const active = fillOf(classes, 'active:')
      expect(rest && hover && active, classes).toBeTruthy()
      expect(luminance(fill(hover!))).toBeLessThan(luminance(fill(rest!)))
      expect(luminance(fill(active!))).toBeLessThan(luminance(fill(hover!)))
    },
  )
})

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return path.endsWith('.tsx') ? [path] : []
  })
}

describe('every class list in the app', () => {
  it('never makes a filled control lighter on hover', () => {
    const lighter: string[] = []
    for (const file of sourceFiles(join(process.cwd(), 'src'))) {
      for (const literal of readFileSync(file, 'utf8').match(/(["'`])[^"'`\n]*bg-fill-[^"'`\n]*\1/g) ?? []) {
        const rest = fillOf(literal.slice(1, -1), '')
        const hover = fillOf(literal.slice(1, -1), 'hover:')
        if (rest && hover && luminance(fill(hover)) > luminance(fill(rest))) {
          lighter.push(`${file.slice(process.cwd().length + 1)}: ${rest} -> ${hover}`)
        }
      }
    }
    expect(lighter).toEqual([])
  })
})
