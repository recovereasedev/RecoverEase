import { Lock, TriangleAlert, WifiOff } from 'lucide-react'

import {
  describeError,
  isPresentableMessage,
} from '@/components/feedback/state-view'
import { Notice } from '@/components/ui/notice'

/**
 * The failure of something the user asked to save.
 *
 * `ErrorState` is for a query that would not load: it is centred, tall, and
 * says "we could not load this information. Trying again usually helps."
 * Pointed at a mutation it is wrong three times over — nothing was being
 * loaded, retrying an unchanged form that failed validation fails
 * identically, and the one sentence that would explain why is dropped in
 * production, where the technical detail is hidden.
 *
 * So a save failure says what happened. A recognised network or permission
 * problem keeps the copy written for it, because "new row violates
 * row-level security policy" is not something to show a patient. Anything
 * else falls back to the server's own message when that message was written
 * for a person, and to a plain statement that nothing was saved when it was
 * written by Postgres.
 */
export function FormError({
  error,
  /** What the user was trying to do, e.g. "Your changes were not saved". */
  title = 'That did not save',
}: {
  error: unknown
  title?: string
}) {
  const described = describeError(error)

  if (described.kind === 'network') {
    return (
      <Notice
        tone="danger"
        title="No connection"
        icon={WifiOff}
        live="assertive"
      >
        {described.description} Nothing has been saved.
      </Notice>
    )
  }

  if (described.kind === 'permission') {
    return (
      <Notice
        tone="danger"
        title="You do not have access to this"
        icon={Lock}
        live="assertive"
      >
        {described.description}
      </Notice>
    )
  }

  const raw = described.detail ?? ''

  return (
    <Notice
      tone="danger"
      title={title}
      icon={TriangleAlert}
      live="assertive"
    >
      {isPresentableMessage(raw)
        ? raw
        : 'Nothing was saved. Check the details and try again — if it keeps happening, contact your administrator.'}
    </Notice>
  )
}
