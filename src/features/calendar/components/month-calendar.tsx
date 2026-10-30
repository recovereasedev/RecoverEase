import { CalendarDays, ChevronLeft, ChevronRight, Pill, Smile, type LucideIcon } from 'lucide-react'
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'

import { InlineEmpty } from '@/components/feedback/state-view'
import { StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  addDays,
  daySummary,
  firstOfMonth,
  longDay,
  monthOf,
  monthTitle,
  monthWeeks,
  shiftMonth,
  weekday,
  type CalendarEvent,
  type CalendarEventKind,
  type MonthKey,
} from '@/features/calendar/calendar-model'
import { cn } from '@/lib/utils'

/**
 * The month, as a grid of days, beside the chosen day's events.
 *
 * A grid in the ARIA sense: one day is the tab stop, the arrow keys move a
 * day or a week, Home and End go to the start or end of the week, and Page
 * Up and Page Down go a month back or forward - into the next month's grid
 * when the day falls outside this one. The chosen day follows the keyboard,
 * and the panel beside the grid lists that day's events.
 *
 * Every day says what it holds in words - "3 medicine doses, 1 appointment"
 * - so nothing depends on the colour of a chip or a dot, and each kind has
 * its own icon as well as its own colour.
 */

export const KIND: Record<
  CalendarEventKind,
  { label: string; icon: LucideIcon; chip: string; dot: string; tile: string }
> = {
  dose: {
    label: 'Medicine',
    icon: Pill,
    chip: 'bg-success-50 text-success-700',
    dot: 'bg-fill-success-600',
    tile: 'bg-success-50 text-success-700',
  },
  appointment: {
    label: 'Appointment',
    icon: CalendarDays,
    chip: 'bg-info-50 text-info-700',
    dot: 'bg-info-600',
    tile: 'bg-info-50 text-info-700',
  },
  mood: {
    label: 'Mood check-in',
    icon: Smile,
    chip: 'bg-warning-50 text-warning-700',
    dot: 'bg-warning-600',
    tile: 'bg-warning-50 text-warning-700',
  },
}

const WEEKDAYS = [
  ['Sun', 'Sunday'],
  ['Mon', 'Monday'],
  ['Tue', 'Tuesday'],
  ['Wed', 'Wednesday'],
  ['Thu', 'Thursday'],
  ['Fri', 'Friday'],
  ['Sat', 'Saturday'],
] as const

/** How many of a day's events a cell shows before "+n more". */
const CELL_LIMIT = 3

export function CalendarLegend({ kinds }: { kinds: readonly CalendarEventKind[] }) {
  return (
    <ul aria-label="What the calendar shows" className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-body">
      {kinds.map((kind) => {
        const { label, icon: Icon, tile } = KIND[kind]
        return (
          <li key={kind} className="flex items-center gap-2">
            <span className={cn('flex size-6 items-center justify-center rounded-[var(--radius-sm)]', tile)}>
              <Icon className="size-3.5" aria-hidden="true" />
            </span>
            {label}
          </li>
        )
      })}
    </ul>
  )
}

