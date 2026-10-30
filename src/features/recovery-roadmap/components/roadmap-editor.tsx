import { Archive, ArrowDown, ArrowUp, Check, CircleDashed, ListPlus, Pencil, Plus, Target, X } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { FormError } from '@/components/feedback/form-error'
import { ErrorState, LoadingState } from '@/components/feedback/state-view'
import { StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, Input, Select, Textarea } from '@/components/ui/field'
import { ProgressBar } from '@/components/ui/progress'
import type { PlanWithGoals, TreatmentGoal } from '@/features/treatment-plans/api'
import { formatDate, toDateKey } from '@/lib/format'
import { treatmentGoalStatus } from '@/lib/status'
import { cn } from '@/lib/utils'

import type { RecoveryActivity, RecoveryPhase } from '../api'
import {
  useArchiveActivity,
  useArchivePhase,
  useCreateActivity,
  useCreatePhase,
  useLinkGoal,
  useReorderActivities,
  useReorderPhases,
  useRoadmap,
  useUpdateActivity,
  useUpdatePhase,
} from '../hooks'
import { PHASE_STATUS, planRoadmap, type RoadmapPhase } from '../roadmap'
import { phaseDates } from './phase-timeline'

/** A list with one item moved one place up (-1) or down (+1). */
function moved<T>(items: readonly T[], index: number, by: -1 | 1): T[] {
  const next = [...items]
  const [item] = next.splice(index, 1)
  next.splice(index + by, 0, item!)
  return next
}

/**
 * Module 5.7 for the doctor (migration 45): a plan's recovery roadmap on the
 * patient's record - its phases in order, the activities in each, the plan's
 * goals placed in a phase, and what the patient has marked done and when.
 *
 * Every change is the database's to allow: only the patient's assigned,
 * active doctor may make one (`is_my_patient`), dates must sit inside the
 * plan's, and nothing is deleted - a phase or activity is archived, so the
 * record of what was done outlives it. The patient's completions are theirs
 * alone; here they are only shown.
 */
