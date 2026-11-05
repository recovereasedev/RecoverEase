/**
 * Refuses to serve a local preview build that could talk to a real
 * Supabase project.
 *
 * Run between building the Super Admin preview and serving it
 * (playwright.preview.config.ts). It fails when the build contains any real
 * Supabase project address - `https://<20-character ref>.supabase.co` - or
 * when the preview's own unreachable address is missing, which would mean
 * the build picked up some other configuration.
 *
 *   node --experimental-strip-types scripts/check-preview-build.ts <outDir> <expected Supabase URL>
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const REAL_PROJECT_URL = /https:\/\/[a-z0-9]{20}\.supabase\.(co|in)\b/g
const TEXT_FILE = /\.(js|mjs|css|html|json|webmanifest|txt|map)$/

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? filesUnder(path) : Promise.resolve([path])
    }),
  )
  return nested.flat()
}

const [outDir, expectedUrl] = process.argv.slice(2)
if (!outDir || !expectedUrl) {
  console.error('usage: check-preview-build.ts <outDir> <expected Supabase URL>')
  process.exit(2)
}

const expectedHost = new URL(expectedUrl).host
if (!expectedHost.endsWith('.invalid')) {
  console.error(`The preview must be built against an .invalid address, not ${expectedHost}.`)
  process.exit(1)
}

const files = (await filesUnder(outDir)).filter((file) => TEXT_FILE.test(file))
const realAddresses = new Set<string>()
let mentionsExpected = false

for (const file of files) {
  const text = await readFile(file, 'utf8')
  for (const match of text.matchAll(REAL_PROJECT_URL)) realAddresses.add(match[0])
  if (text.includes(expectedHost)) mentionsExpected = true
}

if (realAddresses.size > 0) {
  console.error(
    `Refusing to serve the preview: the build contains ${realAddresses.size} real Supabase project address(es).`,
  )
  process.exit(1)
}

if (!mentionsExpected) {
  console.error(`Refusing to serve the preview: the build does not use ${expectedHost}.`)
  process.exit(1)
}

console.log(
  `Preview build checked: ${files.length} files, no real Supabase project address, Supabase URL is ${expectedHost}.`,
)
