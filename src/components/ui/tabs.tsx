import { useId, useRef, type ReactNode } from 'react'

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

    onChange(nextTab.id)
    listRef.current
      ?.querySelector<HTMLButtonElement>(`#${CSS.escape(`${baseId}-tab-${nextTab.id}`)}`)
      ?.focus()
  }

  return (
    <div>
      <div
        ref={listRef}
        role="tablist"
        onKeyDown={onKeyDown}
        // Scrollable rather than wrapping, so a long tab list on a phone stays
        // one row instead of pushing the panel off screen.
        className="-mx-4 flex gap-1 overflow-x-auto border-b border-[var(--color-border)] px-4 sm:mx-0 sm:px-0"
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
                'shrink-0 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors',
                isSelected
                  ? 'border-brand-600 text-brand-700'
                  : 'border-transparent text-muted hover:text-heading',
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
