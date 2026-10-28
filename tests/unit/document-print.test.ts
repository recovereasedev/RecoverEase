import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { openPrintTab, printFile, printRoute } from '@/lib/documents/print'
import { useDocumentFile } from '@/lib/documents/use-document-file'

import { captureDownloads } from './support/capture-download'

/**
 * Print prints the document, not the page (`@/lib/documents/print`). Which
 * way it can do that depends on the browser, so the choice is pinned here
 * for each kind; what each route does is pinned below, as far as jsdom can
 * follow it. A real browser's print dialog is beyond any test.
 */

const CHROME_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const EDGE_DESKTOP = `${CHROME_DESKTOP} Edg/130.0.0.0`
const FIREFOX_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0'
const SAFARI_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'

const FILE = {
  bytes: new TextEncoder().encode('%PDF-1.7 test'),
  fileName: 'recoverease-prescription-maria-reyes-2026-10-29.pdf',
  mimeType: 'application/pdf',
}

afterEach(() => {
  vi.restoreAllMocks()
  document.querySelectorAll('iframe').forEach((frame) => frame.remove())
})

describe('which way a browser prints a document', () => {
  it.each([
    ['Chrome on a desktop', CHROME_DESKTOP, 0],
    ['Edge on a desktop', EDGE_DESKTOP, 0],
    ['Firefox on a desktop', FIREFOX_DESKTOP, 0],
  ])('%s prints it from a hidden frame', (_, userAgent, maxTouchPoints) => {
    expect(printRoute({ pdfViewerEnabled: true, userAgent, maxTouchPoints })).toBe('frame')
  })

  it.each([
    ['Safari on a Mac', SAFARI_MAC, 0],
    ['an iPhone', IPHONE, 5],
    ['an iPad asking for the desktop site', SAFARI_MAC, 5],
    ['Chrome on Android', ANDROID_CHROME, 5],
  ])('%s opens it in a tab instead', (_, userAgent, maxTouchPoints) => {
    expect(printRoute({ pdfViewerEnabled: true, userAgent, maxTouchPoints })).toBe('tab')
  })

  it('opens it in a tab wherever the browser has no PDF viewer of its own', () => {
    expect(printRoute({ pdfViewerEnabled: false, userAgent: CHROME_DESKTOP, maxTouchPoints: 0 })).toBe('tab')
    expect(printRoute({ pdfViewerEnabled: undefined, userAgent: CHROME_DESKTOP, maxTouchPoints: 0 })).toBe('tab')
  })
})

describe('printing from a hidden frame', () => {
  it('loads the PDF itself into a hidden frame and opens the print dialog for it', async () => {
    const capture = captureDownloads()
    try {
      const printed = printFile(FILE, 'frame', null)
      const frame = document.querySelector('iframe')!
      expect(frame).not.toBeNull()
      expect(frame.getAttribute('aria-hidden')).toBe('true')
      expect(frame.src).toMatch(/^blob:/)
      const print = vi.fn()
      Object.defineProperty(frame, 'contentWindow', {
        value: { focus: vi.fn(), print },
        configurable: true,
      })
      frame.dispatchEvent(new Event('load'))

      await expect(printed).resolves.toBe('printed')
      expect(print).toHaveBeenCalledTimes(1)
      // Printed, not saved.
      expect(capture.files).toHaveLength(0)
    } finally {
      capture.release()
    }
  })

  it('hands the reader the file when the frame will not print', async () => {
    const capture = captureDownloads()
    try {
      const printed = printFile(FILE, 'frame', null)
      const frame = document.querySelector('iframe')!
      Object.defineProperty(frame, 'contentWindow', {
        value: {
          focus: vi.fn(),
          print: () => {
            throw new Error('Blocked')
          },
        },
        configurable: true,
      })
      frame.dispatchEvent(new Event('load'))

      await expect(printed).resolves.toBe('downloaded')
      expect(capture.files.map((file) => file.name)).toEqual([FILE.fileName])
    } finally {
      capture.release()
    }
  })

  it('keeps one frame at a time', async () => {
    const capture = captureDownloads()
    try {
      void printFile(FILE, 'frame', null)
      void printFile(FILE, 'frame', null)
      expect(document.querySelectorAll('iframe')).toHaveLength(1)
    } finally {
      capture.release()
    }
  })
})

describe('printing through a tab', () => {
  it('opens a blank tab synchronously, cut off from the page that opened it', () => {
    const tab = { opener: 'the app', closed: false } as unknown as Window
    vi.spyOn(window, 'open').mockReturnValue(tab)

    expect(openPrintTab('tab')).toBe(tab)
    expect(window.open).toHaveBeenCalledWith('', '_blank')
    expect(tab.opener).toBeNull()
    // The frame route needs no tab at all.
    expect(openPrintTab('frame')).toBeNull()
    expect(window.open).toHaveBeenCalledTimes(1)
  })

  it('shows the PDF in that tab', async () => {
    const capture = captureDownloads()
    try {
      const tab = { closed: false, location: { href: 'about:blank' } } as unknown as Window
      await expect(printFile(FILE, 'tab', tab)).resolves.toBe('opened')
      expect(tab.location.href).toMatch(/^blob:/)
      expect(capture.files).toHaveLength(0)
    } finally {
      capture.release()
    }
  })

  it('downloads the PDF when the browser refused the tab', async () => {
    const capture = captureDownloads()
    try {
      await expect(printFile(FILE, 'tab', null)).resolves.toBe('downloaded')
      expect(capture.files.map((file) => file.name)).toEqual([FILE.fileName])
    } finally {
      capture.release()
    }
  })
})

describe('Download and Print together', () => {
  it('opens the tab before the document is built, and closes it if the build fails', async () => {
    // jsdom has no PDF viewer, so it takes the tab route.
    const order: string[] = []
    const tab = { opener: null, closed: false, close: vi.fn(), location: { href: '' } }
    vi.spyOn(window, 'open').mockImplementation(() => {
      order.push('tab opened')
      return tab as unknown as Window
    })
    const { result } = renderHook(() => useDocumentFile())

    await act(async () => {
      await result.current.print(async () => {
        order.push('document built')
        throw new Error('Out of memory')
      })
    })

    expect(order).toEqual(['tab opened', 'document built'])
    expect(tab.close).toHaveBeenCalledTimes(1)
    expect(result.current.error?.action).toBe('print')
    expect(result.current.pending).toBeNull()
  })

  it('reports where a printed document went, and which action failed', async () => {
    const capture = captureDownloads()
    try {
      vi.spyOn(window, 'open').mockReturnValue(null)
      const { result } = renderHook(() => useDocumentFile())

      await act(async () => {
        await result.current.print(async () => FILE)
      })
      expect(result.current.printOutcome).toBe('downloaded')

      await act(async () => {
        await result.current.download(async () => {
          throw new Error('No space')
        })
      })
      expect(result.current.error?.action).toBe('download')
      expect(result.current.printOutcome).toBeNull()
    } finally {
      capture.release()
    }
  })
})
