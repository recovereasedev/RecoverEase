/**
 * Copying a short value to the clipboard, in the browsers this actually runs
 * in rather than the one in the specification.
 *
 * `navigator.clipboard.writeText` is the right API and it is not always
 * available: it needs a secure context, it needs the document focused, and
 * the permission can simply be denied — an embedded browser view refused it
 * outright in production, which is how this was found. The failure is a
 * rejected promise, so code that awaits it inside a `try` with an empty
 * `catch` reports nothing and leaves a button that does visibly nothing.
 *
 * So: try the modern API, fall back to a selection-based copy, and if both
 * fail say so. The caller must be able to tell the difference, which is why
 * this returns a result instead of throwing.
 *
 * Nothing here logs, stores, or transmits the value. The fallback puts it in
 * a detached textarea for the length of one synchronous copy command and
 * removes it in a `finally`, so it is never left in the document even if the
 * copy throws.
 */
export type CopyOutcome = 'copied' | 'failed'

/** The selection-based copy, for when the Clipboard API is not usable. */
function copyBySelection(text: string): boolean {
  // `execCommand` is deprecated and still the only fallback that works where
  // the Clipboard API is denied. It is never reached when the modern API
  // succeeds.
  if (typeof document.execCommand !== 'function') return false

  const carrier = document.createElement('textarea')
  try {
    carrier.value = text
    // Off-screen rather than hidden: `display: none` and `visibility: hidden`
    // are not selectable, so the copy would silently produce nothing.
    carrier.setAttribute('readonly', '')
    carrier.style.position = 'fixed'
    carrier.style.top = '-1000px'
    carrier.style.opacity = '0'
    document.body.appendChild(carrier)

    carrier.select()
    carrier.setSelectionRange(0, text.length)

    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    // Always, including when `execCommand` throws: the value must not be left
    // sitting in the document.
    carrier.remove()
  }
}

export async function copyToClipboard(text: string): Promise<CopyOutcome> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return 'copied'
    }
  } catch {
    // Denied, not focused, or insecure context. Fall through and try the
    // other way rather than giving up here.
  }

  return copyBySelection(text) ? 'copied' : 'failed'
}
