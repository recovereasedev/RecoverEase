import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * The dark theme's colours, checked from src/index.css itself (the 2nd-half
 * plan, section 8). Change a token and this says whether every pairing the
 * application uses still clears WCAG AA - 4.5:1 for text, 3:1 for icons -
 * in both themes. The rendered screens are checked as well, by axe in a real
 * browser (`e2e/contrast-audit.spec.ts`); this is the check that runs
 * without one, and covers the states axe does not see, such as a hovered
 * button's translucent tint.
 */

const css = readFileSync(join(process.cwd(), 'src/index.css'), 'utf8')

function tokens(block: string): Record<string, string> {
  return Object.fromEntries(
    [...block.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1]!, m[2]!.toLowerCase()]),
  )
}

function blockAfter(selector: string): string {
  const start = css.indexOf(selector)
  if (start < 0) throw new Error(`no ${selector} in index.css`)
  const open = css.indexOf('{', start)
  return css.slice(open + 1, css.indexOf('}', open))
}

const themeStart = css.indexOf('@theme {')
const LIGHT = tokens(css.slice(themeStart, css.indexOf('\n}\n', themeStart)))
const DARK = tokens(blockAfter(":root[data-theme='dark'] {"))
const PAPER = tokens(blockAfter(":root[data-theme='dark'] [data-theme-scope='light'] {"))

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** `fg` at `alpha` over `bg`, as the browser composites it. */
function over(fg: string, alpha: number, bg: string): string {
  return (
    '#' +
    [1, 3, 5]
      .map((i) => {
        const value = Math.round(alpha * parseInt(fg.slice(i, i + 2), 16) + (1 - alpha) * parseInt(bg.slice(i, i + 2), 16))
        return value.toString(16).padStart(2, '0')
      })
      .join('')
  )
}

const SURFACES = ['canvas', 'surface', 'surface-sunken', 'surface-raised'] as const
const FAMILIES = ['brand', 'accent', 'success', 'warning', 'danger', 'info'] as const

