import { X } from 'lucide-react'
import { useEffect, useId, useRef, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'

/**
 * A modal dialog built on the native `<dialog>` element.
 *
 * `showModal()` gives focus trapping, Escape-to-close, the top layer and the
 * backdrop from the platform. Reimplementing those by hand is where custom
 * modals usually go wrong — focus escaping to the page behind is the classic
 * one, and it makes a dialog unusable with a keyboard or screen reader.
 */
export function Dialog({
  isOpen,
  onClose,
  title,
  description,
  children,
  footer,
}: {
  isOpen: boolean
  onClose: () => void
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    const element = dialogRef.current
    if (!element) return

    if (isOpen && !element.open) {
      element.showModal()
    } else if (!isOpen && element.open) {
      element.close()
    }
  }, [isOpen])

  useEffect(() => {
    const element = dialogRef.current
    if (!element) return

    // Fires for Escape as well as for close(), so the parent's state stays in
    // step with the platform's own dismissal.
    const handleClose = () => onClose()
    element.addEventListener('close', handleClose)
    return () => element.removeEventListener('close', handleClose)
  }, [onClose])

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      // The backdrop is styled through the pseudo-element so clicks outside
      // land on the dialog element itself, which the handler below detects.
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-surface p-0 shadow-[var(--shadow-lg)] backdrop:bg-neutral-900/40"
      onClick={(event) => {
        // A click on the dialog element but outside its content box is a
        // click on the backdrop.
        if (event.target === dialogRef.current) onClose()
      }}
    >
      <div className="flex items-start justify-between gap-4 border-b border-[var(--color-border)] px-4 py-4 sm:px-5">
        <div className="min-w-0">
          <h2 id={titleId} className="text-lg font-semibold text-heading">
            {title}
          </h2>
          {description ? (
            <p id={descriptionId} className="mt-0.5 text-sm text-muted">
              {description}
            </p>
          ) : null}
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label="Close dialog"
        >
          <X aria-hidden="true" />
        </Button>
      </div>

      <div className="max-h-[70dvh] overflow-y-auto px-4 py-5 sm:px-5">{children}</div>

      {footer ? (
        <div className="flex flex-col-reverse gap-2 border-t border-[var(--color-border)] px-4 py-4 sm:flex-row sm:flex-wrap sm:justify-end sm:gap-3 sm:px-5 [&>*]:w-full sm:[&>*]:w-auto">
          {footer}
        </div>
      ) : null}
    </dialog>
  )
}
