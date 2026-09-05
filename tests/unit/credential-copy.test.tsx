import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TemporaryCredential } from '@/features/patients/components/temporary-credential'
import { copyToClipboard } from '@/lib/clipboard'

/**
 * Copying the temporary credential.
 *
 * The Copy button shipped silently broken: an embedded browser denied
 * `clipboard-write`, `writeText` rejected, and an empty `catch` turned that
 * into a button that did visibly nothing. Nobody could tell whether the
 * password had been copied, at the one moment it has to be handed over
 * correctly.
 *
 * These cover the three outcomes that matter — the modern API works, the
 * fallback works, neither works — and the property that made the original
 * failure invisible: the interface must never claim a copy it did not make.
 *
 * The system clipboard is never used. Both mechanisms are mocked, so this
 * passes or fails on the component's logic rather than on whatever the test
 * runner's environment happens to permit.
 */

const PASSPHRASE = 'cedar-harbor-lantern-willow-42'

function setClipboard(writeText: unknown) {
  Object.defineProperty(navigator, 'clipboard', {
    value: writeText === null ? undefined : { writeText },
    configurable: true,
    writable: true,
  })
}

let execCommand: ReturnType<typeof vi.fn>

beforeEach(() => {
  execCommand = vi.fn(() => true)
  // jsdom does not implement it at all, so it has to be installed to be
  // exercised — and removed again where "no fallback available" is the case
  // under test.
  ;(document as unknown as { execCommand: unknown }).execCommand = execCommand
})

afterEach(() => {
  vi.restoreAllMocks()
  setClipboard(null)
})

describe('copyToClipboard', () => {
  it('uses the Clipboard API when it works', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    setClipboard(writeText)

    await expect(copyToClipboard(PASSPHRASE)).resolves.toBe('copied')
    expect(writeText).toHaveBeenCalledWith(PASSPHRASE)
    // No need to disturb the document when the good path works.
    expect(execCommand).not.toHaveBeenCalled()
  })

  it('falls back when the Clipboard API is absent', async () => {
    setClipboard(null)

    await expect(copyToClipboard(PASSPHRASE)).resolves.toBe('copied')
    expect(execCommand).toHaveBeenCalledWith('copy')
  })

  it('falls back when the Clipboard API is denied', async () => {
    // The exact production failure: permission denied in an embedded view.
    const writeText = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('Document is not focused.'), {
          name: 'NotAllowedError',
        }),
      )
    setClipboard(writeText)

    await expect(copyToClipboard(PASSPHRASE)).resolves.toBe('copied')
    expect(writeText).toHaveBeenCalled()
    expect(execCommand).toHaveBeenCalledWith('copy')
  })

  it('reports failure when the fallback also fails', async () => {
    setClipboard(null)
    execCommand.mockReturnValue(false)

    await expect(copyToClipboard(PASSPHRASE)).resolves.toBe('failed')
  })

  it('reports failure when the fallback throws', async () => {
    setClipboard(null)
    execCommand.mockImplementation(() => {
      throw new Error('blocked')
    })

    await expect(copyToClipboard(PASSPHRASE)).resolves.toBe('failed')
  })

  it('reports failure when there is no fallback at all', async () => {
    setClipboard(null)
    delete (document as unknown as { execCommand?: unknown }).execCommand

    await expect(copyToClipboard(PASSPHRASE)).resolves.toBe('failed')
  })

  it('leaves nothing carrying the value behind in the document', async () => {
    setClipboard(null)
    execCommand.mockImplementation(() => {
      throw new Error('blocked')
    })

    await copyToClipboard(PASSPHRASE)

    // Removed in a `finally`, so even a throwing copy cannot leave the
    // passphrase sitting in a stray element.
    expect(document.body.innerHTML).not.toContain(PASSPHRASE)
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
  })
})

