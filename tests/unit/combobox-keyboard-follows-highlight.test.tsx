import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { Combobox, Field } from '@/components/ui/field'

/**
 * The shared Combobox, driven through a long list by keyboard and by pointer.
 *
 * Nothing used to scroll the list, so past the last visible row a sighted
 * keyboard user was choosing blind — from the second press in the scheduling
 * dialog, the fifth on Reports. The first fix for that (3b1fc5b) was reverted
 * in production for two regressions, and both are pinned here:
 *
 *  - A pointer resting over the list took the highlight as the keyboard
 *    scrolled rows beneath it. A browser tells whatever moves under a still
 *    cursor that the pointer is now over it, and the list took that for the
 *    user pointing: Enter then chose a different patient from the one the
 *    keyboard had highlighted.
 *  - A list scrolled by hand jumped back to the highlight whenever its page
 *    re-rendered — on Reports, every time the tab regained focus.
 *
 * Both real callers build `options` inline, so every render of their page
 * hands the combobox a fresh array. The harness does the same: a constant
 * array is what let the second regression through.
 *
 * jsdom lays nothing out, so the list's geometry is stated: 44px rows below a
 * 4px padding, three rows visible. The component reads the same properties a
 * browser provides; the E2E spec checks the geometry a browser produces.
 */

const ROW = 44
const PADDING = 4
const VISIBLE = 132
const LAST = 29

function label(index: number) {
  return `Patient ${String(index).padStart(2, '0')}`
}

const OPTIONS = Array.from({ length: LAST + 1 }, (_, index) => ({
  value: `p-${index}`,
  label: label(index),
}))

const scrolls = new WeakMap<Element, number>()
/** Every scrollTop written, as `from->to`. */
const writes: string[] = []
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
      writes.push(`${scrolls.get(this) ?? 0}->${value}`)
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

beforeEach(() => {
  writes.length = 0
})

afterEach(() => {
  delete (document as { elementFromPoint?: unknown }).elementFromPoint
  window.innerHeight = 768
})

function Harness({ initial = '' }: { initial?: string }) {
  const [value, setValue] = useState(initial)
  return (
    <Field label="Patient">
      <Combobox
        // Fresh on every render, exactly as both pages build it.
        options={OPTIONS.map((option) => ({ ...option }))}
        value={value}
        onChange={setValue}
      />
    </Field>
  )
}

/** Opens the list and lets the measurement, taken on the next frame, land. */
async function openAndMeasure(input: HTMLElement) {
  fireEvent.focus(input)
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
  })
}

async function openPicker(initial?: string) {
  const view = render(<Harness initial={initial} />)
  const input = screen.getByRole('combobox')
  await openAndMeasure(input)
  writes.length = 0
  return {
    input,
    list: screen.getByRole('listbox'),
    /** The page re-rendering for reasons of its own. */
    rerender: () => view.rerender(<Harness initial={initial} />),
  }
}

function option(list: HTMLElement, index: number): HTMLElement {
  return list.querySelectorAll<HTMLElement>('[role="option"]')[index]
}

/**
 * The option `aria-activedescendant` names — what a screen reader hears —
 * whether it is also the one drawn highlighted, and whether the list shows it.
 */
function active(input: HTMLElement) {
  const list = screen.getByRole('listbox')
  const id = input.getAttribute('aria-activedescendant')
  const node = id ? document.getElementById(id) : null
  if (!node) throw new Error('no active option')
  const top = node.offsetTop
  const bottom = top + node.offsetHeight
  return {
    label: node.textContent,
    painted:
      node.classList.contains('bg-brand-50') &&
      list.querySelectorAll('.bg-brand-50').length === 1,
    onScreen: top >= list.scrollTop && bottom <= list.scrollTop + list.clientHeight,
  }
}

/** Highlighted, named, and in view. */
function shown(index: number) {
  return { label: label(index), painted: true, onScreen: true }
}

/** A wheel, a trackpad or a finger scrolls the list; nothing else happens. */
function scrollByHand(list: HTMLElement, to: number) {
  list.scrollTop = to
  fireEvent.scroll(list)
  writes.length = 0
}

type Point = { x: number; y: number }

/** The pointer is over a row, and moves over it, at `at`. */
function pointerOver(row: HTMLElement, at: Point) {
  const init = { clientX: at.x, clientY: at.y }
  fireEvent.mouseOver(row, init)
  fireEvent.mouseEnter(row, init)
  fireEvent.mouseMove(row, init)
}

/**
 * What a browser sends when the list scrolls beneath a pointer that has not
 * moved: the row now under it is told the pointer is over it (Chrome sends
 * mouseover and mouseenter), and some engines add a mousemove that repeats
 * the pointer's unchanged position.
 */
const rowScrollsUnder = pointerOver

/** The pointer genuinely moving onto a row, arriving at `at`. */
const pointerMovesOnto = pointerOver

