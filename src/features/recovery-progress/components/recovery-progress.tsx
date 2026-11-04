import { AlertTriangle, Table2 } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'

import { LoadingState, describeError } from '@/components/feedback/state-view'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { DataTable, TBody, TD, TH, THead, TR } from '@/components/ui/data-table'
import { MOOD_OPTIONS } from '@/features/recovery-logs/components/mood-scale'
import { RoadmapProgress } from '@/features/recovery-roadmap/components/roadmap-progress'
import { formatDateRelative } from '@/lib/format'
import { cn } from '@/lib/utils'

import { useRecoveryProgress } from '../hooks'
import {
  formatMoodAverage,
  formatPercent,
  formatPeriod,
  goalSnapshot,
  summariseProgress,
  type DayProgress,
  type ProgressRange,
} from '../progress'
import { ChoiceGroup } from './choice-group'
import { DailyChart, type ChartDay, type ChartTick } from './daily-chart'
import { GoalSnapshotView } from './goal-snapshot'

type Indicator = 'mood' | 'medication' | 'goals' | 'roadmap'

const RANGES = [
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
] as const satisfies readonly { value: ProgressRange; label: string }[]

const INDICATORS = [
  { value: 'mood', label: 'Mood' },
  { value: 'medication', label: 'Medication' },
  { value: 'goals', label: 'Treatment goals' },
  // Migration 45: the recovery roadmap's activities and phase goals.
  { value: 'roadmap', label: 'Roadmap' },
] as const satisfies readonly { value: Indicator; label: string }[]

const PERCENT_TICKS: ChartTick[] = [0, 25, 50, 75, 100].map((value) => ({
  value,
  label: `${value}%`,
}))

const MOOD_TICKS: ChartTick[] = MOOD_OPTIONS.map((option) => ({
  value: option.value,
  label: String(option.value),
}))

/**
 * Recovery progress (the 2nd-half plan's progress charts), for the patient on
 * My recovery and for their clinician on the record's Recovery tab: one
 * panel, the same in both places.
 *
 * One period - today and the 6 or 29 days before it - scopes everything
 * below it. The overall chart comes first, then the detail of one indicator
 * at a time. Each of the three reads behind it loads and fails on its own,
 * so a medication record that will not load leaves the mood chart readable;
 * only the overall score, which needs both, waits for both.
 *
 * Every number on it is worked out in `progress.ts`. What it summarises is
 * what was recorded. It is not an assessment of anyone's health, and says
 * so.
 */
