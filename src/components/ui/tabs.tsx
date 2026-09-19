import { ChevronRight } from 'lucide-react'
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import { cn } from '@/lib/utils'

export type TabDefinition<T extends string> = {
  id: T
  label: string
  count?: number
}

/**
 * A tab list following the ARIA authoring practice.
 *
 * Only the selected tab is a tab stop, and arrow keys move between them.
 * Making every tab tabbable is the common shortcut and it forces a keyboard
 * user to walk through every tab to reach the panel below.
 *
 * RecoverEase 2.0 - nothing hides past an edge:
 *
 * - More than four tabs on a phone become a three-column segmented grid. At
 *   390px a scrolling row showed four of the patient record's six tabs and
 *   gave no sign the other two existed; Notes and Chat - where a flagged
 *   conversation is read - were reachable only by guessing to swipe. Two rows
 *   of three put every destination on screen, each a 44px target.
 * - Otherwise the row scrolls, and says so: a fade and a chevron sit on
 *   whichever edge has more tabs behind it, and the selected tab is kept in
 *   view as it changes.
 *
 * The selected tab's underline slides to its new tab (120ms, transform
 * only), so the eye follows the change instead of losing it. It is written to
 * the DOM rather than kept in state, and until it has been measured each tab
 * keeps its own underline - so without script layout, or where measuring
 * fails, the selection is still marked.
 */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  children,
}: {
  tabs: readonly TabDefinition<T>[]
  value: T
  onChange: (value: T) => void
  children: ReactNode
}) {
  const baseId = useId()
  const listRef = useRef<HTMLDivElement>(null)
  const indicatorRef = useRef<HTMLSpanElement>(null)
  const [overflow, setOverflow] = useState({ start: false, end: false })
  const isGridOnPhone = tabs.length > 4

  // Which edges have tabs hidden behind them. Measured from the observer's
  // callback - which runs once on observe and again on every resize - and on
  // scroll, so the cue always describes what is actually off screen.
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const measure = () => {
      const hidden = list.scrollWidth - list.clientWidth
      setOverflow({
        start: list.scrollLeft > 1,
        end: hidden > 1 && list.scrollLeft < hidden - 1,
      })
    }
    // Where ResizeObserver is missing (older browsers, and jsdom) the cue
    // falls back to scroll and window resizes: an enhancement, never a
    // requirement for reaching a tab.
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(list)
    list.addEventListener('scroll', measure, { passive: true })
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      list.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
    }
  }, [])

  // Slide the underline to the selected tab. The first placement is not
  // animated - it would sweep in from the left edge on every page load.
  useLayoutEffect(() => {
    const list = listRef.current
    const bar = indicatorRef.current
    if (!list || !bar) return
    const place = () => {
      const selected = list.querySelector<HTMLElement>('[aria-selected="true"]')
      if (!selected || selected.offsetWidth === 0) {
        list.dataset['indicator'] = 'off'
        return
      }
      bar.style.transform = `translateX(${selected.offsetLeft}px) scaleX(${selected.offsetWidth / 100})`
      list.dataset['indicator'] = 'on'
    }
    place()
    const frame = requestAnimationFrame(() => {
      bar.dataset['ready'] = 'true'
    })
    window.addEventListener('resize', place)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', place)
    }
  }, [value])

  // Keep the selected tab inside the visible part of a scrolling row. Written
  // against scrollLeft rather than scrollIntoView, which would also scroll
  // the page vertically.
  useEffect(() => {
    const list = listRef.current
    const selected = list?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!list || !selected || list.scrollWidth <= list.clientWidth) return
    const listBox = list.getBoundingClientRect()
    const tabBox = selected.getBoundingClientRect()
    const margin = 32
    if (tabBox.right > listBox.right - margin) {
      list.scrollLeft += tabBox.right - listBox.right + margin
    } else if (tabBox.left < listBox.left + margin) {
      list.scrollLeft -= listBox.left + margin - tabBox.left
    }
  }, [value])

  const onKeyDown = (event: React.KeyboardEvent) => {
    const currentIndex = tabs.findIndex((tab) => tab.id === value)
    if (currentIndex === -1) return

    let nextIndex: number | null = null
    if (event.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % tabs.length
    } else if (event.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + tabs.length) % tabs.length
    } else if (event.key === 'Home') {
      nextIndex = 0
    } else if (event.key === 'End') {
      nextIndex = tabs.length - 1
    }

    if (nextIndex === null) return
    event.preventDefault()
    const nextTab = tabs[nextIndex]
    if (!nextTab) return
    // A keyboard change moves the underline instantly: motion on a
    // keystroke only slows down someone moving at the speed of their keys.
    // The next frame re-enables the slide for pointer changes.
    delete indicatorRef.current?.dataset['ready']
    onChange(nextTab.id)
    listRef.current
      ?.querySelector<HTMLButtonElement>(`#${CSS.escape(`${baseId}-tab-${nextTab.id}`)}`)
      ?.focus()
  }

  return (
    <div>
      <div className="relative print:hidden">
        <div
          ref={listRef}
          role="tablist"
          onKeyDown={onKeyDown}
          // Controls, so never on paper: a printout is the panel's content
          // alone.
          data-indicator="off"
          className={cn(
            'group/tabs relative flex gap-1 overflow-x-auto border-b border-[var(--color-border)] [scrollbar-width:none]',
            isGridOnPhone
              ? 'max-sm:grid max-sm:grid-cols-3 max-sm:overflow-visible max-sm:rounded-[var(--radius-lg)] max-sm:border-b-0 max-sm:bg-surface-sunken max-sm:p-1'
              : '-mx-4 px-4 sm:mx-0 sm:px-0',
          )}
        >
          {tabs.map((tab) => {
            const isSelected = tab.id === value
            return (
              <button
                key={tab.id}
                id={`${baseId}-tab-${tab.id}`}
                role="tab"
                type="button"
                aria-selected={isSelected}
                aria-controls={`${baseId}-panel-${tab.id}`}
                tabIndex={isSelected ? 0 : -1}
                onClick={() => onChange(tab.id)}
                className={cn(
                  'shrink-0 whitespace-nowrap border-b-2 px-3 py-3 text-sm font-medium transition-colors duration-[var(--duration-fast)] sm:py-2.5',
                  isSelected
                    ? // Its own underline, until the sliding one has been
                      // placed.
                      'border-[var(--color-role)] font-semibold text-role-strong group-data-[indicator=on]/tabs:border-transparent'
                    : 'border-transparent text-muted hover:text-heading',
                  isGridOnPhone &&
                    cn(
                      'max-sm:min-h-11 max-sm:rounded-[var(--radius-md)] max-sm:border-b-0 max-sm:px-2 max-sm:py-2',
                      isSelected &&
                        'max-sm:bg-surface max-sm:shadow-[var(--shadow-sm)]',
                    ),
                )}
              >
                {tab.label}
                {typeof tab.count === 'number' ? (
                  <span
                    className="ml-1.5 rounded-full bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-600"
                    data-numeric
                  >
                    {tab.count}
                  </span>
                ) : null}
              </button>
            )
          })}
          {/* 100px wide, scaled to the tab's width: transform only. */}
          <span
            ref={indicatorRef}
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute bottom-0 left-0 h-0.5 w-[100px] origin-left bg-[var(--color-role)] opacity-0 group-data-[indicator=on]/tabs:opacity-100',
              'data-[ready=true]:transition-transform data-[ready=true]:duration-[var(--duration-fast)] data-[ready=true]:ease-[var(--ease-in-out)]',
              isGridOnPhone && 'max-sm:hidden',
            )}
          />
        </div>

        {/* The overflow cue. Decorative: every tab is still in the tab
            order and announced, so this only helps the eye find them. */}
        {overflow.start ? (
          <span
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-canvas to-transparent',
              isGridOnPhone ? 'max-sm:hidden' : '-left-4 sm:left-0',
            )}
          />
        ) : null}
        {overflow.end ? (
          <span
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute inset-y-0 right-0 flex w-12 items-center justify-end bg-gradient-to-l from-canvas from-40% to-transparent',
              isGridOnPhone ? 'max-sm:hidden' : '-right-4 pr-2 sm:right-0 sm:pr-0',
            )}
          >
            <ChevronRight className="size-4 text-muted" />
          </span>
        ) : null}
      </div>

      <div
        role="tabpanel"
        id={`${baseId}-panel-${value}`}
        aria-labelledby={`${baseId}-tab-${value}`}
        tabIndex={0}
        className="pt-5"
      >
        {children}
      </div>
    </div>
  )
}
