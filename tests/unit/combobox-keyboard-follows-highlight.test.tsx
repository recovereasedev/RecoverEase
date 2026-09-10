import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { Combobox, Field } from '@/components/ui/field'

/**
 * The shared Combobox, driven by the keyboard through a long list.
 *
 * The highlight and `aria-activedescendant` always moved correctly — a screen
 * reader heard the right option, and Enter chose it — but nothing scrolled
 * the list. Past the last visible row a sighted keyboard user was choosing
 * blind: in the scheduling dialog from the second press, on Reports from the
 * fifth. These pin that the highlighted option is kept on screen, and that
 * everything the keyboard already got right still is.
 *
 * jsdom lays nothing out, so the list's geometry is stated: 44px rows below a
 * 4px padding, three rows visible. The component reads the same properties a
 * browser provides; the E2E spec checks the real layout.
 */

const ROW = 44
const PADDING = 4
const VISIBLE = 132

const OPTIONS = Array.from({ length: 30 }, (_, index) => ({
  value: `p-${index}`,
  label: `Patient ${String(index).padStart(2, '0')}`,
}))

const scrolls = new WeakMap<Element, number>()
const saved = {
  offsetTop: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop'),
  offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight'),
}

function optionIndex(element: HTMLElement): number {
  const siblings = [...(element.parentElement?.children ?? [])].filter(
    (sibling) => sibling.getAttribute('role') === 'option',
  )
  return siblings.indexOf(element)
}

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute('role') === 'option'
        ? PADDING + optionIndex(this) * ROW
        : 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute('role') === 'option' ? ROW : 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute('role') === 'listbox' ? VISIBLE : 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement) {
      return scrolls.get(this) ?? 0
    },
    set(this: HTMLElement, value: number) {
      scrolls.set(this, value)
    },
  })
})

