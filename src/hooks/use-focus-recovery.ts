import { useCallback } from 'react'

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]'

/**
 * Keeps keyboard focus from falling to the page when the control that held it
 * is taken away by what it just did.
 *
 * A saving button now keeps focus while it saves (see `Button`). What it
 * cannot keep is focus on something that is no longer there: "Mark taken"
 * gives way to a Taken badge, "Mark read" leaves with its row, "Confirm"
 * with the appointment it confirmed. And some become unavailable once they
 * have worked - "Send notification" with an empty message box after it. The
 * browser answers both by dropping focus to the top of the page, and a
 * keyboard user starts again from there.
 *
 * Inside the element given the returned ref, this moves it to the nearest
 * control still standing. A control that was removed hands on to the next
 * one after it - the next dose, the next notification, the next action on
 * the same appointment - or the one before if it was the last. A control that
 * became unavailable hands back to the one before it, which is the field that
 * feeds it. With nothing left, focus goes to the page's main content, where
 * the skip link lands.
 *
 * Only for keyboard focus. A pointer user does not see where focus is, and
 * moving it into a text field would open a phone's keyboard unasked. Nor does
 * it act when focus has already gone somewhere real.
 *
 * A callback ref rather than an effect, so a container that appears later -
 * a tab's form, a list that arrives with its data - is watched from the
 * moment it exists.
 */
export function useFocusRecovery() {
  return useCallback((container: HTMLElement | null) => {
    if (!container) return

    let held: HTMLElement | null = null
    let order: HTMLElement[] = []

    const isKeyboardFocus = (element: HTMLElement) => {
      try {
        return element.matches(':focus-visible')
      } catch {
        return false
      }
    }

    const isUsable = (element: HTMLElement) =>
      element.isConnected &&
      !element.matches(':disabled') &&
      element.tabIndex >= 0 &&
      element.getClientRects().length > 0 &&
      !element.closest('[inert], [aria-hidden="true"]')

    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as HTMLElement
      if (!isKeyboardFocus(target)) {
        held = null
        return
      }
      held = target
      order = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE))
    }

    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget as Node | null
      if (next && !container.contains(next)) held = null
    }

    const observer = new MutationObserver(() => {
      if (!held) return
      const removed = !held.isConnected
      if (!removed && !held.matches(':disabled')) return

      // Focus that has already moved somewhere real is left there. A button
      // that has just become disabled can still be the active element for a
      // moment, until the browser takes focus from it.
      const active = document.activeElement
      if (active && active !== document.body && active !== held) {
        held = null
        return
      }

      const index = order.indexOf(held)
      const after = order.slice(index + 1)
      const before = order.slice(0, Math.max(index, 0)).reverse()
      // Within the same dialog, never out of it.
      const scope = held.closest('dialog') ?? container
      const next = (removed ? [...after, ...before] : [...before, ...after])
        .filter((element) => scope.contains(element))
        .find(isUsable)

      held = null
      const fallback = container.closest<HTMLElement>('main')
      ;(next ?? fallback)?.focus()
    })

    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled'],
    })
    container.addEventListener('focusin', onFocusIn)
    container.addEventListener('focusout', onFocusOut)
    return () => {
      observer.disconnect()
      container.removeEventListener('focusin', onFocusIn)
      container.removeEventListener('focusout', onFocusOut)
    }
  }, [])
}