describe('the keyboard highlight stays on screen', () => {
  it('opens on the first option, highlighted and in view', async () => {
    const { input } = await openPicker()
    expect(active(input)).toEqual(shown(0))
  })

  it('follows ArrowDown through the whole list', async () => {
    const { input, list } = await openPicker()
    for (let index = 1; index <= LAST; index++) {
      fireEvent.keyDown(input, { key: 'ArrowDown' })
      expect(active(input), `${label(index)}`).toEqual(shown(index))
    }
    expect(list.scrollTop).toBeGreaterThan(0)
  })

  it('follows ArrowUp all the way back', async () => {
    const { input } = await openPicker()
    fireEvent.keyDown(input, { key: 'End' })
    for (let index = LAST - 1; index >= 0; index--) {
      fireEvent.keyDown(input, { key: 'ArrowUp' })
      expect(active(input), `${label(index)}`).toEqual(shown(index))
    }
  })

  it('shows the last option on End', async () => {
    const { input } = await openPicker()
    fireEvent.keyDown(input, { key: 'End' })
    expect(active(input)).toEqual(shown(LAST))
  })

  it('returns to the first option on Home', async () => {
    const { input } = await openPicker()
    fireEvent.keyDown(input, { key: 'End' })
    fireEvent.keyDown(input, { key: 'Home' })
    expect(active(input)).toEqual(shown(0))
  })

  it('wraps from the first option to the last, and back', async () => {
    const { input } = await openPicker()
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(active(input)).toEqual(shown(LAST))
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(active(input)).toEqual(shown(0))
  })

  it('scrolls only as far as it has to', async () => {
    const { input } = await openPicker()
    // Patient 01 (48–92) is already in view; Patient 02 (92–136) needs 4px;
    // Patient 03 (136–180) needs the list at 48.
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(writes).toEqual([])
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(writes).toEqual(['0->4', '4->48'])
  })

  it('chooses exactly the highlighted option on Enter, after a long walk', async () => {
    const { input } = await openPicker()
    for (let step = 0; step < 17; step++) fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(input).toHaveValue(label(17))
    expect(input).toHaveAttribute('aria-expanded', 'false')
  })

  it('keeps the previous choice when Escape abandons a walk', async () => {
    const { input } = await openPicker(OPTIONS[3].value)
    for (let step = 0; step < 20; step++) fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(input).toHaveValue(label(3))
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('shows an already-chosen deep option when the list reopens', async () => {
    const { input } = await openPicker(OPTIONS[24].value)
    expect(active(input)).toEqual(shown(24))
  })

  it('starts a new filter at the top, in view', async () => {
    const { input } = await openPicker()
    for (let step = 0; step < 25; step++) fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.change(input, { target: { value: 'Patient 1' } })

    // Patient 10 to Patient 19.
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(10)
    expect(active(input)).toEqual(shown(10))
  })
})

describe('a pointer that has stopped never takes the keyboard highlight', () => {
  it('ignores rows the keyboard scrolls beneath it', async () => {
    const { input, list } = await openPicker()
    // The pointer comes to rest on Patient 01.
    pointerMovesOnto(option(list, 0), { x: 100, y: 20 })
    pointerMovesOnto(option(list, 1), { x: 100, y: 60 })
    expect(active(input).label).toBe(label(1))

    // End scrolls the list to its foot; Patient 27 is now where the pointer
    // is, though the pointer has not moved.
    fireEvent.keyDown(input, { key: 'End' })
    rowScrollsUnder(option(list, 27), { x: 100, y: 60 })

    expect(active(input)).toEqual(shown(LAST))
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input).toHaveValue(label(LAST))
  })

  it('ignores hover on its own, with no movement at all', async () => {
    const { input, list } = await openPicker()
    fireEvent.keyDown(input, { key: 'End' })
    fireEvent.mouseOver(option(list, 27))
    fireEvent.mouseEnter(option(list, 27))

    expect(active(input)).toEqual(shown(LAST))
  })

  it('takes a first mousemove only as where the pointer is', async () => {
    // A pointer the list opened beneath has never moved over it: the first
    // mousemove may be the browser repeating where it rests.
    const { input, list } = await openPicker()
    fireEvent.keyDown(input, { key: 'End' })
    fireEvent.mouseMove(option(list, 27), { clientX: 100, clientY: 60 })

    expect(active(input)).toEqual(shown(LAST))
  })

  it('forgets where the pointer was when the list closes', async () => {
    const { input, list } = await openPicker()
    pointerMovesOnto(option(list, 0), { x: 100, y: 20 })
    pointerMovesOnto(option(list, 1), { x: 100, y: 60 })
    fireEvent.keyDown(input, { key: 'Escape' })

    await openAndMeasure(input)
    const reopened = screen.getByRole('listbox')
    fireEvent.mouseMove(option(reopened, 2), { clientX: 100, clientY: 104 })

    expect(active(input)).toEqual(shown(0))
  })

  it('follows the pointer when it genuinely moves', async () => {
    const { input, list } = await openPicker()
    pointerMovesOnto(option(list, 0), { x: 100, y: 20 })
    pointerMovesOnto(option(list, 1), { x: 100, y: 60 })
    fireEvent.keyDown(input, { key: 'End' })
    rowScrollsUnder(option(list, 27), { x: 100, y: 60 })

    pointerMovesOnto(option(list, 28), { x: 100, y: 104 })

    expect(active(input)).toMatchObject({ label: label(28), painted: true })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input).toHaveValue(label(28))
  })

  it('never scrolls the list to follow the pointer', async () => {
    // Scrolled to 300, rows 300–432 show; the pointer settles on Patient 06
    // (268–312), half hidden at the top edge. Revealing it would drag the
    // list back under the hand that just put it there.
    const { input, list } = await openPicker()
    scrollByHand(list, 300)
    pointerMovesOnto(option(list, 6), { x: 100, y: 10 })
    pointerMovesOnto(option(list, 6), { x: 100, y: 14 })

    expect(active(input).label).toBe(label(6))
    expect(writes).toEqual([])
    expect(list.scrollTop).toBe(300)
  })

  it('still chooses the option under the pointer on click', async () => {
    const { input, list } = await openPicker()
    fireEvent.keyDown(input, { key: 'End' })
    fireEvent.mouseDown(option(list, 27))

    expect(input).toHaveValue(label(27))
  })
})