afterAll(() => {
  if (saved.offsetTop) Object.defineProperty(HTMLElement.prototype, 'offsetTop', saved.offsetTop)
  if (saved.offsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', saved.offsetHeight)
  // These two were inherited from Element; removing the overrides restores them.
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
  delete (HTMLElement.prototype as { scrollTop?: number }).scrollTop
})

afterEach(() => {
  delete (document as { elementFromPoint?: unknown }).elementFromPoint
})

function Harness({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial)
  return (
    <Field label="Patient">
      <Combobox options={OPTIONS} value={value} onChange={setValue} />
    </Field>
  )
}

function renderPicker(initial?: string) {
  render(<Harness initial={initial} />)
  return screen.getByRole('combobox')
}

/** The option `aria-activedescendant` names, and whether the list shows it. */
function highlighted(input: HTMLElement) {
  const list = screen.getByRole('listbox')
  const id = input.getAttribute('aria-activedescendant')
  const option = id ? document.getElementById(id) : null
  if (!option) throw new Error('no active option')
  const top = option.offsetTop
  const bottom = top + option.offsetHeight
  return {
    label: option.textContent,
    isAnOption: option.getAttribute('role') === 'option',
    onScreen: top >= list.scrollTop && bottom <= list.scrollTop + list.clientHeight,
    scrollTop: list.scrollTop,
  }
}

function label(index: number) {
  return `Patient ${String(index).padStart(2, '0')}`
}

describe('the keyboard highlight stays on screen', () => {
  it('opens on the first option, highlighted and in view', () => {
    const input = renderPicker()
    fireEvent.focus(input)

    const h = highlighted(input)
    expect(h.label).toBe(label(0))
    expect(h.isAnOption).toBe(true)
    expect(h.onScreen).toBe(true)
  })

  it('follows ArrowDown through the whole list', () => {
    const input = renderPicker()
    fireEvent.focus(input)

    for (let index = 1; index < OPTIONS.length; index++) {
      fireEvent.keyDown(input, { key: 'ArrowDown' })
      const h = highlighted(input)
      // The accessible name of the active option is the one just reached…
      expect(h.label).toBe(label(index))
      expect(h.isAnOption).toBe(true)
      // …and a sighted user can see it too.
      expect(h.onScreen, `${label(index)} on screen`).toBe(true)
    }
    expect(highlighted(input).scrollTop).toBeGreaterThan(0)
  })

  it('follows ArrowUp all the way back', () => {
    const input = renderPicker()
    fireEvent.focus(input)
    fireEvent.keyDown(input, { key: 'End' })

    for (let index = OPTIONS.length - 2; index >= 0; index--) {
      fireEvent.keyDown(input, { key: 'ArrowUp' })
      const h = highlighted(input)
      expect(h.label).toBe(label(index))
      expect(h.onScreen, `${label(index)} on screen`).toBe(true)
    }
  })

  it('shows the last option on End', () => {
    const input = renderPicker()
    fireEvent.focus(input)
    fireEvent.keyDown(input, { key: 'End' })

    const h = highlighted(input)
    expect(h.label).toBe(label(29))
    expect(h.onScreen).toBe(true)
  })

  it('returns to the first option on Home', () => {
    const input = renderPicker()
    fireEvent.focus(input)
    fireEvent.keyDown(input, { key: 'End' })
    fireEvent.keyDown(input, { key: 'Home' })

    const h = highlighted(input)
    expect(h.label).toBe(label(0))
    expect(h.onScreen).toBe(true)
  })

  it('shows the last option when ArrowUp wraps from the first', () => {
    const input = renderPicker()
    fireEvent.focus(input)
    fireEvent.keyDown(input, { key: 'ArrowUp' })

    const h = highlighted(input)
    expect(h.label).toBe(label(29))
    expect(h.onScreen).toBe(true)
  })

  it('chooses exactly the highlighted option on Enter, after a long walk', () => {
    const input = renderPicker()
    fireEvent.focus(input)
    for (let step = 0; step < 17; step++) fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(input).toHaveValue(label(17))
    expect(input).toHaveAttribute('aria-expanded', 'false')
  })

  it('keeps the previous choice when Escape abandons a walk', () => {
    const input = renderPicker(OPTIONS[3]!.value)
    fireEvent.focus(input)
    for (let step = 0; step < 20; step++) fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(input).toHaveValue(label(3))
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('shows an already-chosen deep option when the list reopens', () => {
    const input = renderPicker(OPTIONS[24]!.value)
    fireEvent.focus(input)

    const h = highlighted(input)
    expect(h.label).toBe(label(24))
    expect(h.onScreen).toBe(true)
  })

  it('starts a new filter at the top, in view', () => {
    const input = renderPicker()
    fireEvent.focus(input)
    for (let step = 0; step < 25; step++) fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.change(input, { target: { value: 'Patient 1' } })

    // Patient 10 to Patient 19.
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(10)
    const h = highlighted(input)
    expect(h.label).toBe(label(10))
    expect(h.onScreen).toBe(true)
  })
})

describe('the pointer is left alone', () => {
  it('does not scroll the list when the pointer highlights an option', () => {
    // The list has been wheel-scrolled to 300px, so rows 300–432 show, and
    // the pointer comes to rest on Patient 06, half hidden at the top edge
    // (268–312). Following the pointer would drag the list back to 268 and
    // fight the wheel.
    //
    // It must be a different option from the one already highlighted:
    // hovering Patient 00, highlighted since the list opened, changes
    // nothing, so this would pass whether or not the pointer is followed.
    const input = renderPicker()
    fireEvent.focus(input)
    const list = screen.getByRole('listbox')
    list.scrollTop = 300

    fireEvent.mouseEnter(within(list).getByText(label(6)))

    // The highlight moves to the hovered option…
    expect(highlighted(input).label).toBe(label(6))
    // …and the list does not.
    expect(list.scrollTop).toBe(300)
  })

  it('follows again as soon as the keyboard takes over', () => {
    const input = renderPicker()
    fireEvent.focus(input)
    const list = screen.getByRole('listbox')
    list.scrollTop = 300
    fireEvent.mouseEnter(within(list).getByText(label(6)))

    // From the hovered Patient 06, ArrowUp reaches Patient 05 (224–268),
    // wholly above the visible rows: the keyboard has to scroll to it.
    fireEvent.keyDown(input, { key: 'ArrowUp' })

    const h = highlighted(input)
    expect(h.label).toBe(label(5))
    expect(h.onScreen).toBe(true)
    expect(list.scrollTop).toBeLessThan(300)
  })

  it('still chooses a deep option by mouse', () => {
    const input = renderPicker()
    fireEvent.focus(input)
    fireEvent.mouseDown(within(screen.getByRole('listbox')).getByText(label(27)))

    expect(input).toHaveValue(label(27))
  })
})

describe('the floor under a list that nothing clips', () => {
  /** jsdom lays nothing out, so every rect is zero unless it is stated. */
  function stubRect(element: Element, top: number, bottom: number) {
    element.getBoundingClientRect = () =>
      ({ top, bottom, left: 0, right: 320, width: 320, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
  }

  async function openAndMeasure(input: HTMLElement) {
    fireEvent.focus(input)
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    })
    return screen.getByRole('listbox')
  }

  function renderAboveBar(barTop: number) {
    window.innerHeight = 568
    render(
      <>
        <Harness />
        <nav data-testid="bar" style={{ position: 'fixed' }}>
          <span data-testid="bar-item">Menu</span>
        </nav>
      </>,
    )
    const input = screen.getByRole('combobox')
    stubRect(input.parentElement as HTMLElement, 346, 390)
    stubRect(screen.getByTestId('bar'), barTop, 568)
    return input
  }

  it('stops at a bar fixed over the bottom of the screen', async () => {
    // A 320×568 phone: the field ends at 390 and the navigation bar starts at
    // 503. Measured to the window, the list ran 61px underneath the bar.
    const input = renderAboveBar(503)
    const item = screen.getByTestId('bar-item')
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => item })

    const list = await openAndMeasure(input)

    // 503 − 390 − 8, not 568 − 390 − 8.
    expect(list.style.maxHeight).toBe('105px')
  })

  it('ignores a fixed element that starts above the field', async () => {
    const input = renderAboveBar(300)
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => screen.getByTestId('bar'),
    })

    const list = await openAndMeasure(input)

    expect(list.style.maxHeight).toBe('170px')
  })

  it('changes nothing when what is drawn at the bottom is the list itself', async () => {
    // The list on top of everything there: nothing is painting over it.
    const input = renderAboveBar(503)
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => document.querySelector('[role="listbox"] [role="option"]'),
    })

    const list = await openAndMeasure(input)

    expect(list.style.maxHeight).toBe('170px')
  })

  it('does not consult the bar inside a clipping container', async () => {
    // The scheduling dialog: its body clips the list, and it sits in the top
    // layer above the bar, so the body's bottom is the floor.
    window.innerHeight = 568
    render(
      <>
        <div data-testid="scroller" style={{ overflowY: 'auto' }}>
          <Harness />
        </div>
        <nav data-testid="bar" style={{ position: 'fixed' }} />
      </>,
    )
    const input = screen.getByRole('combobox')
    stubRect(input.parentElement as HTMLElement, 346, 390)
    stubRect(screen.getByTestId('scroller'), 0, 530)
    stubRect(screen.getByTestId('bar'), 503, 568)
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => screen.getByTestId('bar'),
    })

    const list = await openAndMeasure(input)

    // 530 − 390 − 8: the container, never the bar.
    expect(list.style.maxHeight).toBe('132px')
  })
})
