import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * RecoverEase as an installable app (QA 9/12, "Integrate PWA"): the manifest,
 * its icons, the page head that points at them, and the offline page. The
 * colours and icons are the existing brand's, not new ones.
 */

const file = (path: string) => join(process.cwd(), path)
const read = (path: string) => readFileSync(file(path))

const manifestText = read('public/manifest.webmanifest').toString('utf8')
const manifest = JSON.parse(manifestText) as {
  [key: string]: unknown
  icons: { src: string; sizes: string; type: string; purpose: string }[]
}

/** Width and height from a PNG's header, after checking it is one. */
function pngSize(path: string) {
  const bytes = read(path)
  expect(bytes.subarray(0, 8).toString('hex'), `${path} is a PNG`).toBe('89504e470d0a1a0a')
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

const KNOWN_MEMBERS = [
  'id',
  'name',
  'short_name',
  'description',
  'lang',
  'start_url',
  'scope',
  'display',
  'background_color',
  'theme_color',
  'icons',
]

describe('the web app manifest', () => {
  it('names RecoverEase', () => {
    expect(manifest.name).toBe('RecoverEase')
    expect(manifest.short_name).toBe('RecoverEase')
    expect(manifest.description).toMatch(/recovery management platform/)
  })

  it('opens RecoverEase as a standalone app, from and within its root', () => {
    expect(manifest).toMatchObject({
      id: '/',
      start_url: '/',
      scope: '/',
      display: 'standalone',
    })
  })

  it('takes its colours from the existing design tokens', () => {
    const css = read('src/index.css').toString('utf8')

    expect(manifest.theme_color).toBe('#004269')
    expect(css).toContain('--color-brand-800: #004269')
    expect(manifest.background_color).toBe('#f9f9ff')
    expect(css).toContain('--color-canvas: #f9f9ff')
  })

  it('declares only known members, each once', () => {
    expect(Object.keys(manifest).sort()).toEqual([...KNOWN_MEMBERS].sort())
    for (const key of KNOWN_MEMBERS) {
      const occurrences = manifestText.split(`"${key}":`).length - 1
      expect(occurrences, key).toBe(1)
    }
  })

  it('has the icons browsers need to install it, at the sizes it claims', () => {
    const byPurpose = (purpose: string, sizes: string) =>
      manifest.icons.find((icon) => icon.purpose === purpose && icon.sizes === sizes)

    expect(byPurpose('any', '192x192')).toBeDefined()
    expect(byPurpose('any', '512x512')).toBeDefined()
    expect(byPurpose('maskable', '512x512')).toBeDefined()

    for (const icon of manifest.icons) {
      const path = `public${icon.src}`
      expect(existsSync(file(path)), path).toBe(true)
      expect(icon.type).toBe('image/png')
      const [width, height] = icon.sizes.split('x').map(Number)
      expect(pngSize(path)).toEqual({ width, height })
    }
  })
})

describe('the page head', () => {
  const html = read('index.html').toString('utf8')

  it('links the manifest', () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />')
  })

  it('sets the same theme colour as the manifest', () => {
    expect(html).toContain(`<meta name="theme-color" content="${manifest.theme_color}" />`)
  })

  it('gives iOS a home-screen icon at its size', () => {
    expect(html).toContain('<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />')
    expect(pngSize('public/icons/apple-touch-icon.png')).toEqual({ width: 180, height: 180 })
  })

  it('keeps the existing favicon', () => {
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />')
  })
})

describe('the offline page', () => {
  const page = read('public/offline.html').toString('utf8')

  it('says plainly that care information needs a connection', () => {
    expect(page).toContain('<h1>You are offline</h1>')
    expect(page).toMatch(/needs an internet connection to show your care information/)
    expect(page).toContain('<a href="/">Try again</a>')
  })

  it('runs no script and loads nothing from anywhere', () => {
    // The site's CSP allows no inline script, and offline there is no network.
    expect(page).not.toMatch(/<script/i)
    expect(page).not.toMatch(/(src|href)="https?:/i)
    expect(page).not.toMatch(/url\(\s*['"]?https?:/i)
  })
})
