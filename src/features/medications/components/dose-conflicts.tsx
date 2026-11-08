import { useQuery } from '@tanstack/react-query'
import { CalendarClock } from 'lucide-react'
import { useId, useState } from 'react'

import { FormError } from '@/components/feedback/form-error'
import { ErrorState } from '@/components/feedback/state-view'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Field, Input, Textarea } from '@/components/ui/field'
import { Notice } from '@/components/ui/notice'
import { useQueryKeys } from '@/features/auth/use-query-keys'
import {
  CONFLICT_STATE_LABEL,
  conflictReasonText,
  conflictState,
  momentsFor,
  offsetAt,
  patientConflictText,
  type ConflictState,
  type ConflictSummary,
  type DoctorResolution,
  type MedicationConflict,
} from '@/features/medications/conflicts'
import { useResolveConflict } from '@/features/medications/hooks'
import { fetchOwnClinicTimeZone } from '@/features/patients/api'
import { formatDate, formatScheduleTime } from '@/lib/format'

/**
 * Dose conflicts (migration 48) on screen. PROVISIONAL: the wording and the
 * workflow await the clinical adviser (docs/medication-clock-change-decisions.md).
 * Nothing here suggests a time or tells anyone to take or skip a dose.
 */

const SUMMARY_ORDER: ConflictState[] = [
  'awaiting_review',
  'not_scheduled_unresolved',
  'not_given_separately',
  'course_ended',
  'rescheduled',
]

/**
 * The lines shown under adherence. None is part of the adherence figure; a
 * rescheduled dose is counted there as an ordinary dose.
 */
export function ConflictSummaryLines({ summary }: { summary: ConflictSummary }) {
  if (summary.total === 0) return null
  return (
    <ul className="mt-4 space-y-1 border-t border-[var(--color-border)] pt-3 text-sm" aria-label="Clock-change dose reviews">
      {SUMMARY_ORDER.filter((state) => summary[state] > 0).map((state) => (
        <li key={state} className="flex items-center gap-2.5">
          <CalendarClock className="size-4 shrink-0 text-neutral-500" aria-hidden="true" />
          <span className="flex-1 text-body">{CONFLICT_STATE_LABEL[state]}</span>
          <span className="font-medium text-heading" data-numeric>
            {summary[state]}
          </span>
        </li>
      ))}
      <li className="text-xs text-muted">Not counted in the adherence figure above.</li>
    </ul>
  )
}

/**
 * The conflicts could not be loaded. Said plainly, never shown as "none": a
 * dose time awaiting review must not disappear from the page because a
 * request failed.
 */
export function ConflictsLoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <section aria-labelledby="dose-conflicts-error-heading" className="space-y-2">
      <h3 id="dose-conflicts-error-heading" className="text-base font-semibold text-heading">
        Clock-change dose reviews could not be loaded
      </h3>
      <p className="text-sm text-body">
        Some dose times may be awaiting a doctor&apos;s review because of a clock change. They are not shown until
        this loads.
      </p>
      <ErrorState error={error} onRetry={onRetry} className="py-6" />
    </section>
  )
}

/** Under the adherence figure, when the conflicts could not be loaded. */
export function ConflictSummaryUnavailable() {
  return (
    <p role="status" className="mt-4 border-t border-[var(--color-border)] pt-3 text-sm text-muted">
      Clock-change dose reviews could not be loaded, so any are missing here.
    </p>
  )
}

/** The patient's view: one neutral sentence per conflict, and no action. */
export function PatientConflictNotices({ conflicts, now }: { conflicts: MedicationConflict[]; now: number }) {
  if (conflicts.length === 0) return null
  return (
    <ul className="space-y-2" aria-label="Dose times reviewed because of a clock change">
      {conflicts.map((conflict) => (
        <li key={conflict.medication_dose_conflict_id}>
          <Notice tone="info" title={CONFLICT_STATE_LABEL[conflictState(conflict, now)]}>
            {patientConflictText(conflict, now)}
          </Notice>
        </li>
      ))}
    </ul>
  )
}

