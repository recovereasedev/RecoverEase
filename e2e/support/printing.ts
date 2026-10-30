import { pdfLines } from '../../tests/unit/support/pdf-text'

import { expect, type Page } from './fixtures'

/**
 * Stands in, before the app loads, for the one thing a test cannot drive -
 * the print dialog - and records the document Print hands on. The browser
 * is made to take the tab route (`@/lib/documents/print`), whose tab
 * receives the PDF's object URL; the blob behind that URL is kept so the
 * test can read the printed PDF's bytes.
 */
export async function capturePrinting(page: Page) {
  await page.addInitScript(() => {
    const blobs = new Map<string, Blob>()
    const create = URL.createObjectURL.bind(URL)
    URL.createObjectURL = (blob: Blob) => {
      const url = create(blob)
      blobs.set(url, blob)
      return url
    }
    Object.defineProperty(Navigator.prototype, 'pdfViewerEnabled', { get: () => false })
    const printed: string[] = []
    Object.assign(window, { __printed: printed, __printedBlobs: blobs })
    window.open = () =>
      ({
        opener: null,
        closed: false,
        close() {},
        location: {
          set href(url: string) {
            printed.push(url)
          },
        },
      }) as unknown as Window
  })
}

/** Presses Print and returns the bytes of the PDF it opened for printing. */
export async function printFrom(page: Page, name: string): Promise<Uint8Array> {
  await page.getByRole('button', { name, exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __printed: string[] }).__printed.length)).toBe(1)
  const bytes = await page.evaluate(async () => {
    const w = window as unknown as { __printed: string[]; __printedBlobs: Map<string, Blob> }
    const blob = w.__printedBlobs.get(w.__printed[0]!)!
    return [...new Uint8Array(await blob.arrayBuffer())]
  })
  return new Uint8Array(bytes)
}

/** A document's text without its footer, whose time is the moment it was built. */
export const bodyOf = async (bytes: Uint8Array) =>
  (await pdfLines(bytes)).filter((line) => !/^RecoverEase .+ · Generated /.test(line))
