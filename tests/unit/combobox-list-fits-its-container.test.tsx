import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'

import { Combobox, Field } from '@/components/ui/field'

/**
 * QA-02 — the patient picker's list was cut off inside the dialog.
 *
 * The list is absolutely positioned, so the nearest ancestor with a
 * non-visible overflow clips it. The scheduling dialog's body is
 * `max-h-[70dvh] overflow-y-auto`, which leaves roughly 128px below the field
 * against a list that grew to a fixed 256px: half of a full caseload was
 * drawn outside the clip and could not be seen or clicked — on every
 * viewport, and precisely in the case the search exists for.
 *
 * Scrolling the field up does not fix it. That body is not actually
 * scrollable — its content fits, so the max-height is never reached — and an
 * overflow container clips whether or not it scrolls. The list is sized to
 * the room that is actually there instead; it already scrolls internally, so
 * every option stays reachable.
 *
 * These pin the measurement, because it is invisible in the markup: nothing
 * about a `maxHeight` style says whether it was computed from the container
 * or hard-coded, and the hard-coded version is the bug.
 */

const OPTIONS = Array.from({ length: 20 }, (_, index) => ({
  value: `p-${index}`,
  label: `Patient ${index}`,
}))

/** jsdom lays nothing out, so every rect is zero unless it is stated. */
function stubBottom(element: HTMLElement, bottom: number) {
  element.getBoundingClientRect = () =>
    ({
      bottom,
      top: bottom,
      left: 0,
      right: 0,
      width: 0,
      height: 0,
      x: 0,
      y: bottom,
      toJSON: () => ({}),
    }) as DOMRect
}

/**
 * The field inside a clipping container, positioned by hand.
 *
 * `clipperBottom: null` renders no clipping ancestor at all, which is the
 * case where the viewport is the only floor.
 */
function renderInClipper(options: {
  clipperBottom: number | null
  fieldBottom: number
}) {
  // Controlled, as it is in the dialog: a selection has to survive the
  // parent's re-render for the input to show it.
  function Harness() {
    const [value, setValue] = useState('')
    return (
      <Field label="Patient">
        <Combobox options={OPTIONS} value={value} onChange={setValue} />
      </Field>
    )
  }

  const inner = <Harness />

  render(
    options.clipperBottom === null ? (
      <div data-testid="scroller">{inner}</div>
    ) : (
      // The dialog body's own shape: a capped height that scrolls.
      <div data-testid="scroller" style={{ overflowY: 'auto' }}>
        {inner}
      </div>
    ),
  )

  const input = screen.getByRole('combobox')
  stubBottom(input.parentElement as HTMLElement, options.fieldBottom)
  if (options.clipperBottom !== null) {
    stubBottom(screen.getByTestId('scroller'), options.clipperBottom)
  }
  return input
}

/** Opens the list and lets the measurement, taken on the next frame, land. */
async function openAndMeasure(input: HTMLElement): Promise<HTMLElement> {
  fireEvent.focus(input)
  await act(async () => {
    // Queued after the component's own callback, so that one has run.
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
  })
  return screen.getByRole('listbox')
}

beforeEach(() => {
  // jsdom's default, stated so a test that leans on it is not silently
  // reading someone else's value.
  window.innerHeight = 768
})

describe('the combobox list inside a clipping container', () => {
  it('is no taller than the room left below the field', async () => {
    // 400 − 260 = 140px of room, less an 8px gutter.
    const input = renderInClipper({ clipperBottom: 400, fieldBottom: 260 })
    const list = await openAndMeasure(input)

    expect(list.style.maxHeight).toBe('132px')
  })

  it('stops at the readable cap when there is room to spare', async () => {
    // 1600px below the field. A list that long is a scroll of its own.
    const input = renderInClipper({ clipperBottom: 2000, fieldBottom: 400 })
    const list = await openAndMeasure(input)

    expect(list.style.maxHeight).toBe('256px')
  })

  it('keeps two rows even when the container leaves almost nothing', async () => {
    // The field sits 10px off the bottom edge. A one-line list is worse than
    // a list that overhangs slightly, so this floors rather than vanishing.
    const input = renderInClipper({ clipperBottom: 410, fieldBottom: 400 })
    const list = await openAndMeasure(input)

    expect(list.style.maxHeight).toBe('88px')
  })

  it('measures against the viewport when nothing clips it', async () => {
    // No overflow ancestor: the window is the only floor. 768 − 700 − 8.
    const input = renderInClipper({ clipperBottom: null, fieldBottom: 700 })
    const list = await openAndMeasure(input)

    expect(list.style.maxHeight).toBe('88px')
  })

  it('re-measures each time it is opened, not once for the session', async () => {
    // A dialog is resized, scrolled, and rotated. A height measured on the
    // first open and kept is the same bug with an extra step.
    const input = renderInClipper({ clipperBottom: 400, fieldBottom: 260 })
    expect((await openAndMeasure(input)).style.maxHeight).toBe('132px')

    fireEvent.keyDown(input, { key: 'Escape' })
    stubBottom(input.parentElement as HTMLElement, 150)

    // 400 − 150 − 8.
    expect((await openAndMeasure(input)).style.maxHeight).toBe('242px')
  })

  it('still renders every option, and scrolls to reach them', async () => {
    // The height is a viewport onto the list, not a truncation of it: all 20
    // are in the tree and the list scrolls internally.
    const input = renderInClipper({ clipperBottom: 400, fieldBottom: 260 })
    const list = await openAndMeasure(input)

    expect(within(list).getAllByRole('option')).toHaveLength(20)
    expect(list.className).toContain('overflow-auto')
    expect(within(list).getByText('Patient 19')).toBeInTheDocument()
  })

  it('is still operable by keyboard inside the clipped container', async () => {
    const input = renderInClipper({ clipperBottom: 400, fieldBottom: 260 })
    await openAndMeasure(input)

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(input).toHaveValue('Patient 2')
    expect(input).toHaveAttribute('aria-expanded', 'false')
  })

  it('is still operable by mouse inside the clipped container', async () => {
    const input = renderInClipper({ clipperBottom: 400, fieldBottom: 260 })
    const list = await openAndMeasure(input)

    // An option well down the list — the half that used to be unclickable.
    fireEvent.mouseDown(within(list).getByText('Patient 17'))

    expect(input).toHaveValue('Patient 17')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('still filters as you type, with the same measured height', async () => {
    const input = renderInClipper({ clipperBottom: 400, fieldBottom: 260 })
    await openAndMeasure(input)

    fireEvent.change(input, { target: { value: 'Patient 1' } })

    const list = screen.getByRole('listbox')
    // 1, and 10 through 19.
    expect(within(list).getAllByRole('option')).toHaveLength(11)
    expect(list.style.maxHeight).toBe('132px')
  })
})
