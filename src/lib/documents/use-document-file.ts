import { useCallback, useState } from 'react'

import { type DownloadableFile, saveFile } from '@/lib/documents/download'
import {
  currentPrintEnvironment,
  openPrintTab,
  printFile,
  printRoute,
  type PrintOutcome,
} from '@/lib/documents/print'

export type DocumentAction = 'download' | 'print'

/**
 * Download and Print for one document, from one builder: both hand on the
 * same PDF, so what is printed is exactly what is saved (`print.ts`).
 *
 * One action at a time. Each reports whether it is running and whether it
 * failed, so each button shows its own progress and each failure says which
 * action did not happen. The document module is imported only when the file
 * is asked for, so pdf-lib is never part of a page's first load.
 */
export function useDocumentFile() {
  const [pending, setPending] = useState<DocumentAction | null>(null)
  const [error, setError] = useState<{ action: DocumentAction; cause: unknown } | null>(null)
  const [printOutcome, setPrintOutcome] = useState<PrintOutcome | null>(null)

  const download = useCallback(async (build: () => Promise<DownloadableFile>) => {
    setPending('download')
    setError(null)
    setPrintOutcome(null)
    try {
      saveFile(await build())
    } catch (cause) {
      setError({ action: 'download', cause })
    } finally {
      setPending(null)
    }
  }, [])

  const print = useCallback(async (build: () => Promise<DownloadableFile>) => {
    // Chosen, and the tab opened, before anything is awaited: a tab opened
    // after the PDF is built is no longer part of the click, and is blocked.
    const route = printRoute(currentPrintEnvironment())
    const tab = openPrintTab(route)
    setPending('print')
    setError(null)
    setPrintOutcome(null)
    try {
      setPrintOutcome(await printFile(await build(), route, tab))
    } catch (cause) {
      tab?.close()
      setError({ action: 'print', cause })
    } finally {
      setPending(null)
    }
  }, [])

  return { download, print, pending, error, printOutcome }
}
