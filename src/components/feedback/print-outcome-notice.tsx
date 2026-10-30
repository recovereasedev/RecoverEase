import type { PrintOutcome } from '@/lib/documents/print'
import { cn } from '@/lib/utils'

/**
 * What Print did, where that is not obvious: where the browser could not
 * print the document from the page (a phone, a tablet, Safari), it opened
 * in a new tab or was downloaded instead (`print.ts`). When the print dialog
 * opened, the dialog is the answer and nothing is said.
 *
 * The status region is always rendered, empty until there is something to
 * say, so a screen reader announces each message as it arrives.
 */
export function PrintOutcomeNotice({
  outcome,
  what,
  className,
}: {
  outcome: PrintOutcome | null
  /** The document, as the sentence names it: "prescription", "treatment plan". */
  what: string
  className?: string
}) {
  const message =
    outcome === 'opened'
      ? `The ${what} opened in a new tab. Print it from there, or share it to a printer.`
      : outcome === 'downloaded'
        ? `This browser could not open the ${what} for printing, so it was downloaded instead. Open the file to print it.`
        : null

  return (
    <p role="status" className={cn('text-sm text-body empty:hidden print:hidden', className)}>
      {message}
    </p>
  )
}