export function RoadmapEditor({ patientId, plan }: { patientId: string; plan: PlanWithGoals }) {
  const roadmapQuery = useRoadmap(patientId, [plan], { live: true })
  const today = toDateKey()

  const createPhase = useCreatePhase(patientId)
  const updatePhase = useUpdatePhase(patientId)
  const archivePhase = useArchivePhase(patientId)
  const reorderPhases = useReorderPhases(patientId)
  const createActivity = useCreateActivity(patientId)
  const updateActivity = useUpdateActivity(patientId)
  const archiveActivity = useArchiveActivity(patientId)
  const reorderActivities = useReorderActivities(patientId)
  const linkGoal = useLinkGoal(patientId)

  const changes = [
    createPhase,
    updatePhase,
    archivePhase,
    reorderPhases,
    createActivity,
    updateActivity,
    archiveActivity,
    reorderActivities,
    linkGoal,
  ]
  const busy = changes.some((change) => change.isPending)
  const failed = changes.find((change) => change.isError)
  const [addingPhase, setAddingPhase] = useState(false)

  const headingId = `roadmap-${plan.treatment_plan_id}`
  const roadmap = roadmapQuery.data ? planRoadmap(plan.treatment_plan_id, plan.treatment_goal, roadmapQuery.data, today) : null

  return (
    <section aria-labelledby={headingId} className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 id={headingId} className="text-base font-semibold text-heading">
          Recovery roadmap
        </h3>
        {roadmap ? (
          <p className="text-sm text-muted" data-numeric>
            {roadmap.count.percentage === null
              ? 'No activities yet'
              : `${roadmap.count.percentage}% · ${roadmap.count.done} of ${roadmap.count.total} done`}
          </p>
        ) : null}
      </div>
      {roadmap && roadmap.count.percentage !== null ? (
        <ProgressBar
          value={roadmap.count.percentage}
          tone="accent"
          label="Roadmap progress"
          valueText={`${roadmap.count.done} of ${roadmap.count.total} done`}
        />
      ) : null}
      <p className="text-xs text-muted">
        Counts the activities assigned here, which the patient marks done, and the goals placed in a phase, when
        marked achieved. Doses, appointments and check-ins are not counted.
      </p>

      {failed ? <FormError error={failed.error} title="The roadmap was not changed" /> : null}

      {roadmapQuery.isPending ? (
        <LoadingState label="Loading the roadmap…" />
      ) : roadmapQuery.error ? (
        <ErrorState error={roadmapQuery.error} onRetry={() => void roadmapQuery.refetch()} />
      ) : roadmap ? (
        <>
          {roadmap.phases.length === 0 ? (
            <p className="text-sm text-muted">No phases yet. Add the first to lay this plan out for the patient.</p>
          ) : (
            <ol className="space-y-4">
              {roadmap.phases.map((item, index) => (
                <PhaseEditor
                  key={item.phase.recovery_phase_id}
                  item={item}
                  plan={plan}
                  isFirst={index === 0}
                  isLast={index === roadmap.phases.length - 1}
                  busy={busy}
                  onSave={(input) => updatePhase.mutateAsync({ phaseId: item.phase.recovery_phase_id, ...input })}
                  onMove={(by) =>
                    reorderPhases.mutate({
                      planId: plan.treatment_plan_id,
                      phaseIds: moved(roadmap.phases, index, by).map((phase) => phase.phase.recovery_phase_id),
                    })
                  }
                  onArchive={() => archivePhase.mutate(item.phase.recovery_phase_id)}
                  onAddActivity={(input) =>
                    createActivity.mutateAsync({ phaseId: item.phase.recovery_phase_id, ...input })
                  }
                  onSaveActivity={(activityId, input) => updateActivity.mutateAsync({ activityId, ...input })}
                  onMoveActivity={(activityIndex, by) =>
                    reorderActivities.mutate({
                      phaseId: item.phase.recovery_phase_id,
                      activityIds: moved(item.activities, activityIndex, by).map(
                        (activity) => activity.recovery_activity_id,
                      ),
                    })
                  }
                  onArchiveActivity={(activityId) => archiveActivity.mutate(activityId)}
                  onLinkGoal={(goalId, phaseId) => linkGoal.mutate({ goalId, phaseId })}
                />
              ))}
            </ol>
          )}

          {roadmap.unlinkedGoals.length > 0 && roadmap.phases.length > 0 ? (
            <p className="text-sm text-muted" data-numeric>
              {roadmap.unlinkedGoals.length === 1
                ? '1 goal of this plan is in no phase, so it is not counted.'
                : `${roadmap.unlinkedGoals.length} goals of this plan are in no phase, so they are not counted.`}
            </p>
          ) : null}

          {addingPhase ? (
            <PhaseForm
              plan={plan}
              submitLabel="Add phase"
              onCancel={() => setAddingPhase(false)}
              onSubmit={async (input) => {
                await createPhase.mutateAsync({ planId: plan.treatment_plan_id, ...input })
                setAddingPhase(false)
              }}
            />
          ) : (
            <Button variant="secondary" size="sm" onClick={() => setAddingPhase(true)}>
              <Plus aria-hidden="true" />
              Add phase
            </Button>
          )}
        </>
      ) : null}
    </section>
  )
}

type PhaseInput = { title: string; description: string | null; startDate: string | null; targetEndDate: string | null }
type ActivityInput = { title: string; description: string | null; targetDate: string | null }

