import { AlertCircle, Check, ChevronDown } from 'lucide-react'
import {
  createContext,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'

import { cn } from '@/lib/utils'

/**
 * Form field primitives.
 *
 * Three accessibility rules are enforced structurally here rather than left
 * to each form to remember:
 *
 *  1. Labels are always visible. A placeholder is not a label — it disappears
 *     the moment someone types, which is exactly when a user filling in a
 *     long medical form needs to check what a field was asking for.
 *  2. The error message sits next to its field, not in a summary at the top,
 *     and is wired to the input with `aria-describedby` so a screen reader
 *     reads it as part of the field.
 *  3. Invalid fields carry `aria-invalid`, so the error is conveyed by more
 *     than a red border.
 */

type FieldContextValue = {
  inputId: string
  descriptionId: string
  errorId: string
  hasError: boolean
  hasDescription: boolean
}

const FieldContext = createContext<FieldContextValue | null>(null)

function useFieldContext(component: string): FieldContextValue {
  const context = useContext(FieldContext)
  if (!context) {
    throw new Error(`<${component}> must be rendered inside a <Field>.`)
  }
  return context
}

export type FieldProps = {
  label: string
  /** Helper text shown under the label, before the control. */
  description?: string
  error?: string | undefined
  required?: boolean
  className?: string
  children: ReactNode
}

export function Field({
  label,
  description,
  error,
  required = false,
  className,
  children,
}: FieldProps) {
  const id = useId()
  const value: FieldContextValue = {
    inputId: `${id}-input`,
    descriptionId: `${id}-description`,
    errorId: `${id}-error`,
    hasError: Boolean(error),
    hasDescription: Boolean(description),
  }

  return (
    <FieldContext.Provider value={value}>
      <div className={cn('space-y-1.5', className)}>
        <label
          htmlFor={value.inputId}
          className="block text-sm font-medium text-heading"
        >
          {label}
          {required ? (
            <>
              <span aria-hidden="true" className="ml-0.5 text-danger-700">
                *
              </span>
              <span className="sr-only"> (required)</span>
            </>
          ) : null}
        </label>

        {description ? (
          <p id={value.descriptionId} className="text-sm text-muted">
            {description}
          </p>
        ) : null}

        {children}

        {error ? (
          // role="alert" so the message is announced when it appears after a
          // failed submit, not only when the field is focused.
          <p
            id={value.errorId}
            role="alert"
            className="flex items-start gap-1.5 text-sm font-medium text-danger-700"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {error}
          </p>
        ) : null}
      </div>
    </FieldContext.Provider>
  )
}

const controlClasses = [
  'block w-full rounded-[var(--radius-md)] bg-surface',
  'border border-[var(--color-border-strong)]',
  'px-3 text-base text-heading placeholder:text-muted',
  'transition-colors duration-[var(--duration-fast)]',
  'hover:border-neutral-400',
  'disabled:cursor-not-allowed disabled:bg-neutral-100 disabled:text-muted',
  'aria-[invalid=true]:border-danger-700',
].join(' ')

function describedBy(context: FieldContextValue): string | undefined {
  const ids = [
    context.hasDescription ? context.descriptionId : null,
    context.hasError ? context.errorId : null,
  ].filter(Boolean)

  return ids.length > 0 ? ids.join(' ') : undefined
}

export function Input({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  const context = useFieldContext('Input')

  return (
    <input
      id={context.inputId}
      aria-invalid={context.hasError || undefined}
      aria-describedby={describedBy(context)}
      className={cn(controlClasses, 'h-11', className)}
      {...props}
    />
  )
}

export function Textarea({
  className,
  rows = 4,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const context = useFieldContext('Textarea')

  return (
    <textarea
      id={context.inputId}
      rows={rows}
      aria-invalid={context.hasError || undefined}
      aria-describedby={describedBy(context)}
      className={cn(controlClasses, 'py-2.5 leading-relaxed', className)}
      {...props}
    />
  )
}

export function Select({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  const context = useFieldContext('Select')

  return (
    <select
      id={context.inputId}
      aria-invalid={context.hasError || undefined}
      aria-describedby={describedBy(context)}
      className={cn(controlClasses, 'h-11', className)}
      {...props}
    >
      {children}
    </select>
  )
}

export type ComboboxOption = { value: string; label: string }

/** Tallest the list is ever allowed to be, room permitting. */
const DEFAULT_LIST_MAX_HEIGHT = 256
/** Two rows. Below this a list is more annoying than a scroll. */
const MIN_LIST_MAX_HEIGHT = 88
/** Breathing room so the list never sits flush against the clip edge. */
const LIST_GUTTER = 8

/**
 * Top of a fixed element drawn over the bottom edge of the screen beneath
 * `field` — the mobile navigation bar — or the viewport bottom if none is.
 *
 * Found by asking what is actually painted at the bottom edge, so no page or
 * component has to know the bar exists. A fixed element that holds the field
 * itself is the field's own container, not something drawn over it, and one
 * that starts above the field cannot be the floor beneath it.
 */
function fixedBarTopBelow(field: HTMLElement): number {
  const viewportBottom = window.innerHeight
  if (typeof document.elementFromPoint !== 'function') return viewportBottom

  const rect = field.getBoundingClientRect()
  const x = Math.min(
    Math.max(rect.left + rect.width / 2, 0),
    window.innerWidth - 1,
  )
  let hit = document.elementFromPoint(x, viewportBottom - 1)
  while (hit && hit !== document.body) {
    if (hit.contains(field)) return viewportBottom
    if (getComputedStyle(hit).position === 'fixed') {
      const top = hit.getBoundingClientRect().top
      return top > rect.bottom ? top : viewportBottom
    }
    hit = hit.parentElement
  }
  return viewportBottom
}

export function Combobox({
  options,
  value,
  onChange,
  placeholder,
  emptyLabel = 'No matches',
  id,
}: {
  options: ComboboxOption[]
  value: string
  onChange: (value: string) => void
  placeholder?: string
  /** Shown when the filter excludes everything. */
  emptyLabel?: string
  id?: string
}) {
  // Joins the surrounding <Field> exactly as Input and Select do, so the
  // label points at this input and the description and error are announced
  // with it. Minting its own id here would leave the label pointing at
  // nothing, which is a control a screen reader cannot name.
  const context = useFieldContext('Combobox')
  const inputId = id ?? context.inputId
  const listId = `${inputId}-listbox`

  const [isOpen, setOpen] = useState(false)
  const field = useRef<HTMLDivElement>(null)
  /** Room below the field, or null before it has been measured. */
  const [listMaxHeight, setListMaxHeight] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const list = useRef<HTMLUListElement>(null)

  // Scrolling the list to the active option is something an action asks for
  // — opening, a key press, typing — once, never a mode left switched on.
  // Each such action bumps `revealRequest`; the effect below honours each
  // request exactly once and records it in `revealed`. A re-render, a fresh
  // `options` array or the pointer moving the highlight asks for nothing, so
  // none of them can scroll the list, and a list the user has scrolled by
  // hand stays where they left it.
  //
  // A counter rather than a flag, so that every request renders: End on the
  // option already active changes no other state, but must still bring it
  // back into view after a wheel scroll.
  const [revealRequest, setRevealRequest] = useState(0)
  const revealed = useRef(0)
  const requestReveal = () => setRevealRequest((count) => count + 1)

  // Where the pointer last moved over the list. See `pointTo`.
  const pointer = useRef<{ x: number; y: number } | null>(null)

  const selected = options.find((option) => option.value === value) ?? null

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return options
    return options.filter((option) =>
      option.label.toLowerCase().includes(needle),
    )
  }, [options, query])

  // While closed the input shows the chosen label; while open it shows what
  // is being typed, so the filter is visible as it narrows.
  const shown = isOpen ? query : (selected?.label ?? '')

  const open = () => {
    if (isOpen) return
    setQuery('')
    setActiveIndex(Math.max(0, matches.findIndex((o) => o.value === value)))
    setOpen(true)
    requestReveal()
    // Where the pointer was the last time the list was open says nothing
    // about where it is now.
    pointer.current = null

    // The list is absolutely positioned, so the nearest ancestor with a
    // non-visible overflow clips it. Inside a dialog body
    // (`max-h-[70dvh] overflow-y-auto`) roughly 128px sits below this field
    // against a list that grows to 256px, so half of a full caseload was cut
    // off and unreachable — on every viewport, and precisely in the case the
    // search exists for.
    //
    // Scrolling the field up does not help: that body is not actually
    // scrollable (its content fits, the max-height is never reached), and an
    // overflow container clips whether or not it scrolls. So the list is
    // sized to the room that is actually there instead. It already scrolls
    // internally, so every option stays reachable — nothing is repositioned
    // and nothing needs to know where it sits on screen.
    requestAnimationFrame(() => {
      setListMaxHeight(spaceBelowField())
      // The measured height can be shorter than the one the first reveal ran
      // against, which would hide the option again.
      requestReveal()
    })
  }

  /**
   * Pixels between the bottom of the field and the bottom of whatever would
   * clip the list. Falls back to the viewport when nothing clips.
   */
  const spaceBelowField = (): number => {
    const node = field.current
    if (!node) return DEFAULT_LIST_MAX_HEIGHT

    let clipper: HTMLElement | null = node.parentElement
    while (clipper) {
      const overflow = getComputedStyle(clipper).overflowY
      if (overflow !== 'visible') break
      clipper = clipper.parentElement
    }

    // With nothing clipping it, the list can still be painted over: the
    // mobile navigation bar is fixed to the bottom of the screen and sits
    // above it, so on a short phone the last options were under the bar and
    // could be neither seen nor tapped. Inside a clipping container — the
    // scheduling dialog, which is in the top layer above the bar — the bar
    // is not consulted.
    const floor = clipper
      ? clipper.getBoundingClientRect().bottom
      : Math.min(window.innerHeight, fixedBarTopBelow(node))
    const room = floor - node.getBoundingClientRect().bottom - LIST_GUTTER

    // Never smaller than two rows: a one-line list is worse than a scroll.
    return Math.max(MIN_LIST_MAX_HEIGHT, Math.min(DEFAULT_LIST_MAX_HEIGHT, room))
  }

  const close = () => {
    setOpen(false)
    setQuery('')
    setListMaxHeight(null)
  }

  const commit = (option: ComboboxOption) => {
    onChange(option.value)
    close()
  }

  // Keeps the active option on screen when an action asks for it. The
  // highlight and `aria-activedescendant` were always right — a screen
  // reader heard the correct option — but nothing scrolled the list, so past
  // the last visible row a sighted keyboard user was choosing blind.
  //
  // This sets the list's own `scrollTop` rather than calling
  // `scrollIntoView`, which also scrolls every scrollable ancestor: inside
  // the scheduling dialog that would shift the dialog body, and on a page it
  // would scroll the page.
  //
  // It is keyed on the request, never on `matches`. Both callers build their
  // options inline, so every render of their page is a new array; an effect
  // keyed on it scrolled the list back to the highlight whenever the page
  // re-rendered — on Reports, each time the tab regained focus.
  useLayoutEffect(() => {
    if (!isOpen || revealRequest === revealed.current) return
    revealed.current = revealRequest

    const listNode = list.current
    const option =
      listNode?.querySelectorAll<HTMLElement>('[role="option"]')[activeIndex]
    if (!listNode || !option) return

    const top = option.offsetTop
    const bottom = top + option.offsetHeight
    if (top < listNode.scrollTop) {
      listNode.scrollTop = top
    } else if (bottom > listNode.scrollTop + listNode.clientHeight) {
      listNode.scrollTop = bottom - listNode.clientHeight
    }
  }, [isOpen, activeIndex, revealRequest])

  /**
   * Moves the highlight to the option under the pointer — when the pointer
   * has actually moved.
   *
   * Hover is not movement. When the list scrolls beneath a pointer that is
   * standing still, because End scrolled it or a wheel did, the browser
   * tells the row now under it that the pointer is over it: Chrome sends
   * mouseover and mouseenter, and some engines add a mousemove repeating the
   * pointer's position. Taken for pointing, that let a resting pointer take
   * the keyboard's highlight, and Enter chose a different patient from the
   * one the keyboard had highlighted. So only a mousemove to a new position
   * counts, and the first one after opening only records where the pointer
   * is — it may be the browser repeating where it rests. It never scrolls:
   * the pointer is already where the option is.
   */
  const pointTo = (index: number, event: MouseEvent<HTMLLIElement>) => {
    const last = pointer.current
    pointer.current = { x: event.clientX, y: event.clientY }
    if (!last || (last.x === event.clientX && last.y === event.clientY)) return
    setActiveIndex(index)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!isOpen) {
        open()
        return
      }
      if (matches.length === 0) return
      requestReveal()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActiveIndex(
        (current) => (current + step + matches.length) % matches.length,
      )
      return
    }

    if (event.key === 'Home' && isOpen) {
      event.preventDefault()
      requestReveal()
      setActiveIndex(0)
      return
    }
    if (event.key === 'End' && isOpen) {
      event.preventDefault()
      requestReveal()
      setActiveIndex(Math.max(0, matches.length - 1))
      return
    }

    if (event.key === 'Enter' && isOpen) {
      const option = matches[activeIndex]
      if (option) {
        event.preventDefault()
        commit(option)
      }
      return
    }

    if (event.key === 'Escape' && isOpen) {
      event.preventDefault()
      // Closes without choosing: the previous value stands.
      close()
    }
  }

  return (
    <div className="relative" ref={field}>
      <input
        id={inputId}
        type="text"
        role="combobox"
        aria-expanded={isOpen}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          isOpen && matches[activeIndex]
            ? `${listId}-${matches[activeIndex].value}`
            : undefined
        }
        autoComplete="off"
        placeholder={placeholder}
        value={shown}
        onChange={(event) => {
          if (!isOpen) setOpen(true)
          setQuery(event.target.value)
          setActiveIndex(0)
          requestReveal()
        }}
        onFocus={open}
        onClick={open}
        onKeyDown={onKeyDown}
        onBlur={() => {
          // Deferred so a click on an option lands before the list unmounts.
          blurTimer.current = setTimeout(close, 120)
        }}
        aria-invalid={context.hasError || undefined}
        aria-describedby={describedBy(context)}
        className={cn(controlClasses, 'h-11 pr-10')}
      />

      <ChevronDown
        className="pointer-events-none absolute inset-y-0 right-3 my-auto size-5 text-muted"
        aria-hidden="true"
      />

      {isOpen ? (
        <ul
          ref={list}
          id={listId}
          role="listbox"
          style={{ maxHeight: listMaxHeight ?? DEFAULT_LIST_MAX_HEIGHT }}
          className="absolute z-10 mt-1 w-full overflow-auto rounded-[var(--radius-md)] border border-[var(--color-border)] bg-surface py-1 shadow-lg"
        >
          {matches.length === 0 ? (
            <li className="px-3 py-2 text-sm text-muted">{emptyLabel}</li>
          ) : (
            matches.map((option, index) => (
              <li
                key={option.value}
                id={`${listId}-${option.value}`}
                role="option"
                aria-selected={option.value === value}
                onMouseDown={(event) => {
                  // Before blur, so the selection is not lost to the close.
                  event.preventDefault()
                  if (blurTimer.current) clearTimeout(blurTimer.current)
                  commit(option)
                }}
                onMouseMove={(event) => pointTo(index, event)}
                className={`flex min-h-11 cursor-pointer items-center justify-between gap-2 px-3 text-body ${
                  index === activeIndex
                    ? 'bg-brand-50 text-brand-800'
                    : 'text-heading'
                }`}
              >
                {option.label}
                {option.value === value ? (
                  <Check className="size-4 shrink-0" aria-hidden="true" />
                ) : null}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  )
}