export function RecoveryProgress({
  patientId,
  live = false,
}: {
  patientId: string
  /** The clinician's copy, which refreshes itself (see `useRecoveryProgress`). */
  live?: boolean
}) {
  const [range, setRange] = useState<ProgressRange>(7)
  const [indicator, setIndicator] = useState<Indicator>('mood')
  const [isTableOpen, setTableOpen] = useState(false)
  const headingId = useId()
  const tableId = useId()

  const progress = useRecoveryProgress(patientId, range, { live })
  const { days, today, logs, doses, plans } = progress
  const period = formatPeriod(days)

  const summary = summariseProgress({
    days,
    logs: logs.data ?? [],
    doses: doses.data ?? [],
  })

  return (
    <section aria-labelledby={headingId}>
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b border-[var(--color-border)] px-4 py-4 sm:px-5">
          <div className="min-w-0">
            <h2 id={headingId} className="text-headline-md text-heading">
              Recovery progress
            </h2>
            <p className="mt-0.5 text-sm text-muted">{period}</p>
          </div>
          <ChoiceGroup
            legend="Period"
            options={RANGES}
            value={range}
            onChange={setRange}
          />
        </div>

        <div
          aria-busy={progress.isSwitching}
          className={cn(
            'space-y-8 p-4 transition-opacity duration-[var(--duration-base)] sm:p-5',
            progress.isSwitching && 'opacity-60',
          )}
        >
          <OverallSection
            days={days}
            period={period}
            summary={summary}
            logs={logs}
            doses={doses}
          />

          <div>
            <ChoiceGroup
              legend="Show the details for"
              options={INDICATORS}
              value={indicator}
              onChange={setIndicator}
            />
            <div className="mt-5">
              {indicator === 'mood' ? (
                <MoodSection period={period} summary={summary} logs={logs} />
              ) : indicator === 'medication' ? (
                <MedicationSection period={period} summary={summary} doses={doses} />
              ) : indicator === 'roadmap' ? (
                <section aria-label="Recovery roadmap">
                  <h3 className="mb-3 text-base font-semibold text-heading">Recovery roadmap</h3>
                  {plans.isPending ? (
                    <LoadingState label="Loading the roadmap…" />
                  ) : plans.error ? (
                    <SourceProblem error={plans.error} what="The roadmap" onRetry={() => void plans.refetch()} />
                  ) : (
                    <RoadmapProgress
                      patientId={patientId}
                      plans={plans.data ?? []}
                      range={progress.shownRange}
                      today={today}
                      period={period}
                      live={live}
                    />
                  )}
                </section>
              ) : (
                <section aria-label="Treatment goals">
                  <h3 className="mb-3 text-base font-semibold text-heading">
                    Treatment goals
                  </h3>
                  {plans.isPending ? (
                    <LoadingState label="Loading treatment goals…" />
                  ) : plans.error ? (
                    <SourceProblem
                      error={plans.error}
                      what="Treatment goals"
                      onRetry={() => void plans.refetch()}
                    />
                  ) : (
                    <GoalSnapshotView
                      snapshot={goalSnapshot(plans.data ?? [], today)}
                      today={today}
                    />
                  )}
                </section>
              )}
            </div>
          </div>

          <div>
            <Button
              variant="outline"
              size="sm"
              aria-expanded={isTableOpen}
              aria-controls={tableId}
              onClick={() => setTableOpen((open) => !open)}
            >
              <Table2 aria-hidden="true" />
              {isTableOpen ? 'Hide the data table' : 'Show the data table'}
            </Button>
            <div id={tableId} hidden={!isTableOpen}>
              {isTableOpen ? (
                <ProgressTable
                  period={period}
                  days={summary.days}
                  moodLoaded={logs.data !== undefined}
                  dosesLoaded={doses.data !== undefined}
                />
              ) : null}
            </div>
          </div>

          <p className="text-xs text-muted">
            These figures summarise what has been recorded. They are not a
            medical assessment.
          </p>
        </div>
      </Card>
    </section>
  )
}

type SourceQuery<T> = {
  data: T | undefined
  error: unknown
  isPending: boolean
  refetch: () => unknown
}

type Summary = ReturnType<typeof summariseProgress>

function OverallSection({
  days,
  period,
  summary,
  logs,
  doses,
}: {
  days: readonly string[]
  period: string
  summary: Summary
  logs: SourceQuery<unknown>
  doses: SourceQuery<unknown>
}) {
  const failed = [
    logs.error ? { what: 'Mood entries', query: logs } : null,
    doses.error ? { what: 'Medication records', query: doses } : null,
  ].filter((source) => source !== null)
  const isReady = logs.data !== undefined && doses.data !== undefined
  const { average, daysWithData } = summary.overall

  return (
    <section aria-label="Overall recovery progress">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-heading">
            Overall recovery progress
          </h3>
          <p className="mt-0.5 text-sm text-muted">
            Mood and medication combined, day by day
          </p>
        </div>
        {isReady && failed.length === 0 && average !== null ? (
          <p className="text-headline-xl text-heading">{formatPercent(average)}</p>
        ) : null}
      </div>

      <div className="mt-3">
        {failed.length > 0 ? (
          <div className="space-y-2">
            {failed.map(({ what, query }) => (
              <SourceProblem
                key={what}
                error={query.error}
                what={what}
                onRetry={() => void query.refetch()}
              />
            ))}
            <p className="text-sm text-muted">
              The overall score needs both, so it is not shown rather than
              worked out from one.
            </p>
          </div>
        ) : !isReady ? (
          <ChartLoading label="Loading recovery progress…" />
        ) : average === null ? (
          <NoData>
            No mood rating or resolved dose was recorded on any of these days.
          </NoData>
        ) : (
          <>
            <p className="mb-2 text-sm text-body">
              Based on {daysWithData} of {days.length} days with records.
            </p>
            <DailyChart
              kind="line"
              days={summary.days.map(overallDay)}
              domain={[0, 100]}
              ticks={PERCENT_TICKS}
              label={`Overall recovery progress by day, ${period}`}
              description={`Average ${formatPercent(average)}, from ${daysWithData} of ${days.length} days with records.`}
            />
          </>
        )}
      </div>

      <p className="mt-3 text-xs text-muted">
        Each day is the average of what was recorded that day: the mood rating
        on a 0–100% scale (1 is 0%, 3 is 50%, 5 is 100%) and the share of
        resolved doses taken. A day with neither is left blank, never counted
        as zero, and the headline is the average of the days shown. Treatment
        goals are shown separately, as they stand today.
      </p>
    </section>
  )
}