describe('the dark theme’s tokens', () => {
  it('redefine only tokens the light theme has, and paper puts every one back exactly', () => {
    expect(Object.keys(DARK).length).toBeGreaterThan(80)
    for (const name of Object.keys(DARK)) {
      expect(LIGHT[name], name).toBeDefined()
      expect(PAPER[name], name).toBe(LIGHT[name])
    }
  })

  it('keep every text step readable on every surface', () => {
    const text = [
      'heading',
      'body',
      'muted',
      'neutral-600',
      'neutral-700',
      'neutral-800',
      ...FAMILIES.flatMap((family) => [600, 700, 800].map((step) => `${family}-${step}`)),
    ]
    for (const step of text) {
      for (const surface of SURFACES) {
        expect(contrast(DARK[step]!, DARK[surface]!), `${step} on ${surface}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('keep status and brand text readable on their own tints', () => {
    for (const family of FAMILIES) {
      for (const step of [600, 700, 800]) {
        for (const tint of [50, 100]) {
          expect(
            contrast(DARK[`${family}-${step}`]!, DARK[`${family}-${tint}`]!),
            `${family}-${step} on ${family}-${tint}`,
          ).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
    for (const step of ['heading', 'body', 'muted']) {
      for (const tint of ['neutral-100', 'neutral-200']) {
        expect(contrast(DARK[step]!, DARK[tint]!), `${step} on ${tint}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('keep icons at 3:1', () => {
    for (const surface of SURFACES) {
      expect(contrast(DARK['neutral-500']!, DARK[surface]!)).toBeGreaterThanOrEqual(3)
    }
  })

  it('keep white text readable on every fill, in both themes', () => {
    for (const [theme, values] of [['light', LIGHT], ['dark', DARK]] as const) {
      for (const [name, value] of Object.entries(values).filter(([name]) => name.startsWith('fill-'))) {
        expect(contrast('#ffffff', value), `${theme}: white on ${name}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('keep the chat header and the patient’s bubble readable in every state, in both themes', () => {
    for (const [theme, values] of [['light', LIGHT], ['dark', DARK]] as const) {
      const header = values['fill-brand-deep']!
      // Its buttons at rest, hovered and pressed: white over a white tint.
      for (const alpha of [0.1, 0.15, 0.2, 0.25]) {
        expect(contrast('#ffffff', over('#ffffff', alpha, header)), `${theme}: header white/${alpha}`).toBeGreaterThanOrEqual(4.5)
      }
      expect(contrast(values['on-fill-soft']!, header), `${theme}: header status line`).toBeGreaterThanOrEqual(4.5)
      // The time under a message in the patient's own bubble.
      for (const alpha of [0.7, 0.8]) {
        const bubble = values['fill-brand-600']!
        expect(contrast(over('#ffffff', alpha, bubble), bubble), `${theme}: bubble white/${alpha}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('are for the screen only: printing keeps the light theme', () => {
    const block = css.indexOf(":root[data-theme='dark'] {")
    expect(css.lastIndexOf('@media screen {', block)).toBeGreaterThan(-1)
    expect(css.slice(css.lastIndexOf('@media screen {', block), block)).not.toContain('}')
  })

  it('show which theme is chosen at 3:1 against its track and its pill, in both themes', () => {
    // The pill alone is about 1.1:1 against the track; the ring carries it.
    const control = readFileSync(join(process.cwd(), 'src/components/layout/theme-control.tsx'), 'utf8')
    expect(control).toContain('ring-[var(--color-brand-600)]')
    for (const [theme, values] of [['light', LIGHT], ['dark', { ...LIGHT, ...DARK }]] as const) {
      for (const behind of ['surface-sunken', 'surface']) {
        expect(contrast(values['brand-600']!, values[behind]!), `${theme}: ring on ${behind}`).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('keep the brand mark’s white cross and pulse readable, in both themes', () => {
    const brand = readFileSync(join(process.cwd(), 'src/components/layout/brand.tsx'), 'utf8')
    const stops = [...brand.matchAll(/stopColor="var\(--color-([a-z0-9-]+)\)"/g)].map((m) => m[1]!)
    expect(stops).toEqual(['fill-brand-800', 'fill-accent-600'])
    for (const [theme, values] of [['light', LIGHT], ['dark', { ...LIGHT, ...DARK }]] as const) {
      for (const stop of stops) {
        expect(contrast('#ffffff', values[stop]!), `${theme}: white on ${stop}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('reach every floating layer: no shadow utility that bakes in the light value', () => {
    // Tailwind copies a theme shadow into the utility at build time, so a bare
    // `shadow-lg` keeps the light shadow in the dark theme; the token form
    // `shadow-[var(--shadow-lg)]` follows it.
    const bare: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (/\.tsx?$/.test(entry.name)) {
          const found = readFileSync(path, 'utf8').match(/(?<![\w-[])shadow-(?:2xs|xs|sm|md|lg|xl|2xl)\b/g)
          if (found) bare.push(`${path}: ${found.join(', ')}`)
        }
      }
    }
    walk(join(process.cwd(), 'src'))
    expect(bare).toEqual([])
  })
})

/**
 * The approved design (RecoverEase-Dashboard-Redesign.pdf). Its named
 * colours are pinned here so a token cannot drift from the document; the
 * steps between them are derived, and only their contrast is pinned.
 */
describe('the official palette', () => {
  it('uses the design’s light values', () => {
    const official: Record<string, string> = {
      'brand-600': '#2563eb', // primary blue
      'brand-700': '#1d4fc4', // blue dark: links, pressed
      'accent-500': '#14b8a6', // teal accent: shapes only
      'accent-600': '#0f766e', // teal text
      'brand-50': '#e8f0fd', // soft blue
      'surface-raised': '#e8f0fd',
      'accent-50': '#e3f6f3', // soft teal
      heading: '#0f2747', // ink
      body: '#0f2747',
      muted: '#4b5f7a',
      canvas: '#f5f8fc', // page
      surface: '#ffffff', // cards are white
      border: '#dde6f0', // line
      'warning-700': '#8a4b0a', // amber
      'warning-50': '#fdf1e3',
      'danger-700': '#8f2a17', // alert: emergencies only
      'danger-50': '#fbe9e5',
    }
    for (const [name, value] of Object.entries(official)) expect(LIGHT[name], name).toBe(value)
  })

  it('uses the design’s dark values', () => {
    const official: Record<string, string> = {
      canvas: '#0b1220', // page
      surface: '#121c2e',
      'surface-raised': '#16264a', // soft blue
      'brand-50': '#16264a',
      'brand-600': '#6b9bff', // primary
      'accent-600': '#3ccfbc', // teal
      heading: '#e8eef8', // ink
      body: '#e8eef8',
      muted: '#a3b3cc',
      border: '#243452', // line
    }
    for (const [name, value] of Object.entries(official)) expect(DARK[name], name).toBe(value)
  })

  it('has no green: success is teal, in both themes', () => {
    for (const [theme, values] of [['light', LIGHT], ['dark', DARK]] as const) {
      for (const step of [50, 100, 200, 600, 700, 800]) {
        expect(values[`success-${step}`], `${theme}: success-${step}`).toBe(values[`accent-${step}`])
      }
      expect(values['fill-success-600'], `${theme}: fill-success-600`).toBe(values['fill-accent-600'])
    }
  })

  it('gives patients and clinicians the blue accent, and administrators slate', () => {
    for (const role of ['patient', 'doctor']) {
      expect(blockAfter(`[data-role='${role}'] {`), role).toContain('--color-role: var(--color-brand-700)')
    }
    expect(blockAfter("[data-role='super_admin'] {")).toContain('--color-role: var(--color-neutral-800)')
  })

  it('keeps the logo gradient as tokens, for shapes', () => {
    expect([LIGHT['gradient-from'], LIGHT['gradient-via'], LIGHT['gradient-to']]).toEqual(['#2563eb', '#1b8fcb', '#14b8a6'])
  })

  it('puts white text only on a gradient it clears 4.5:1 along, in both themes', () => {
    // `.brand-gradient` carries text (the sign-in panel, the landing page's
    // closing band); the logo gradient's teal end is 2.49:1 under white.
    const stops = [...blockAfter('.brand-gradient {').matchAll(/var\(--color-([a-z0-9-]+)\)/g)].map((m) => m[1]!)
    expect(stops.length).toBeGreaterThanOrEqual(2)
    for (const [theme, values] of [['light', LIGHT], ['dark', { ...LIGHT, ...DARK }]] as const) {
      for (let i = 0; i < stops.length - 1; i++) {
        // Whole steps, so the far stop itself (t = 1) is always sampled.
        for (let step = 0; step <= 20; step++) {
          const t = step / 20
          const colour = over(values[stops[i + 1]!]!, t, values[stops[i]!]!)
          expect(contrast('#ffffff', colour), `${theme}: white at ${t.toFixed(2)} of ${stops[i]}-${stops[i + 1]}`).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })
})

describe('the light theme’s tokens', () => {
  it('keep every text step readable on every surface', () => {
    const text = [
      'heading',
      'body',
      'muted',
      'neutral-600',
      'neutral-700',
      'neutral-800',
      ...FAMILIES.flatMap((family) => [600, 700, 800].map((step) => `${family}-${step}`)),
    ]
    for (const step of text) {
      for (const surface of SURFACES) {
        expect(contrast(LIGHT[step]!, LIGHT[surface]!), `${step} on ${surface}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('keep status and brand text readable on their own tints', () => {
    // The 600 step is the design's own colour (primary blue, teal text) and
    // the 50 tint is its own soft fill; on the deeper 100 tint, text is the
    // 700 or 800 step.
    for (const family of FAMILIES) {
      for (const [step, tint] of [[600, 50], [700, 50], [800, 50], [700, 100], [800, 100]] as const) {
        expect(
          contrast(LIGHT[`${family}-${step}`]!, LIGHT[`${family}-${tint}`]!),
          `${family}-${step} on ${family}-${tint}`,
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
    for (const step of ['heading', 'body', 'muted']) {
      for (const tint of ['neutral-100', 'neutral-200']) {
        expect(contrast(LIGHT[step]!, LIGHT[tint]!), `${step} on ${tint}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('keep icons at 3:1', () => {
    for (const surface of SURFACES) {
      expect(contrast(LIGHT['neutral-500']!, LIGHT[surface]!)).toBeGreaterThanOrEqual(3)
    }
  })
})

describe('type', () => {
  const value = (name: string) => css.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]?.trim()

  it('is Figtree, bundled with the application', () => {
    expect(css).toContain("@import '@fontsource-variable/figtree';")
    expect(value('font-sans')).toMatch(/^'Figtree Variable', 'Figtree',/)
    expect(css).not.toMatch(/\bInter\b/)
  })

  it('sets the design’s four sizes', () => {
    // Page title 36/700, section title 22/700, body 17, helper 15.
    expect(value('text-title')).toBe('2.25rem')
    expect(value('text-title--font-weight')).toBe('700')
    expect(value('text-headline-md')).toBe('1.375rem')
    expect(value('text-headline-md--font-weight')).toBe('700')
    expect(value('text-base')).toBe('1.0625rem')
    expect(value('text-body-md')).toBe('1.0625rem')
    expect(value('text-sm')).toBe('0.9375rem')
    expect(value('text-body-sm')).toBe('0.9375rem')
  })
})