export function MonthCalendar({
  month,
  selectedDay,
  today,
  eventsByDay,
  onSelectDay,
  onMonthChange,
  busy = false,
}: {
  month: MonthKey
  selectedDay: string
  today: string
  eventsByDay: Map<string, CalendarEvent[]>
  onSelectDay: (day: string) => void
  onMonthChange: (month: MonthKey) => void
  /** The month's records are still being read; its days are shown meanwhile. */
  busy?: boolean
}) {
  const titleId = useId()
  const weeks = monthWeeks(month)
  const gridRef = useRef<HTMLTableElement>(null)
  // Set when the keyboard moved the chosen day, so focus follows it - and
  // only then: choosing a month with the buttons must not pull focus here.
  const moveFocus = useRef(false)

  useEffect(() => {
    if (!moveFocus.current) return
    moveFocus.current = false
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${selectedDay}"]`)?.focus()
  }, [selectedDay, month])

  const go = (day: string) => {
    moveFocus.current = true
    const target = monthOf(day)
    if (target.year !== month.year || target.month !== month.month) {
      // Into a neighbouring month only when the day is not on this grid.
      const onGrid = weeks.some((week) => week.includes(day))
      if (!onGrid) onMonthChange(target)
    }
    onSelectDay(day)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    const moves: Record<string, () => string> = {
      ArrowLeft: () => addDays(selectedDay, -1),
      ArrowRight: () => addDays(selectedDay, 1),
      ArrowUp: () => addDays(selectedDay, -7),
      ArrowDown: () => addDays(selectedDay, 7),
      Home: () => addDays(selectedDay, -weekday(selectedDay)),
      End: () => addDays(selectedDay, 6 - weekday(selectedDay)),
      PageUp: () => sameDayIn(shiftMonth(monthOf(selectedDay), -1), selectedDay),
      PageDown: () => sameDayIn(shiftMonth(monthOf(selectedDay), 1), selectedDay),
    }
    const move = moves[event.key]
    if (!move) return
    event.preventDefault()
    go(move())
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 id={titleId} className="text-lg font-semibold text-heading" aria-live="polite">
          {monthTitle(month)}
        </h2>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              onMonthChange(monthOf(today))
              onSelectDay(today)
            }}
          >
            Today
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label="Previous month"
            onClick={() => {
              const previous = shiftMonth(month, -1)
              onMonthChange(previous)
              onSelectDay(firstOfMonth(previous))
            }}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label="Next month"
            onClick={() => {
              const next = shiftMonth(month, 1)
              onMonthChange(next)
              onSelectDay(firstOfMonth(next))
            }}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
        </div>
      </div>

      <p role="status" className="mb-2 text-sm text-muted empty:hidden">
        {busy ? 'Loading this month…' : null}
      </p>
      <table
        ref={gridRef}
        role="grid"
        aria-labelledby={titleId}
        aria-busy={busy}
        className="w-full table-fixed border-separate border-spacing-0 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)]"
        onKeyDown={onKeyDown}
      >
        <thead>
          <tr>
            {WEEKDAYS.map(([short, long]) => (
              <th
                key={short}
                scope="col"
                abbr={long}
                className="border-b border-[var(--color-border)] bg-surface-sunken py-2 text-center text-xs font-semibold text-muted"
              >
                {short}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week[0]}>
              {week.map((day) => {
                const events = eventsByDay.get(day) ?? []
                const inMonth = monthOf(day).month === month.month
                const isSelected = day === selectedDay
                const isToday = day === today
                return (
                  <td
                    key={day}
                    role="gridcell"
                    aria-selected={isSelected}
                    className="border-b border-r border-[var(--color-border)] p-0 align-top last:border-r-0 [tr:last-child_&]:border-b-0"
                  >
                    <button
                      type="button"
                      data-day={day}
                      tabIndex={isSelected ? 0 : -1}
                      aria-current={isToday ? 'date' : undefined}
                      aria-label={`${longDay(day)}${isToday ? ', today' : ''}: ${daySummary(events)}`}
                      onClick={() => onSelectDay(day)}
                      className={cn(
                        'flex h-full min-h-14 w-full flex-col items-stretch gap-1 p-1.5 text-left transition-colors sm:min-h-24 sm:p-2',
                        // The app's own ring, drawn inside the cell so the grid's edges never clip it.
                        'focus-visible:relative focus-visible:z-10 focus-visible:-outline-offset-2',
                        inMonth ? 'bg-surface hover:bg-neutral-50' : 'bg-neutral-50 text-muted hover:bg-neutral-100',
                        isSelected && 'bg-role-soft hover:bg-role-soft',
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          'flex size-7 items-center justify-center self-center rounded-full text-sm sm:self-start',
                          isToday ? 'bg-fill-brand-800 font-semibold text-white' : inMonth ? 'text-heading' : 'text-muted',
                        )}
                      >
                        {Number(day.slice(8))}
                      </span>

                      {/* On a phone, a dot per kind the day holds. */}
                      <span aria-hidden="true" className="flex justify-center gap-1 sm:hidden">
                        {(['dose', 'appointment', 'mood'] as const)
                          .filter((kind) => events.some((event) => event.kind === kind))
                          .map((kind) => (
                            <span key={kind} className={cn('size-1.5 rounded-full', KIND[kind].dot)} />
                          ))}
                      </span>

                      {/* From a small tablet up, the first few events themselves. */}
                      <span aria-hidden="true" className="hidden flex-col gap-1 sm:flex">
                        {events.slice(0, CELL_LIMIT).map((event) => (
                          <EventChip key={event.id} event={event} />
                        ))}
                        {events.length > CELL_LIMIT ? (
                          <span className="px-1 text-xs font-medium text-muted">
                            +{events.length - CELL_LIMIT} more
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** The same day of the month in `month`, or its last day if `day`'s is past it. */
function sameDayIn(month: MonthKey, day: string): string {
  const last = Number(addDays(firstOfMonth(shiftMonth(month, 1)), -1).slice(8))
  const date = Math.min(Number(day.slice(8)), last)
  return `${firstOfMonth(month).slice(0, 8)}${String(date).padStart(2, '0')}`
}

/** A cell's short form of an event: the full one is in the day's label and panel. */
function chipText(event: CalendarEvent): string {
  switch (event.kind) {
    case 'dose':
      return `${event.time} ${event.title.split(',')[0]}`
    case 'appointment':
      return `${event.time} Visit`
    case 'mood':
      return 'Mood'
  }
}

function EventChip({ event }: { event: CalendarEvent }) {
  const { icon: Icon, chip } = KIND[event.kind]
  return (
    <span
      className={cn(
        'flex min-w-0 items-center gap-1 rounded-[var(--radius-sm)] px-1.5 py-0.5 text-xs font-medium',
        chip,
      )}
    >
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{chipText(event)}</span>
    </span>
  )
}

/** The chosen day's events, in order, each with what was recorded. */
export function DayAgenda({
  day,
  today,
  events,
  note,
  renderAction,
}: {
  day: string
  today: string
  events: readonly CalendarEvent[]
  /** Said under the list, e.g. why later doses are not on the calendar yet. */
  note?: ReactNode
  /** A link beside an event, e.g. the patient's record for a doctor. */
  renderAction?: (event: CalendarEvent) => ReactNode
}) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="text-base font-semibold text-heading">
        {longDay(day)}
        {day === today ? <span className="ml-2 text-sm font-medium text-role-strong">Today</span> : null}
      </h2>
      <p className="mt-0.5 text-sm text-muted">{daySummary(events)}</p>

      {events.length === 0 ? (
        <InlineEmpty icon={CalendarDays} className="mt-4">
          Nothing on this day.
        </InlineEmpty>
      ) : (
        <ul className="mt-4 divide-y divide-[var(--color-border)]">
          {events.map((event) => {
            const { icon: Icon, tile, label } = KIND[event.kind]
            return (
              <li key={event.id} className="flex items-start gap-3 py-3 first:pt-0">
                <span
                  className={cn('mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-md)]', tile)}
                >
                  <Icon className="size-4" aria-hidden="true" />
                  <span className="sr-only">{label}</span>
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-muted tabular-nums">
                    {event.time ?? 'Recorded for the day'}
                  </p>
                  <p className="text-sm font-semibold text-heading">{event.title}</p>
                  {event.detail ? <p className="mt-0.5 text-sm text-body">{event.detail}</p> : null}
                  {renderAction ? <div className="mt-1.5">{renderAction(event)}</div> : null}
                </div>
                {event.status ? <StatusBadge status={event.status} className="shrink-0" /> : null}
              </li>
            )
          })}
        </ul>
      )}
      {note ? <p className="mt-4 text-sm text-muted">{note}</p> : null}
    </section>
  )
}
