import { useCallback, useState } from 'react'

export const PDF_TYPE = 'application/pdf'
export const XLSX_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export type DownloadableFile = {
  bytes: Uint8Array
  fileName: string
  mimeType: string
}

/**
 * Hands a file built in the browser to the browser's own download, through a
 * temporary object URL that is released straight afterwards. The file never
 * leaves the device.
 */
export function saveFile({ bytes, fileName, mimeType }: DownloadableFile): void {
  // A copy into a plain ArrayBuffer: Blob will not take a view whose buffer
  // could be shared.
  const blob = new Blob([bytes.slice().buffer], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.rel = 'noopener'
  link.style.display = 'none'
  document.body.append(link)
  link.click()
  link.remove()
  // Revoked on the next task: some browsers start the download only after
  // the click has returned.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/**
 * A file name from its parts - "recoverease", what it is, whose, the date -
 * in lower-case ASCII with hyphens, so it reads the same on every system and
 * never carries a character a file system refuses.
 */
export function documentFileName(parts: string[], date: Date, extension: string): string {
  const day = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
  const slug = ['recoverease', ...parts, day]
    .join(' ')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${slug}.${extension}`
}

/**
 * Builds and saves one file at a time, reporting whether it is being built
 * and whether that failed. The document modules are imported only when a
 * file is asked for, so pdf-lib and fflate are never part of a page's first
 * load.
 */
export function useFileDownload() {
  const [isPending, setPending] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const download = useCallback(async (build: () => Promise<DownloadableFile>) => {
    setPending(true)
    setError(null)
    try {
      saveFile(await build())
    } catch (cause) {
      setError(cause)
    } finally {
      setPending(false)
    }
  }, [])

  return { download, isPending, error, reset: () => setError(null) }
}
