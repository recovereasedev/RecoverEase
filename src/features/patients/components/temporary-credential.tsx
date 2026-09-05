import { Check, Copy, KeyRound } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { Notice } from '@/components/ui/notice'

/**
 * A single-use credential, shown once.
 *
 * Shared by account creation and credential reset so the two read the same
 * and cannot drift apart — the sentence explaining what to do when it is
 * lost is the part that most needs to stay true, because it is a promise
 * about a capability that has to exist.
 *
 * The value is a passphrase, so it is laid out to be read down a phone or
 * across a desk: large, spaced, and with a copy button for the case where
 * the person receiving it is sitting at the same screen. It is held in
 * component state for as long as this is on screen and is never written to
 * storage, a query cache or a log.
 */
export function TemporaryCredential({
  title,
  handOver,
  name,
  password,
  lostHint,
}: {
  /** Notice heading, e.g. "Account created" or "New password issued". */
  title: string
  /** Who to give it to, and what happens at their first sign-in. */
  handOver: string
  name: string
  password: string
  /** What to do if this value is lost. Must describe something that exists. */
  lostHint: string
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Without this the timer can fire after the dialog closes and set state on
  // a component that is gone.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(password)
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard access can be refused, and there is nothing to recover:
      // the value is on screen and can be read from it. Saying "copy failed"
      // would be noise at the exact moment the credential must be handed over.
    }
  }

  return (
    <>
      <Notice tone="success" title={title} icon={KeyRound}>
        {handOver} They will be asked to choose their own password the first
        time they sign in, and this one stops working then.
      </Notice>

      <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-surface-sunken p-4">
        <p className="text-label-sm font-medium text-muted">
          Temporary password for {name}
        </p>

        <div className="mt-2 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
          {/* Selectable so it can be copied accurately by hand, in a
              monospace face so the hyphens line up, and large enough to read
              from arm's length without magnifying.
              Not `break-all`: that splits a word down the middle on a narrow
              screen — "lante / rn" — which is the exact transcription error
              a word-based passphrase exists to avoid. Left to wrap normally
              the break falls after a hyphen, where the format already has a
              seam and the reader expects one. */}
          <p className="w-full min-w-0 flex-1 select-all font-mono text-lg leading-relaxed font-semibold tracking-wide break-words text-heading">
            {password}
          </p>

          <button
            type="button"
            onClick={() => void copy()}
            className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-surface px-3 text-sm font-medium text-heading transition-colors hover:bg-surface-sunken"
          >
            {copied ? (
              <Check className="size-4" aria-hidden="true" />
            ) : (
              <Copy className="size-4" aria-hidden="true" />
            )}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>

        <p className="mt-3 text-sm text-muted">
          Four words and a number, all in small letters. Read it out or copy
          it — the hyphens are part of it.
        </p>
      </div>

      {/* Announced when it appears, because the person handing this over may
          be reading the screen rather than watching it. */}
      <p className="text-sm text-muted" role="status" aria-live="polite">
        This is the only time it is shown. {lostHint}
      </p>
    </>
  )
}
