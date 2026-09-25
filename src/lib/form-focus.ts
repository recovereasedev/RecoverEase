import { flushSync } from 'react-dom'

/**
 * Where focus goes around a form that is checked when it is submitted.
 *
 * A submit that is always available, rather than disabled until the form is
 * complete, has to say what is missing when it is pressed too early. The
 * field primitives already put each error beside its field, announce it, and
 * mark the control `aria-invalid`; these move focus to match.
 */

/**
 * After a submit that failed its checks: to the first field marked invalid,
 * so the person lands where the problem is and hears its error with it.
 * Call once the errors have rendered.
 */
export function focusFirstInvalid(container: ParentNode | null | undefined) {
  container?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
}

/**
 * Whether focus is on `element` because of the keyboard. A pointer user does
 * not see where focus is, and moving it into a text field would open a
 * phone's keyboard unasked, so focus is only ever moved for the keyboard.
 */
function hasKeyboardFocus(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false
  try {
    return element.matches(':focus-visible')
  } catch {
    // A DOM without :focus-visible (jsdom) is treated as a pointer.
    return false
  }
}

/**
 * After a submit that worked and emptied its field for the next entry: back
 * into that field - when the submit was pressed from the keyboard.
 */
export function refocusAfterKeyboardSubmit(
  container: Element,
  field: HTMLElement | null,
) {
  const active = document.activeElement
  if (!field || !container.contains(active) || !hasKeyboardFocus(active)) {
    return
  }
  field.focus()
}

/**
 * Closes an inline form - saved or cancelled - and, when it was being used
 * from the keyboard, focuses the control `opener` finds: the one that opened
 * the form, still there or back in its place once the form is gone. Without
 * this the form takes focus with it to the top of the page.
 */
export function closeFormToOpener(
  close: () => void,
  opener: () => HTMLElement | null,
) {
  const fromKeyboard = hasKeyboardFocus(document.activeElement)
  flushSync(close)
  if (fromKeyboard) opener()?.focus()
}
