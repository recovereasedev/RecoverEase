import { KeyRound } from 'lucide-react'

import { Notice } from '@/components/ui/notice'

/**
 * A single-use credential, shown once.
 *
 * Shared by account creation and credential reset so the two read the same
 * and cannot drift apart — the sentence explaining what to do when it is
 * lost is the part that most needs to stay true, because it is a promise
 * about a capability that has to exist.
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
        {/* Selectable so it can be copied accurately, and in a monospace face
            so characters that look alike are told apart. */}
        <p className="mt-2 select-all font-mono text-lg font-semibold tracking-wide text-heading">
          {password}
        </p>
      </div>

      <p className="text-sm text-muted">
        This is the only time it is shown. {lostHint}
      </p>
    </>
  )
}
