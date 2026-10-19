import { vi } from 'vitest'

export type CapturedFile = { name: string; type: string; bytes: () => Promise<Uint8Array> }

/**
 * Stands in for the browser's download: records each file a page hands to
 * `saveFile` - its name, its type and its bytes - instead of saving it.
 * jsdom has no object URLs and does not navigate on a link click, so both
 * are replaced for the test and restored by `vi.restoreAllMocks()` and
 * `release()`.
 */
export function captureDownloads() {
  const files: CapturedFile[] = []
  const blobs = new Map<string, Blob>()
  let next = 0
  const original = {
    create: URL.createObjectURL,
    revoke: URL.revokeObjectURL,
  }
  const revoked: string[] = []

  URL.createObjectURL = (blob: Blob) => {
    next += 1
    const url = `blob:recoverease-test/${next}`
    blobs.set(url, blob)
    return url
  }
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url)
  }
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    const blob = blobs.get(this.href)
    if (!blob) return
    files.push({ name: this.download, type: blob.type, bytes: () => readBlob(blob) })
  })

  return {
    files,
    revoked,
    release() {
      URL.createObjectURL = original.create
      URL.revokeObjectURL = original.revoke
    },
  }
}

function readBlob(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(blob)
  })
}