function MoodSection({
  period,
  summary,
  logs,
}: {
  period: string
  summary: Summary
  logs: SourceQuery<unknown>
}) {
  const { average, ratedDays } = summary.mood

  return (
    <section aria-label="Mood">
      <h3 className="text-base font-semibold text-heading">Mood</h3>
      {logs.error ? (
        <div className="mt-3">
          <SourceProblem
            error={logs.error}
            what="Mood entries"
            onRetry={() => void logs.refetch()}
          />
        </div>
      ) : logs.data === undefined ? (
        <ChartLoading label="Loading mood entries…" />
      ) : average === null ? (
        <div className="mt-3">
          <NoData>No mood rating was recorded on any of these days.</NoData>
        </div>
      ) : (
        <>
          <div className="mt-1 flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
            <div>
              <p className="text-sm text-muted">Average reported mood</p>
              <p className="text-headline-lg text-heading">
                {formatMoodAverage(average)}{' '}
                <span className="text-body-md font-normal text-muted">/ 5</span>
              </p>
            </div>
            <p className="text-sm text-muted">
              Rated on {ratedDays} of {summary.days.length} days · higher is a
              better reported mood
            </p>
          </div>
          <div className="mt-3">
            <DailyChart
              kind="line"
              days={summary.days.map(moodDay)}
              domain={[1, 5]}
              ticks={MOOD_TICKS}
              label={`Mood rating by day, ${period}`}
              description={`Average ${formatMoodAverage(average)} out of 5, from ${ratedDays} rated ${ratedDays === 1 ? 'day' : 'days'}. 1 is very poor and 5 is very good.`}
            />
          </div>
          <p className="mt-3 text-xs text-muted">
            1 Very poor · 2 Poor · 3 Okay · 4 Good · 5 Very good. A day without
            a rating is a gap in the line.
          </p>
        </>
      )}
    </section>
  )
}

function MedicationSection({
  period,
  summary,
  doses,
}: {
  period: string
  summary: Summary
  doses: SourceQuery<unknown>
}) {
  const medication = summary.medication

  return (
    <section aria-label="Medication">
      <h3 className="text-base font-semibold text-heading">Medication</h3>
      {doses.error ? (
        <div className="mt-3">
          <SourceProblem
            error={doses.error}
            what="Medication records"
            onRetry={() => void doses.refetch()}
          />
        </div>
      ) : doses.data === undefined ? (
        <ChartLoading label="Loading medication records…" />
      ) : medication.resolved === 0 && medication.pending === 0 ? (
        <div className="mt-3">
          <NoData title="No doses due">No doses were scheduled on these days.</NoData>
        </div>
      ) : medication.rate === null ? (
        <div className="mt-3">
          <NoData title="No resolved doses">
            None of the {medication.pending}{' '}
            {medication.pending === 1 ? 'dose' : 'doses'} on these days has
            been recorded as taken, missed or skipped yet.
          </NoData>
        </div>
      ) : (
        <>
          <div className="mt-1 flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
            <div>
              <p className="text-sm text-muted">Doses taken</p>
              <p className="text-headline-lg text-heading">{medication.rate}%</p>
            </div>
            <p className="text-sm text-muted" data-numeric>
              {medication.taken} of {medication.resolved} resolved{' '}
              {medication.resolved === 1 ? 'dose' : 'doses'} taken
              {medication.pending > 0
                ? ` · ${medication.pending} not yet recorded`
                : ''}
            </p>
          </div>
          <div className="mt-3">
            <DailyChart
              kind="bar"
              days={summary.days.map(medicationDay)}
              domain={[0, 100]}
              ticks={PERCENT_TICKS}
              label={`Doses taken by day, ${period}`}
              description={`${medication.rate}% of ${medication.resolved} resolved doses taken, with resolved doses on ${medication.daysWithResolved} of ${summary.days.length} days.`}
            />
          </div>
          <p className="mt-3 text-xs text-muted">
            Each bar is one day: doses taken ÷ (taken + missed + skipped). Doses
            not yet recorded are left out, and a small ring marks a day with
            no resolved dose. The headline counts every resolved dose in the
            period, so it can differ slightly from the average of the bars.
          </p>
        </>
      )}
    </section>
  )
}

