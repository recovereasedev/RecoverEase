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
 * After a submit that worked and emptied its field for the next entry: back
 * into that field - when the submit was pressed from the keyboard. A pointer
 * user does not see where focus is, and moving it into a text field would
 * open a phone's keyboard unasked.
 */
export function refocusAfterKeyboardSubmit(
  container: Element,
  field: HTMLElement | null,
) {
  const active = document.activeElement
  if (!field || !(active instanceof HTMLElement) || !container.contains(active)) {
    return
  }
  let isKeyboard = false
  try {
    isKeyboard = active.matches(':focus-visible')
  } catch {
    // A DOM without :focus-visible (jsdom) is treated as a pointer.
  }
  if (isKeyboard) field.focus()
}