function PhaseEditor({
  item,
  plan,
  isFirst,
  isLast,
  busy,
  onSave,
  onMove,
  onArchive,
  onAddActivity,
  onSaveActivity,
  onMoveActivity,
  onArchiveActivity,
  onLinkGoal,
}: {
  item: RoadmapPhase
  plan: PlanWithGoals
  isFirst: boolean
  isLast: boolean
  busy: boolean
  onSave: (input: PhaseInput) => Promise<unknown>
  onMove: (by: -1 | 1) => void
  onArchive: () => void
  onAddActivity: (input: ActivityInput) => Promise<unknown>
  onSaveActivity: (activityId: string, input: ActivityInput) => Promise<unknown>
  onMoveActivity: (index: number, by: -1 | 1) => void
  onArchiveActivity: (activityId: string) => void
  onLinkGoal: (goalId: string, phaseId: string | null) => void
}) {
  const { phase } = item
  const [editing, setEditing] = useState(false)
  const [confirmingArchive, setConfirmingArchive] = useState(false)
  const [addingActivity, setAddingActivity] = useState(false)
  const [editingActivityId, setEditingActivityId] = useState<string | null>(null)
  const name = phase.recovery_phase_title
  const dates = phaseDates(phase.recovery_phase_start_date, phase.recovery_phase_target_end_date)
  // Goals of the plan that are not in this phase: in another, or in none.
  const otherGoals = plan.treatment_goal.filter((goal) => goal.recovery_phase_id !== phase.recovery_phase_id)

  return (
    <li className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-4">
      {editing ? (
        <PhaseForm
          plan={plan}
          phase={phase}
          submitLabel="Save phase"
          onCancel={() => setEditing(false)}
          onSubmit={async (input) => {
            await onSave(input)
            setEditing(false)
          }}
        />
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="font-semibold text-heading">
                Phase {item.number} — {name}
              </h4>
              <StatusBadge status={PHASE_STATUS[item.status]} />
            </div>
            <p className="mt-1 text-sm text-muted" data-numeric>
              {[dates, item.count.total === 0 ? 'No activities yet' : `${item.count.done} of ${item.count.total} done`]
                .filter(Boolean)
                .join(' · ')}
            </p>
            {phase.recovery_phase_description ? (
              <p className="mt-1 whitespace-pre-wrap text-sm text-body">{phase.recovery_phase_description}</p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-1 sm:shrink-0">
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)} aria-label={`Edit phase ${name}`}>
              <Pencil aria-hidden="true" />
              Edit
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={isFirst || busy}
              onClick={() => onMove(-1)}
              aria-label={`Move phase ${name} up`}
            >
              <ArrowUp aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={isLast || busy}
              onClick={() => onMove(1)}
              aria-label={`Move phase ${name} down`}
            >
              <ArrowDown aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setConfirmingArchive(true)}
              aria-label={`Archive phase ${name}`}
            >
              <Archive aria-hidden="true" />
            </Button>
          </div>
        </div>
      )}

      {confirmingArchive ? (
        <div className="mt-3 rounded-[var(--radius-sm)] bg-warning-50 p-3 text-sm text-body">
          <p>
            Archive “{name}”? It leaves the patient’s roadmap with its activities; what was done stays on record. Its
            goals stay in the plan, in no phase.
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                setConfirmingArchive(false)
                onArchive()
              }}
            >
              Archive phase
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmingArchive(false)}>
              Keep it
            </Button>
          </div>
        </div>
      ) : null}

      <ul className="mt-3 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
        {item.activities.map((activity, index) =>
          editingActivityId === activity.recovery_activity_id ? (
            <li key={activity.recovery_activity_id} className="py-3">
              <ActivityForm
                plan={plan}
                activity={activity}
                submitLabel="Save activity"
                onCancel={() => setEditingActivityId(null)}
                onSubmit={async (input) => {
                  await onSaveActivity(activity.recovery_activity_id, input)
                  setEditingActivityId(null)
                }}
              />
            </li>
          ) : (
            <ActivityRow
              key={activity.recovery_activity_id}
              activity={activity}
              isFirst={index === 0}
              isLast={index === item.activities.length - 1}
              busy={busy}
              onEdit={() => setEditingActivityId(activity.recovery_activity_id)}
              onMove={(by) => onMoveActivity(index, by)}
              onArchive={() => onArchiveActivity(activity.recovery_activity_id)}
            />
          ),
        )}
        {item.goals.map((goal) => (
          <li key={goal.treatment_goal_id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 gap-3">
              <Target className="mt-0.5 size-5 shrink-0 text-accent-700" aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-body">
                  <span className="font-medium">Goal: </span>
                  {goal.treatment_goal_description}
                </p>
                <div className="mt-1">
                  <StatusBadge status={treatmentGoalStatus[goal.treatment_goal_status]} />
                </div>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => onLinkGoal(goal.treatment_goal_id, null)}
              aria-label={`Take goal "${goal.treatment_goal_description}" out of phase ${name}`}
            >
              <X aria-hidden="true" />
              Remove from phase
            </Button>
          </li>
        ))}
        {item.activities.length === 0 && item.goals.length === 0 ? (
          <li className="py-3 text-sm text-muted">No activities yet</li>
        ) : null}
      </ul>

      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        {addingActivity ? (
          <div className="flex-1">
            <ActivityForm
              plan={plan}
              submitLabel="Add activity"
              onCancel={() => setAddingActivity(false)}
              onSubmit={async (input) => {
                await onAddActivity(input)
                setAddingActivity(false)
              }}
            />
          </div>
        ) : (
          <Button variant="secondary" size="sm" onClick={() => setAddingActivity(true)}>
            <ListPlus aria-hidden="true" />
            Add activity
          </Button>
        )}
        {!addingActivity && otherGoals.length > 0 ? (
          <GoalPicker goals={otherGoals} phaseName={name} disabled={busy} onPick={(goalId) => onLinkGoal(goalId, phase.recovery_phase_id)} />
        ) : null}
      </div>
    </li>
  )
}

