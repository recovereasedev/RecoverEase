import { AlertCircle } from 'lucide-react'
import { useEffect, useRef } from 'react'

import { Notice } from '@/components/ui/notice'

/**
 * The failure message for an authentication form.
 *
 * It is the shared `Notice` primitive plus one behaviour the auth screens all
 * need: bringing itself into view.
 *
 * On a phone the alert sits above the fields — which is right for reading
 * order, since it explains the fields you are about to revisit — but by the
 * time someone taps "Sign in" the keyboard is open and the page is scrolled
 * to the button, so the alert appears entirely off-screen. Sighted users are
 * left staring at a form that did nothing. `block: 'nearest'` scrolls only
 * when it actually is out of view, so on a desktop where the whole form is
 * visible this is a no-op rather than a lurch.
 *
 * Focus is deliberately not moved here. `role="alert"` already announces the
 * message, and focusing it as well makes several screen readers say it twice.
 */
export function AuthFormAlert({ message }: { message: string }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const prefersReducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches

    ref.current?.scrollIntoView({
      block: 'nearest',
      behavior: prefersReducedMotion ? 'auto' : 'smooth',
    })
  }, [message])

  return (
    <div ref={ref}>
      <Notice tone="danger" icon={AlertCircle} live="assertive">
        {message}
      </Notice>
    </div>
  )
}