function ProgressTable({
  period,
  days,
  moodLoaded,
  dosesLoaded,
}: {
  period: string
  days: readonly DayProgress[]
  moodLoaded: boolean
  dosesLoaded: boolean
}) {
  const unavailable = 'Not available'
  return (
    <DataTable caption={`Recovery progress by day, ${period}`} containerClassName="mt-4">
      <THead>
        <tr>
          <TH>Date</TH>
          <TH>Mood</TH>
          <TH>Medication</TH>
          <TH>Overall</TH>
        </tr>
      </THead>
      <TBody>
        {days.map((day) => (
          <TR key={day.date}>
            <TH scope="row" className="whitespace-nowrap font-medium text-heading">
              {formatDateRelative(day.date)}
            </TH>
            <TD>{moodLoaded ? moodText(day) : unavailable}</TD>
            <TD>
              {!dosesLoaded
                ? unavailable
                : day.adherence === null
                  ? dosesText(day)
                  : `${formatPercent(day.adherence)} (${dosesText(day)})`}
            </TD>
            <TD data-numeric>
              {moodLoaded && dosesLoaded ? overallText(day) : unavailable}
            </TD>
          </TR>
        ))}
      </TBody>
    </DataTable>
  )
}

/* ---- One day, in words --------------------------------------------------
   The same wording in the tooltip, the announcement and the table. */

function moodText(day: DayProgress): string {
  if (day.mood === null) return 'No rating'
  return `${day.mood} of 5, ${MOOD_OPTIONS[day.mood - 1]?.label ?? ''}`
}

function dosesText(day: DayProgress): string {
  if (day.resolved > 0) {
    return `${day.doses.taken} of ${day.resolved} ${day.resolved === 1 ? 'dose' : 'doses'} taken`
  }
  if (day.doses.pending > 0) return 'No resolved doses yet'
  return 'No doses due'
}

function overallText(day: DayProgress): string {
  return day.overall === null ? 'No data' : formatPercent(day.overall)
}

function overallDay(day: DayProgress): ChartDay {
  const parts = [
    day.moodScore === null ? null : `Mood ${formatPercent(day.moodScore)}`,
    day.adherence === null ? null : `Medication ${formatPercent(day.adherence)}`,
  ].filter((part) => part !== null)
  return {
    date: day.date,
    value: day.overall,
    valueText: overallText(day),
    details: parts.length > 0 ? parts : ['No rating and no resolved doses'],
  }
}

function moodDay(day: DayProgress): ChartDay {
  return { date: day.date, value: day.mood, valueText: moodText(day) }
}

function medicationDay(day: DayProgress): ChartDay {
  return day.adherence === null
    ? { date: day.date, value: null, valueText: dosesText(day) }
    : {
        date: day.date,
        value: day.adherence,
        valueText: formatPercent(day.adherence),
        details: [dosesText(day)],
      }
}

/* ---- States ------------------------------------------------------------- */

function ChartLoading({ label }: { label: string }) {
  // The chart's own height, so the panel does not jump when it arrives.
  return (
    <div className="flex h-45 items-center justify-center sm:h-60">
      <LoadingState label={label} />
    </div>
  )
}

function NoData({
  title = 'No data in this period.',
  children,
}: {
  title?: string
  children: ReactNode
}) {
  return (
    <div className="rounded-[var(--radius-md)] bg-surface-sunken px-4 py-6 text-center">
      <p className="font-semibold text-heading">{title}</p>
      <p className="mt-1 text-sm text-muted">{children}</p>
    </div>
  )
}

function SourceProblem({
  error,
  what,
  onRetry,
}: {
  error: unknown
  what: string
  onRetry: () => void
}) {
  const { kind } = describeError(error)
  const why =
    kind === 'network'
      ? ' Check your internet connection and try again.'
      : kind === 'permission'
        ? ' This account is not permitted to view them.'
        : ' Trying again usually helps.'

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--radius-md)] bg-surface-sunken px-4 py-3"
    >
      <AlertTriangle className="size-4 shrink-0 text-danger-700" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-sm text-body">
        <span className="font-semibold text-heading">{what} could not be loaded.</span>
        {why}
      </p>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  )
}