function ActivityRow({
  activity,
  isFirst,
  isLast,
  busy,
  onEdit,
  onMove,
  onArchive,
}: {
  activity: RecoveryActivity
  isFirst: boolean
  isLast: boolean
  busy: boolean
  onEdit: () => void
  onMove: (by: -1 | 1) => void
  onArchive: () => void
}) {
  const done = activity.recovery_activity_completed_at !== null
  const name = activity.recovery_activity_title
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 gap-3">
        {done ? (
          <Check className="mt-0.5 size-5 shrink-0 text-success-700" aria-hidden="true" />
        ) : (
          <CircleDashed className="mt-0.5 size-5 shrink-0 text-neutral-500" aria-hidden="true" />
        )}
        <div className="min-w-0">
          <p className="text-body">{name}</p>
          {activity.recovery_activity_description ? (
            <p className="mt-0.5 whitespace-pre-wrap text-sm text-muted">{activity.recovery_activity_description}</p>
          ) : null}
          <p className={cn('mt-0.5 text-sm', done ? 'text-success-700' : 'text-muted')} data-numeric>
            {done
              ? `Done by the patient on ${formatDate(activity.recovery_activity_completed_at)}`
              : `Not done yet${activity.recovery_activity_target_date ? ` · by ${formatDate(activity.recovery_activity_target_date)}` : ''}`}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-1 sm:shrink-0">
        <Button variant="ghost" size="sm" onClick={onEdit} aria-label={`Edit activity ${name}`}>
          <Pencil aria-hidden="true" />
          Edit
        </Button>
        <Button variant="ghost" size="sm" disabled={isFirst || busy} onClick={() => onMove(-1)} aria-label={`Move activity ${name} up`}>
          <ArrowUp aria-hidden="true" />
        </Button>
        <Button variant="ghost" size="sm" disabled={isLast || busy} onClick={() => onMove(1)} aria-label={`Move activity ${name} down`}>
          <ArrowDown aria-hidden="true" />
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onArchive} aria-label={`Archive activity ${name}`}>
          <Archive aria-hidden="true" />
        </Button>
      </div>
    </li>
  )
}

function GoalPicker({
  goals,
  phaseName,
  disabled,
  onPick,
}: {
  goals: TreatmentGoal[]
  phaseName: string
  disabled: boolean
  onPick: (goalId: string) => void
}) {
  const [goalId, setGoalId] = useState('')
  return (
    <form
      className="flex items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (goalId) {
          onPick(goalId)
          setGoalId('')
        }
      }}
    >
      <Field label={`Place a goal in ${phaseName}`} className="min-w-0 flex-1">
        <Select value={goalId} onChange={(event) => setGoalId(event.target.value)} className="h-9 text-sm">
          <option value="">Choose a goal…</option>
          {goals.map((goal) => (
            <option key={goal.treatment_goal_id} value={goal.treatment_goal_id}>
              {goal.treatment_goal_description}
              {goal.recovery_phase_id ? ' (moves it from its phase)' : ''}
            </option>
          ))}
        </Select>
      </Field>
      <Button type="submit" variant="secondary" size="sm" disabled={disabled || !goalId}>
        <Target aria-hidden="true" />
        Place goal
      </Button>
    </form>
  )
}

/** Whether a date lies inside the plan's own dates, as the database checks. */
function outsidePlan(plan: PlanWithGoals, date: string | null): boolean {
  if (!date) return false
  return date < plan.treatment_plan_start_date || (plan.treatment_plan_end_date !== null && date > plan.treatment_plan_end_date)
}