function renderCredential() {
  return render(
    <TemporaryCredential
      title="New password issued"
      handOver="Give this password to the doctor."
      name="Dr Example"
      password={PASSPHRASE}
      lostHint="If it is lost again, reset the account once more."
    />,
  )
}

describe('the temporary credential panel', () => {
  it('confirms a copy that actually happened', async () => {
    setClipboard(vi.fn().mockResolvedValue(undefined))
    renderCredential()

    fireEvent.click(screen.getByRole('button', { name: /copy/i }))

    await waitFor(() =>
      expect(screen.getByText('Copied to the clipboard.')).toBeInTheDocument(),
    )
    expect(screen.queryByText(/copy failed/i)).not.toBeInTheDocument()
  })

  it('says so when the copy could not be made', async () => {
    // The defect this file exists for: silence here is what shipped.
    setClipboard(vi.fn().mockRejectedValue(new Error('denied')))
    execCommand.mockReturnValue(false)
    renderCredential()

    fireEvent.click(screen.getByRole('button', { name: /copy/i }))

    await waitFor(() =>
      expect(
        screen.getByText(
          'Copy failed — select the password above and copy it manually.',
        ),
      ).toBeInTheDocument(),
    )
    // And never claims otherwise.
    expect(screen.queryByText('Copied to the clipboard.')).not.toBeInTheDocument()
  })

  it('keeps the passphrase readable whether the copy worked or not', async () => {
    setClipboard(vi.fn().mockRejectedValue(new Error('denied')))
    execCommand.mockReturnValue(false)
    renderCredential()

    fireEvent.click(screen.getByRole('button', { name: /copy/i }))

    await waitFor(() =>
      expect(screen.getByText(/copy failed/i)).toBeInTheDocument(),
    )
    // The value is the point of the screen. It must survive a failed copy.
    expect(screen.getByText(PASSPHRASE)).toBeVisible()
  })

  it('announces the outcome to a screen reader', async () => {
    setClipboard(vi.fn().mockResolvedValue(undefined))
    renderCredential()

    fireEvent.click(screen.getByRole('button', { name: /copy/i }))

    await waitFor(() => {
      const live = screen
        .getAllByRole('status')
        .find((node) => /Copied to the clipboard/.test(node.textContent ?? ''))
      expect(live).toBeDefined()
      expect(live).toHaveAttribute('aria-live', 'polite')
    })
  })

  it('is reachable and operable from the keyboard', () => {
    setClipboard(vi.fn().mockResolvedValue(undefined))
    renderCredential()

    const button = screen.getByRole('button', { name: /copy/i })
    // A real button: focusable, in the tab order, activated by Enter/Space
    // without any handler of our own.
    expect(button.tagName).toBe('BUTTON')
    expect(button).not.toHaveAttribute('disabled')
    expect(button).not.toHaveAttribute('tabindex', '-1')
    button.focus()
    expect(button).toHaveFocus()
  })

  it('never logs the credential', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    setClipboard(vi.fn().mockRejectedValue(new Error('denied')))
    execCommand.mockReturnValue(false)
    renderCredential()

    fireEvent.click(screen.getByRole('button', { name: /copy/i }))
    await waitFor(() =>
      expect(screen.getByText(/copy failed/i)).toBeInTheDocument(),
    )

    for (const spy of [log, warn, error]) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(PASSPHRASE)
      }
    }
  })

  it('never puts the credential in the URL or in storage', async () => {
    setClipboard(vi.fn().mockRejectedValue(new Error('denied')))
    execCommand.mockReturnValue(false)
    renderCredential()

    fireEvent.click(screen.getByRole('button', { name: /copy/i }))
    await waitFor(() =>
      expect(screen.getByText(/copy failed/i)).toBeInTheDocument(),
    )

    expect(window.location.href).not.toContain(PASSPHRASE)
    for (const store of [localStorage, sessionStorage]) {
      for (const key of Object.keys(store)) {
        expect(store.getItem(key) ?? '').not.toContain(PASSPHRASE)
      }
    }
  })
})
