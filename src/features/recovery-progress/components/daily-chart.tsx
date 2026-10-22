import { format, parseISO } from 'date-fns'
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react'

import { formatDateRelative } from '@/lib/format'

export type ChartDay = {
  /** `YYYY-MM-DD`, local. */
  date: string
  /** The plotted value, or null for a day with nothing to plot. */
  value: number | null
  /** The day's reading in words, led by its value: "4 of 5, Good". */
  valueText: string
  /** Further lines where the value needs them: "Mood 75%", "Medication 100%". */
  details?: readonly string[]
}

export type ChartTick = { value: number; label: string }

// Room for the y-axis labels ("100%") on the left and the date labels below.
const MARGIN = { top: 12, right: 12, bottom: 28, left: 44 }
const TOOLTIP_WIDTH = 176
const BAR_MAX_WIDTH = 24
const BAR_RADIUS = 4
// The narrowest a date label is given before labels are thinned out.
const LABEL_SPACING = 52

/**
 * A day-by-day chart, drawn by hand in SVG as the rest of the application's
 * graphics are: a line with point markers, or a column per day.
 *
 * What it will not do is invent a value. A day without one is a gap: the
 * line stops and starts again rather than being drawn across it, and a
 * column chart leaves the day empty, marking it with a small hollow ring on
 * the baseline rather than a column of zero height that would read as 0%. A
 * real zero still shows, as a thin cap on the baseline.
 *
 * Every value is reachable without a pointer. The chart is one tab stop;
 * the arrow keys, Home and End step through the days, the selected day is
 * announced, and the same reading appears in a tooltip that stays inside
 * the chart. The panel's data table carries all of it as text too, so the
 * tooltip is never the only place a number lives.
 */