/** The treating doctor's view: every conflict, and a decision on each open one. */
export function DoctorConflictPanel({
  patientId,
  conflicts,
  now,
}: {
  patientId: string
  conflicts: MedicationConflict[]
  now: number
}) {
  const queryKeys = useQueryKeys()
  const zoneQuery = useQuery({ queryKey: queryKeys.ownClinic.timeZone(), queryFn: fetchOwnClinicTimeZone })
  const [open, setOpen] = useState<MedicationConflict | null>(null)

  if (conflicts.length === 0) return null
  const waiting = conflicts.filter((conflict) => conflict.conflict_resolution === null).length

  return (
    <section aria-labelledby="dose-conflicts-heading" className="space-y-3 px-4 py-4 sm:px-5">
      <h3 id="dose-conflicts-heading" className="text-base font-semibold text-heading">
        Clock-change dose reviews
      </h3>
      {waiting > 0 ? (
        <Notice tone="warning" title={`${waiting} dose ${waiting === 1 ? 'time needs' : 'times need'} your review`}>
          The scheduler did not create these doses. Nothing is reminded or marked missed until you decide.
        </Notice>
      ) : null}
      {waiting > 0 && (zoneQuery.isError || (zoneQuery.isSuccess && !zoneQuery.data)) ? (
        <p role="alert" className="text-sm font-medium text-danger-700">
          The clinic&apos;s time zone could not be loaded, so these dose times cannot be reviewed yet. Reload the page to try again.
        </p>
      ) : null}
      <ul className="divide-y divide-[var(--color-border)] rounded-[var(--radius-md)] border border-[var(--color-border)]">
        {conflicts.map((conflict) => {
          const state = conflictState(conflict, now)
          return (
            <li key={conflict.medication_dose_conflict_id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start">
              <div className="min-w-0 flex-1 space-y-1">
                <p className="font-medium text-heading">
                  {conflict.medication_schedule?.medication_schedule_name ?? 'Medicine'} ·{' '}
                  {formatDate(conflict.conflict_dose_date)} at {formatScheduleTime(conflict.conflict_dose_time)}
                </p>
                <p className="text-sm text-body">{conflictReasonText(conflict)}</p>
                <p className="text-sm text-muted">
                  {CONFLICT_STATE_LABEL[state]}
                  {conflict.conflict_resolution_note ? ` · Reason: ${conflict.conflict_resolution_note}` : ''}
                </p>
              </div>
              {conflict.conflict_resolution === null ? (
                <Button
                  variant="outline"
                  size="sm"
                  // Times are chosen in the clinic's zone: not before it is known.
                  disabled={!zoneQuery.data}
                  onClick={() => setOpen(conflict)}
                  aria-label={`Review the ${formatScheduleTime(conflict.conflict_dose_time)} dose time on ${formatDate(conflict.conflict_dose_date)}`}
                >
                  Review
                </Button>
              ) : null}
            </li>
          )
        })}
      </ul>
      {open && zoneQuery.data ? (
        <ResolveConflictDialog
          patientId={patientId}
          conflict={open}
          zone={zoneQuery.data}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </section>
  )
}

const NOTE_MAX = 1000

/**
 * The decision. Both choices start unselected and the time starts empty: the
 * doctor chooses, the software suggests nothing. A time that happens twice
 * on that date asks which of the two moments is meant.
 */
export function ResolveConflictDialog({
  patientId,
  conflict,
  zone,
  onClose,
}: {
  patientId: string
  conflict: MedicationConflict
  zone: string
  onClose: () => void
}) {
  const resolve = useResolveConflict(patientId)
  const groupName = useId()
  const [choice, setChoice] = useState<DoctorResolution | null>(null)
  const [time, setTime] = useState('')
  const [moment, setMoment] = useState<number | null>(null)
  const [note, setNote] = useState('')
  const [problem, setProblem] = useState<string | null>(null)

  const date = conflict.conflict_dose_date
  const moments = time ? momentsFor(date, time, zone) : []

  const submit = () => {
    setProblem(null)
    if (choice === null) return setProblem('Choose a time for this dose or no separate dose.')
    let scheduledAt: string | null = null
    if (choice === 'rescheduled') {
      if (!time) return setProblem('Enter the time for this dose.')
      if (moments.length === 0) return setProblem(`${time} does not exist on ${formatDate(date)} in ${zone}.`)
      const chosen = moments.length === 1 ? moments[0]! : moment
      if (chosen === null) return setProblem(`${time} happens twice on ${formatDate(date)}. Choose which one.`)
      if (chosen <= Date.now()) return setProblem('The time must be in the future.')
      scheduledAt = new Date(chosen).toISOString()
    }
    const reason = note.trim()
    if (!reason) return setProblem('Enter the reason for this decision.')
    if (reason.length > NOTE_MAX) return setProblem(`The reason can be at most ${NOTE_MAX} characters.`)
    resolve.mutate(
      { conflictId: conflict.medication_dose_conflict_id, resolution: choice, scheduledAt, note: reason },
      { onSuccess: onClose },
    )
  }

  return (
    <Dialog
      isOpen
      onClose={() => (resolve.isPending ? undefined : onClose())}
      title="Review a dose time"
      description={`${conflict.medication_schedule?.medication_schedule_name ?? 'Medicine'}, ${formatDate(date)} at ${formatScheduleTime(conflict.conflict_dose_time)}. Times are in ${zone}.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={resolve.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} isLoading={resolve.isPending} loadingLabel="Saving…">
            Record decision
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-body">{conflictReasonText(conflict)}</p>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-heading">Your decision</legend>
          {(
            [
              ['rescheduled', 'Set a time for this dose', `A time on ${formatDate(date)}, in the future, when no other dose of this medicine is due.`],
              ['not_given_separately', 'No separate dose', 'Record that this dose time is not given separately.'],
            ] as const
          ).map(([value, label, hint]) => (
            <label key={value} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name={groupName}
                value={value}
                checked={choice === value}
                onChange={() => setChoice(value)}
                className="mt-1"
              />
              <span>
                <span className="font-medium text-heading">{label}</span>
                <span className="block text-muted">{hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {choice === 'rescheduled' ? (
          <Field label={`Time on ${formatDate(date)}`} required description={`In ${zone}.`}>
            <Input
              type="time"
              value={time}
              onChange={(event) => {
                setTime(event.target.value)
                setMoment(null)
              }}
            />
          </Field>
        ) : null}

        {choice === 'rescheduled' && moments.length === 2 ? (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-heading">
              {time} happens twice on {formatDate(date)}. Which one?
            </legend>
            {moments.map((candidate, index) => (
              <label key={candidate} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`${groupName}-moment`}
                  checked={moment === candidate}
                  onChange={() => setMoment(candidate)}
                />
                {index === 0 ? 'Before the clocks go back' : 'After the clocks go back'} ({offsetAt(candidate, zone)})
              </label>
            ))}
          </fieldset>
        ) : null}

        <Field label="Reason for this decision" required description={`Up to ${NOTE_MAX} characters.`}>
          <Textarea value={note} rows={3} onChange={(event) => setNote(event.target.value)} />
        </Field>

        {problem ? (
          <p role="alert" className="text-sm font-medium text-danger-700">
            {problem}
          </p>
        ) : null}
        {resolve.isError ? <FormError error={resolve.error} title="The decision was not recorded" /> : null}
      </div>
    </Dialog>
  )
}