describe('a list scrolled by hand stays where it was left', () => {
  it('is not scrolled back when the page re-renders with fresh options', async () => {
    const { input, list, rerender } = await openPicker()
    for (let step = 0; step < 3; step++) fireEvent.keyDown(input, { key: 'ArrowDown' })
    scrollByHand(list, 300)

    rerender()
    rerender()

    expect(writes).toEqual([])
    expect(list.scrollTop).toBe(300)
    expect(active(input)).toMatchObject({ label: label(3), painted: true })
  })

  it('follows the keyboard again from the next key press', async () => {
    const { input, list, rerender } = await openPicker()
    for (let step = 0; step < 3; step++) fireEvent.keyDown(input, { key: 'ArrowDown' })
    scrollByHand(list, 300)
    rerender()

    fireEvent.keyDown(input, { key: 'ArrowUp' })

    expect(active(input)).toEqual(shown(2))
  })

  it('goes back to the last option on End, even when it is already highlighted', async () => {
    const { input, list } = await openPicker()
    fireEvent.keyDown(input, { key: 'End' })
    scrollByHand(list, 0)

    fireEvent.keyDown(input, { key: 'End' })

    expect(active(input)).toEqual(shown(LAST))
  })

  it('goes back to the first option on Home, even when it is already highlighted', async () => {
    const { input, list } = await openPicker()
    scrollByHand(list, 600)

    fireEvent.keyDown(input, { key: 'Home' })

    expect(active(input)).toEqual(shown(0))
  })

  it('shows the first match of a filter typed after scrolling', async () => {
    const { input, list } = await openPicker()
    scrollByHand(list, 600)

    fireEvent.change(input, { target: { value: 'Patient 1' } })

    expect(active(input)).toEqual(shown(10))
  })
})

describe('the floor under a list that nothing clips', () => {
  /** jsdom lays nothing out, so every rect is zero unless it is stated. */
  function stubRect(element: Element, top: number, bottom: number) {
    element.getBoundingClientRect = () =>
      ({ top, bottom, left: 0, right: 320, width: 320, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
  }

  function drawnAtBottom(element: Element | null) {
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => element,
    })
  }

  /** A 320×568 phone: the field ends at 390, a bar is fixed at `barTop`. */
  function renderOnPhone(barTop: number) {
    window.innerHeight = 568
    render(
      <>
        <Harness />
        <div data-testid="content">Page content</div>
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

  it('stops above a bar fixed over the bottom of the screen', async () => {
    // Measured to the window, the list ran 61px underneath the bar.
    const input = renderOnPhone(503)
    drawnAtBottom(screen.getByTestId('bar-item'))

    await openAndMeasure(input)

    // 503 − 390 − 8, not 568 − 390 − 8.
    expect(screen.getByRole('listbox').style.maxHeight).toBe('105px')
  })

  it('leaves the window as the floor where ordinary content is at the bottom', async () => {
    // A desktop page: nothing fixed is drawn there, so nothing changes.
    const input = renderOnPhone(503)
    drawnAtBottom(screen.getByTestId('content'))

    await openAndMeasure(input)

    expect(screen.getByRole('listbox').style.maxHeight).toBe('170px')
  })

  it('ignores a fixed element that starts above the field', async () => {
    const input = renderOnPhone(300)
    drawnAtBottom(screen.getByTestId('bar'))

    await openAndMeasure(input)

    expect(screen.getByRole('listbox').style.maxHeight).toBe('170px')
  })

  it('changes nothing when what is drawn at the bottom is the list itself', async () => {
    const input = renderOnPhone(503)
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => document.querySelector('[role="listbox"] [role="option"]'),
    })

    await openAndMeasure(input)

    expect(screen.getByRole('listbox').style.maxHeight).toBe('170px')
  })

  it('never consults the bar inside a clipping container', async () => {
    // The scheduling dialog: its body clips the list and sits in the top
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
    drawnAtBottom(screen.getByTestId('bar'))

    await openAndMeasure(input)

    // 530 − 390 − 8: the container, never the bar.
    expect(screen.getByRole('listbox').style.maxHeight).toBe('132px')
  })
})
