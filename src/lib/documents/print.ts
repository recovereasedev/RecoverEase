import { type DownloadableFile, saveFile } from '@/lib/documents/download'

/**
 * Printing a document RecoverEase builds - the prescription, the treatment
 * plan - prints that document: the same PDF the Download button saves, never
 * the web page around it. One layout, one builder, so the paper and the file
 * cannot differ.
 *
 * Browsers differ in how a page may print a PDF it made:
 *
 * - **frame** - a desktop browser that shows PDFs itself (Chrome, Edge,
 *   Firefox) loads the PDF into a hidden frame and opens its print dialog
 *   straight away.
 * - **tab** - a phone, a tablet, Safari, or any browser without its own PDF
 *   viewer, cannot print a PDF from inside a page reliably. The PDF opens in
 *   a new tab instead, where the system's own Print or Share is one tap away.
 *   That tab has to be opened while the click is still being handled, or the
 *   browser blocks it as a pop-up, so the route is chosen before the PDF is
 *   built. If the tab is blocked all the same, the PDF is downloaded, so the
 *   reader still has it.
 */

export type PrintRoute = 'frame' | 'tab'

/** What happened: the print dialog opened, the PDF opened in a tab, or it was downloaded. */
export type PrintOutcome = 'printed' | 'opened' | 'downloaded'

export type PrintEnvironment = {
  pdfViewerEnabled: boolean | undefined
  userAgent: string
  maxTouchPoints: number
}

export function currentPrintEnvironment(): PrintEnvironment {
  return {
    pdfViewerEnabled: navigator.pdfViewerEnabled,
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
  }
}

/** Which way this browser can print a PDF built on the page. */
export function printRoute(env: PrintEnvironment): PrintRoute {
  const ua = env.userAgent
  if (env.pdfViewerEnabled !== true) return 'tab'
  // iPhone, iPad and iPod - and an iPad asking for the desktop site, which
  // calls itself a Mac but has a touch screen.
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && env.maxTouchPoints > 1)) {
    return 'tab'
  }
  if (/Android|Mobile/.test(ua)) return 'tab'
  // Safari on a Mac shows PDFs, but printing one from a frame prints a blank
  // page or the page around it. Chrome, Edge and Firefox also say "Safari".
  if (/Safari\//.test(ua) && !/Chrome\/|Chromium\/|Edg\/|Firefox\/|OPR\//.test(ua)) {
    return 'tab'
  }
  return 'frame'
}

function objectUrl({ bytes, mimeType }: DownloadableFile): string {
  // A copy into a plain ArrayBuffer: Blob will not take a view whose buffer
  // could be shared.
  return URL.createObjectURL(new Blob([bytes.slice().buffer], { type: mimeType }))
}

// The frame (or tab) and object URL of the last print, kept until the next
// one: a print dialog reads the PDF for as long as it is open, so neither
// can be released when `print()` returns.
let previous: { frame: HTMLIFrameElement | null; url: string } | null = null

function releasePrevious() {
  if (!previous) return
  previous.frame?.remove()
  URL.revokeObjectURL(previous.url)
  previous = null
}

// A PDF that has not loaded in this long never will.
const FRAME_LOAD_TIMEOUT_MS = 15_000

/** Loads the PDF into a hidden frame and opens the print dialog for it. */
function printInFrame(file: DownloadableFile): Promise<PrintOutcome> {
  releasePrevious()
  const url = objectUrl(file)
  const frame = document.createElement('iframe')
  frame.title = 'Document being printed'
  frame.setAttribute('aria-hidden', 'true')
  frame.tabIndex = -1
  // Rendered but out of sight: a frame that is not rendered at all
  // (display: none) never loads its PDF in some browsers.
  frame.style.cssText =
    'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none'
  previous = { frame, url }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('The document could not be prepared for printing.'))
    }, FRAME_LOAD_TIMEOUT_MS)
    frame.addEventListener(
      'load',
      () => {
        clearTimeout(timer)
        try {
          const view = frame.contentWindow
          if (!view) throw new Error('The document could not be prepared for printing.')
          view.focus()
          view.print()
          resolve('printed')
        } catch {
          // The frame would not print: the reader gets the file instead.
          saveFile(file)
          resolve('downloaded')
        }
      },
      { once: true },
    )
    frame.src = url
    document.body.append(frame)
  })
}

/**
 * Opens a blank tab for the PDF, synchronously, while the click is still
 * being handled. `null` where the route needs no tab, or the browser
 * refused one.
 */
export function openPrintTab(route: PrintRoute): Window | null {
  if (route !== 'tab') return null
  const tab = window.open('', '_blank')
  if (tab) tab.opener = null
  return tab
}

/**
 * Prints the built document by `route`. For the tab route, `tab` is what
 * `openPrintTab` returned before the document was built.
 */
export function printFile(
  file: DownloadableFile,
  route: PrintRoute,
  tab: Window | null,
): Promise<PrintOutcome> {
  if (route === 'frame') return printInFrame(file)

  if (!tab || tab.closed) {
    saveFile(file)
    return Promise.resolve('downloaded')
  }
  releasePrevious()
  const url = objectUrl(file)
  previous = { frame: null, url }
  tab.location.href = url
  return Promise.resolve('opened')
}