function planRange(plan: PlanWithGoals): string {
  return plan.treatment_plan_end_date
    ? `${formatDate(plan.treatment_plan_start_date)} and ${formatDate(plan.treatment_plan_end_date)}`
    : `${formatDate(plan.treatment_plan_start_date)} or later`
}

function PhaseForm({
  plan,
  phase,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  plan: PlanWithGoals
  phase?: RecoveryPhase
  submitLabel: string
  onSubmit: (input: PhaseInput) => Promise<void>
  onCancel: () => void
}) {
  const [title, setTitle] = useState(phase?.recovery_phase_title ?? '')
  const [description, setDescription] = useState(phase?.recovery_phase_description ?? '')
  const [start, setStart] = useState(phase?.recovery_phase_start_date ?? '')
  const [end, setEnd] = useState(phase?.recovery_phase_target_end_date ?? '')
  const [problems, setProblems] = useState<{ title?: string; start?: string; end?: string }>({})
  const [saving, setSaving] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const next: typeof problems = {}
    if (!title.trim()) next.title = 'Enter a title for the phase.'
    if (outsidePlan(plan, start || null)) next.start = `Choose a date between ${planRange(plan)}.`
    if (outsidePlan(plan, end || null)) next.end = `Choose a date between ${planRange(plan)}.`
    if (start && end && end < start) next.end = 'The end cannot come before the start.'
    setProblems(next)
    if (Object.keys(next).length > 0 || saving) return
    setSaving(true)
    try {
      await onSubmit({
        title: title.trim(),
        description: description.trim() || null,
        startDate: start || null,
        targetEndDate: end || null,
      })
    } catch {
      // Shown above the roadmap, from the mutation; the form keeps what was typed.
    } finally {
      setSaving(false)
    }
  }

  return (
    <form noValidate onSubmit={(event) => void submit(event)} className="space-y-3" aria-label={submitLabel}>
      <Field label="Phase title" required error={problems.title}>
        <Input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} />
      </Field>
      <Field label="Description">
        <Textarea value={description} maxLength={2000} rows={2} onChange={(event) => setDescription(event.target.value)} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Start date" error={problems.start}>
          <Input type="date" value={start} onChange={(event) => setStart(event.target.value)} />
        </Field>
        <Field label="Target end date" error={problems.end}>
          <Input type="date" value={end} onChange={(event) => setEnd(event.target.value)} />
        </Field>
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" isLoading={saving} loadingLabel="Saving…">
          {submitLabel}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

function ActivityForm({
  plan,
  activity,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  plan: PlanWithGoals
  activity?: RecoveryActivity
  submitLabel: string
  onSubmit: (input: ActivityInput) => Promise<void>
  onCancel: () => void
}) {
  const [title, setTitle] = useState(activity?.recovery_activity_title ?? '')
  const [description, setDescription] = useState(activity?.recovery_activity_description ?? '')
  const [target, setTarget] = useState(activity?.recovery_activity_target_date ?? '')
  const [problems, setProblems] = useState<{ title?: string; target?: string }>({})
  const [saving, setSaving] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const next: typeof problems = {}
    if (!title.trim()) next.title = 'Enter what the patient should do.'
    if (outsidePlan(plan, target || null)) next.target = `Choose a date between ${planRange(plan)}.`
    setProblems(next)
    if (Object.keys(next).length > 0 || saving) return
    setSaving(true)
    try {
      await onSubmit({ title: title.trim(), description: description.trim() || null, targetDate: target || null })
    } catch {
      // Shown above the roadmap, from the mutation; the form keeps what was typed.
    } finally {
      setSaving(false)
    }
  }

  return (
    <form noValidate onSubmit={(event) => void submit(event)} className="space-y-3" aria-label={submitLabel}>
      <Field label="Activity" required error={problems.title}>
        <Input value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} />
      </Field>
      <Field label="Instructions">
        <Textarea value={description} maxLength={2000} rows={2} onChange={(event) => setDescription(event.target.value)} />
      </Field>
      <Field label="Target date" error={problems.target}>
        <Input type="date" value={target} onChange={(event) => setTarget(event.target.value)} />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" size="sm" isLoading={saving} loadingLabel="Saving…">
          {submitLabel}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