export function DailyChart({
  kind,
  days,
  domain,
  ticks,
  label,
  description,
}: {
  kind: 'line' | 'bar'
  days: readonly ChartDay[]
  /** The value axis, bottom to top. Fixed per measure, never fitted to the data. */
  domain: readonly [number, number]
  ticks: readonly ChartTick[]
  /** The chart's accessible name: what it plots. */
  label: string
  /** What it shows, in a sentence: read with the name. */
  description: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const { width, height } = useElementSize(containerRef)
  const [active, setActive] = useState<number | null>(null)
  const [announcement, setAnnouncement] = useState('')
  // A tap or click focuses the chart too. That focus selects the day
  // touched, not the latest day a keyboard arrival starts on.
  const focusedByPointer = useRef(false)
  const descriptionId = useId()
  const instructionsId = useId()

  const plotWidth = Math.max(0, width - MARGIN.left - MARGIN.right)
  const plotHeight = Math.max(0, height - MARGIN.top - MARGIN.bottom)
  const band = days.length > 0 ? plotWidth / days.length : 0
  const baseline = MARGIN.top + plotHeight
  const xAt = (index: number) => MARGIN.left + band * (index + 0.5)
  const yAt = (value: number) =>
    MARGIN.top + plotHeight * (1 - (value - domain[0]) / (domain[1] - domain[0]))

  // Labels are thinned from today backwards, so today always keeps its
  // label and the rest stay evenly spaced. Every day keeps its point.
  const maxLabels = Math.max(2, Math.floor(plotWidth / LABEL_SPACING))
  const labelStep = Math.max(1, Math.ceil(days.length / maxLabels))

  const select = (index: number, announce: boolean) => {
    const day = days[index]
    if (!day) return
    setActive(index)
    if (announce) {
      setAnnouncement(
        [formatDateRelative(day.date), day.valueText, ...(day.details ?? [])].join(', '),
      )
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = days.length - 1
    const current = active ?? last
    let next: number | null = null
    if (event.key === 'ArrowRight') next = Math.min(last, current + 1)
    else if (event.key === 'ArrowLeft') next = Math.max(0, current - 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = last
    else if (event.key === 'Escape') {
      setActive(null)
      return
    }
    if (next === null) return
    event.preventDefault()
    select(next, true)
  }

  // The day under the pointer: the nearest one, so the reader aims at a date
  // rather than at a 2px line or an 8px point.
  const dayAtPointer = (event: PointerEvent<HTMLDivElement>): number | null => {
    const box = containerRef.current?.getBoundingClientRect()
    if (!box || band === 0) return null
    const index = Math.floor((event.clientX - box.left - MARGIN.left) / band)
    return Math.min(days.length - 1, Math.max(0, index))
  }

  const activeDay = active === null ? undefined : days[active]
  const activeX = active === null ? 0 : xAt(active)
  // Beside the selected day, on whichever side has room, so it never covers
  // the point being read; held inside the chart's own box.
  const tooltipLeft = Math.min(
    Math.max(0, activeX > width / 2 ? activeX - 12 - TOOLTIP_WIDTH : activeX + 12),
    Math.max(0, width - TOOLTIP_WIDTH),
  )

  return (
    <div
      ref={containerRef}
      role="group"
      aria-roledescription="chart"
      aria-label={label}
      aria-describedby={`${descriptionId} ${instructionsId}`}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onFocus={(event) => {
        if (event.target !== event.currentTarget) return
        if (focusedByPointer.current) {
          focusedByPointer.current = false
          return
        }
        // Start on the most recent day that has something to read.
        const latest = days.findLastIndex((day) => day.value !== null)
        select(latest === -1 ? days.length - 1 : latest, true)
      }}
      onBlur={() => {
        focusedByPointer.current = false
        setActive(null)
      }}
      onPointerMove={(event) => {
        const index = dayAtPointer(event)
        if (index !== null && index !== active) select(index, false)
      }}
      onPointerDown={(event) => {
        if (document.activeElement !== containerRef.current) {
          focusedByPointer.current = true
        }
        const index = dayAtPointer(event)
        if (index !== null) select(index, false)
      }}
      onPointerLeave={() => {
        if (document.activeElement !== containerRef.current) setActive(null)
      }}
      className="relative h-45 touch-pan-y select-none rounded-[var(--radius-sm)] sm:h-60"
    >
      <p id={descriptionId} className="sr-only">
        {description}
      </p>
      <p id={instructionsId} className="sr-only">
        Use the left and right arrow keys to read each day.
      </p>

      <svg
        width={width}
        height={height}
        aria-hidden="true"
        className="block overflow-visible tabular-nums"
      >
        {/* Gridlines and the value axis: hairlines, one step off the
            surface, so the data is the only thing that is loud. */}
        {ticks.map((tick) => (
          <g key={tick.value}>
            <line
              x1={MARGIN.left}
              x2={MARGIN.left + plotWidth}
              y1={yAt(tick.value)}
              y2={yAt(tick.value)}
              className="stroke-[var(--color-border)]"
              strokeWidth={1}
            />
            <text
              x={MARGIN.left - 8}
              y={yAt(tick.value)}
              textAnchor="end"
              dominantBaseline="middle"
              className="fill-muted text-xs"
            >
              {tick.label}
            </text>
          </g>
        ))}

        {days.map((day, index) =>
          (days.length - 1 - index) % labelStep === 0 ? (
            <text
              key={day.date}
              x={xAt(index)}
              y={height - 8}
              textAnchor="middle"
              className="fill-muted text-xs"
            >
              {format(parseISO(day.date), 'd MMM')}
            </text>
          ) : null,
        )}

        {kind === 'line' && activeDay ? (
          <line
            x1={activeX}
            x2={activeX}
            y1={MARGIN.top}
            y2={baseline}
            className="stroke-[var(--color-border-strong)]"
            strokeWidth={1}
          />
        ) : null}

        {kind === 'line' ? (
          <LineMarks days={days} xAt={xAt} yAt={yAt} active={active} />
        ) : (
          <BarMarks
            days={days}
            xAt={xAt}
            yAt={yAt}
            baseline={baseline}
            barWidth={Math.min(BAR_MAX_WIDTH, Math.max(4, band * 0.6))}
            active={active}
          />
        )}
      </svg>

      {activeDay ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute z-10 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-surface px-3 py-2 shadow-[var(--shadow-md)]"
          style={{ left: tooltipLeft, top: MARGIN.top, width: TOOLTIP_WIDTH }}
        >
          <p className="text-sm font-semibold text-heading">{activeDay.valueText}</p>
          {activeDay.details?.map((line) => (
            <p key={line} className="text-xs text-body">
              {line}
            </p>
          ))}
          <p className="mt-0.5 text-xs text-muted">
            {formatDateRelative(activeDay.date)}
          </p>
        </div>
      ) : null}

      {/* Present from the first render, so each change is announced. A live
          region rather than a `status`: the page's own status line - "Saved."
          on My recovery - stays the one status a page has. */}
      <p aria-live="polite" aria-atomic="true" data-chart-announcement className="sr-only">
        {announcement}
      </p>
    </div>
  )
}

function LineMarks({
  days,
  xAt,
  yAt,
  active,
}: {
  days: readonly ChartDay[]
  xAt: (index: number) => number
  yAt: (value: number) => number
  active: number | null
}) {
  // Runs of consecutive days with a value. The line joins the days inside a
  // run and never crosses the gap between two runs.
  const runs: { x: number; y: number }[][] = []
  let run: { x: number; y: number }[] = []
  days.forEach((day, index) => {
    if (day.value === null) {
      if (run.length > 0) runs.push(run)
      run = []
    } else {
      run.push({ x: xAt(index), y: yAt(day.value) })
    }
  })
  if (run.length > 0) runs.push(run)

  return (
    <>
      {runs
        .filter((points) => points.length > 1)
        .map((points) => (
          <path
            key={`${points[0]!.x}`}
            d={points
              .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`)
              .join(' ')}
            fill="none"
            className="stroke-brand-600"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
      {/* Every day with a value has its point - a day between two gaps is a
          point on its own. The ring in the surface colour keeps it legible
          where it sits on the line. */}
      {days.map((day, index) =>
        day.value === null ? null : (
          <circle
            key={day.date}
            cx={xAt(index)}
            cy={yAt(day.value)}
            r={index === active ? 6 : 4}
            className="fill-brand-600 stroke-surface"
            strokeWidth={2}
          />
        ),
      )}
    </>
  )
}

function BarMarks({
  days,
  xAt,
  yAt,
  baseline,
  barWidth,
  active,
}: {
  days: readonly ChartDay[]
  xAt: (index: number) => number
  yAt: (value: number) => number
  baseline: number
  barWidth: number
  active: number | null
}) {
  return (
    <>
      {days.map((day, index) => {
        const left = xAt(index) - barWidth / 2
        const tone = index === active ? 'fill-brand-800' : 'fill-brand-600'

        if (day.value === null) {
          // Nothing resolved that day: a small hollow ring, not a bar - a
          // different shape from the flat cap of a real 0%, not only a
          // different colour.
          return (
            <circle
              key={day.date}
              cx={xAt(index)}
              cy={baseline - 5}
              r={3}
              className="fill-surface stroke-outline"
              strokeWidth={1.5}
            />
          )
        }

        if (day.value <= 0) {
          // A genuine 0%: every resolved dose was missed or skipped.
          return (
            <rect
              key={day.date}
              x={left}
              y={baseline - 3}
              width={barWidth}
              height={3}
              className={tone}
            />
          )
        }

        const top = yAt(day.value)
        const radius = Math.min(BAR_RADIUS, baseline - top, barWidth / 2)
        // Rounded at the data end, square on the baseline.
        return (
          <path
            key={day.date}
            d={[
              `M${left},${baseline}`,
              `V${top + radius}`,
              `A${radius},${radius} 0 0 1 ${left + radius},${top}`,
              `H${left + barWidth - radius}`,
              `A${radius},${radius} 0 0 1 ${left + barWidth},${top + radius}`,
              `V${baseline}`,
              'Z',
            ].join(' ')}
            className={tone}
          />
        )
      })}
    </>
  )
}

/**
 * The element's rendered size, kept current as it resizes, so the chart is
 * drawn in real pixels and its text stays at the size it is set in. Until
 * it can be measured - where ResizeObserver is missing, as in jsdom - it is
 * drawn at a typical size rather than not at all.
 */
function useElementSize(ref: RefObject<HTMLElement | null>): {
  width: number
  height: number
} {
  const [size, setSize] = useState({ width: 640, height: 240 })

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => {
      const box = element.getBoundingClientRect()
      if (box.width > 0 && box.height > 0) {
        setSize((previous) =>
          previous.width === box.width && previous.height === box.height
            ? previous
            : { width: box.width, height: box.height },
        )
      }
    }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])

  return size
}
