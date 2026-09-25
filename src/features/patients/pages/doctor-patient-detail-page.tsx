import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { subDays, startOfToday, endOfToday } from 'date-fns'
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardPlus,
  KeyRound,
  Pencil,
  Pill,
  Printer,
  Send,
  Stethoscope,
  Target,
} from 'lucide-react'
import { useState } from 'react'
import { flushSync } from 'react-dom'
import { useParams, useSearchParams } from 'react-router-dom'

import { FormError } from '@/components/feedback/form-error'
import { StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { StatusBadge } from '@/components/ui/badge'
import type { Appointment } from '@/features/appointments/api'
import { useAppointments } from '@/features/appointments/hooks'
import { fetchChatSessions, type ChatSession } from '@/features/chat/api'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Field, Select, Textarea } from '@/components/ui/field'
import { ProgressBar } from '@/components/ui/progress'
import { Tabs } from '@/components/ui/tabs'
import { useCurrentUser } from '@/features/auth/auth-context'
import { PatientChatTranscript } from '@/features/chat/components/patient-chat-transcript'
import { createDoctorNote, fetchDoctorNotes } from '@/features/doctor-notes/api'
import { AdherenceSummary } from '@/features/medications/components/adherence-summary'
import { EndMedicationAction } from '@/features/medications/components/end-medication'
import { MedicationForm } from '@/features/medications/components/medication-form'
import { PrescriptionPrintHeader } from '@/features/medications/components/prescription-print-header'
import { summariseAdherence, type Adherence } from '@/features/medications/api'
import { useDoses, useMedicationSchedules } from '@/features/medications/hooks'
import { NotifyPatient } from '@/features/notifications/components/notify-patient'
import { ConsultationFlow } from '@/features/patients/components/consultation-flow'
import { ResetCredentialDialog } from '@/features/patients/components/reset-credential-dialog'
import { usePatient } from '@/features/patients/hooks'
import { MoodTrend } from '@/features/recovery-logs/components/mood-trend'
import { useRecoveryLogs } from '@/features/recovery-logs/hooks'
import { TreatmentGoalForm } from '@/features/treatment-plans/components/treatment-goal-form'
import { TreatmentPlanForm } from '@/features/treatment-plans/components/treatment-plan-form'
import {
  useTreatmentPlans,
  useUpdateGoalStatus,
} from '@/features/treatment-plans/hooks'
import {
  summariseGoals,
  type PlanWithGoals,
  type TreatmentGoalStatus,
} from '@/features/treatment-plans/api'
import type { RecoveryLog } from '@/features/recovery-logs/api'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { useNow } from '@/hooks/use-now'
import {
  calculateAge,
  formatDate,
  formatDateRelative,
  formatDateTime,
  formatScheduleTime,
} from '@/lib/format'
import { focusFirstInvalid, refocusAfterKeyboardSubmit } from '@/lib/form-focus'
import { queryKeys } from '@/lib/query-keys'
import {
  patientStatus,
  treatmentGoalStatus,
  treatmentPlanStatus,
} from '@/lib/status'
import { cn, fullName } from '@/lib/utils'

// The goal-state icon's colour on the treatment tab: the tone of the goal's
// own status descriptor, as text colour.
const GOAL_ICON_TONE: Record<TreatmentGoalStatus, string> = {
  pending: 'text-neutral-500',
  in_progress: 'text-info-700',
  achieved: 'text-success-700',
  missed: 'text-warning-700',
}

type TabId =
  | 'overview'
  | 'recovery'
  | 'treatment'
  | 'medication'
  | 'notes'
  | 'chat'

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'recovery', label: 'Recovery' },
  { id: 'treatment', label: 'Treatment' },
  { id: 'medication', label: 'Medication' },
  { id: 'notes', label: 'Notes' },
  { id: 'chat', label: 'Chat' },
] as const satisfies readonly { id: TabId; label: string }[]

/**
 * Modules 2.4, 5.1-5.5, 5.3 and 8.5.
 *
 * The clinician's single view of one patient. Tabs rather than one long
 * scroll: a consultation asks a specific question — how has adherence been,
 * what did I write last time — and answering it should not require scrolling
 * past four other sections.
 */
export function DoctorPatientDetailPage() {
  useDocumentTitle('Patient Record')
  const { patientId = '' } = useParams()
  const user = useCurrentUser()
  const doctorId = user.profile.kind === 'doctor' ? user.profile.doctor.doc_id : ''
  const doctor = user.profile.kind === 'doctor' ? user.profile.doctor : null
  const queryClient = useQueryClient()
  // Stamps the printed prescription (QA 9/12).
  const now = useNow()

  // A first consultation arrives here straight from registration, pointed at
  // the tab the clinician needs to fill in. Anything unrecognised falls back
  // to the overview rather than rendering nothing.
  const [searchParams, setSearchParams] = useSearchParams()
  const requestedTab = searchParams.get('tab')
  const [tab, setTab] = useState<TabId>(
    TABS.some((candidate) => candidate.id === requestedTab)
      ? (requestedTab as TabId)
      : 'overview',
  )
  const [noteDraft, setNoteDraft] = useState('')
  const [noteProblem, setNoteProblem] = useState<string | undefined>(undefined)
  // A patient's temporary password is shown once at registration, and no
  // email is sent, so their assigned clinician needs a way to reissue it.
  const [isResetOpen, setResetOpen] = useState(false)

  // The guided consultation. Deliberately component state and not a URL
  // parameter: the URL contract is `?tab=treatment` and registration hands
  // off to exactly that, and there is no half-finished wizard worth
  // resuming. Every step writes its own record as it is submitted, so a
  // reload lands on the treatment tab with all of that already there.
  const [isConsulting, setConsulting] = useState(false)
  const startConsultation = () => {
    setConsulting(true)
    setTab('treatment')
    // Kept in the URL so a reload, a shared link or the back button all
    // land on the same tab.
    setSearchParams({ tab: 'treatment' })
  }

  // Authoring state for the tabs, outside the guided flow.
  const [isCreatingPlan, setCreatingPlan] = useState(false)
  const [editingPlanId, setEditingPlanId] = useState<string | null>(null)
  const [goalPlanId, setGoalPlanId] = useState<string | null>(null)
  const [isPrescribing, setPrescribing] = useState(false)

  const patientQuery = usePatient(patientId)
  const logsQuery = useRecoveryLogs(patientId)
  const plansQuery = useTreatmentPlans(patientId)
  const schedulesQuery = useMedicationSchedules(patientId)

  const weekDoses = useDoses(
    patientId,
    subDays(startOfToday(), 6).toISOString(),
    endOfToday().toISOString(),
  )

  const notesQuery = useQuery({
    queryKey: queryKeys.doctorNotes.forPatient(patientId),
    queryFn: () => fetchDoctorNotes(patientId),
    enabled: Boolean(patientId),
  })

  const goalStatus = useUpdateGoalStatus(patientId)

  // A second medicine belongs to the prescription already issued, not to a
  // new one. Only prescriptions carrying a schedule are visible to this
  // query, which is exactly the set another medicine could join.
  const prescriptionId =
    schedulesQuery.data?.[0]?.prescription?.prescription_id
  const hasPrescription = Boolean(prescriptionId)

  const addNote = useMutation({
    mutationFn: (text: string) =>
      createDoctorNote({ patientId, doctorId, text }),
    onSuccess: () => {
      setNoteDraft('')
      void queryClient.invalidateQueries({
        queryKey: queryKeys.doctorNotes.forPatient(patientId),
      })
    },
  })

  const adherence = weekDoses.data ? summariseAdherence(weekDoses.data) : null

  // The record's summary strip (RecoverEase 2.0). Both are queries the app
  // already makes: the patient's appointments, and the chat sessions the
  // Chat tab lists - same function, same cache key, so opening the tab
  // afterwards costs nothing extra.
  const appointmentsQuery = useAppointments(patientId)
  const chatSessionsQuery = useQuery({
    queryKey: queryKeys.chat.sessionsFor(patientId),
    queryFn: () => fetchChatSessions(patientId),
    enabled: Boolean(patientId),
  })

  return (
    <StateView
      isPending={patientQuery.isPending}
      error={patientQuery.error}
      data={patientQuery.data}
      onRetry={() => void patientQuery.refetch()}
      loadingLabel="Loading patient record…"
    >
      {(patient) => {
        const age = calculateAge(patient.pat_birth_date)

        return (
          <>
            <PageHeader
              // The printed prescription carries its own letterhead.
              className={tab === 'medication' ? 'print:hidden' : ''}
              breadcrumbs={[
                { label: 'Patients', to: '/doctor/patients' },
                {
                  label: fullName(
                    patient.pat_first_name,
                    patient.pat_last_name,
                  ),
                },
              ]}
              title={fullName(patient.pat_first_name, patient.pat_last_name)}
              description={[
                age !== null ? `${age} years old` : null,
                patient.pat_contact_no,
              ]
                .filter(Boolean)
                .join(' · ')}
              meta={
                <StatusBadge status={patientStatus[patient.pat_status]} />
              }
              actions={
                <>
                  {/* The consultation itself, from the one screen a
                      clinician is already on when the patient is in front
                      of them. It creates nothing and opens no second
                      workflow: it is the same destination registration
                      hands off to, `?tab=treatment`, so the care plan and
                      then the medication schedule are entered exactly where
                      they always were. Registration keeps its own "Set up
                      care plan" button — that one covers a brand new
                      patient, this one covers every visit after. */}
                  <Button
                    className="max-sm:w-full"
                    onClick={startConsultation}
                  >
                    <Stethoscope aria-hidden="true" />
                    Start consultation
                  </Button>
                  <Button
                    variant="outline"
                    className="max-sm:w-full"
                    onClick={() => setResetOpen(true)}
                  >
                    <KeyRound aria-hidden="true" />
                    Reset password
                  </Button>
                  {/* No "Print record" here (QA 9/12): Reports prints the
                      record. Printing lives on the Medication tab, as the
                      patient's prescription. */}
                </>
              }
            />

            {isResetOpen ? (
              <ResetCredentialDialog
                isOpen
                onClose={() => setResetOpen(false)}
                subject={{
                  kind: 'patient',
                  patientId: patient.pat_id,
                  name: fullName(
                    patient.pat_first_name,
                    patient.pat_last_name,
                  ),
                }}
              />
            ) : null}

            {/* The printed prescription's letterhead (QA 9/12), shown on
                paper only. The clinician is named as the prescriber only
                when they are this patient's assigned doctor, who issues
                their prescriptions (module 4.3). */}
            {tab === 'medication' ? (
              <PrescriptionPrintHeader
                patient={patient}
                doctor={doctor?.doc_id === patient.doc_id ? doctor : null}
                printedAt={new Date(now).toISOString()}
              />
            ) : null}

            {/* Clinical status first: the five things a clinician checks
                before anything else, above every tab. */}
            <RecordSummary
              adherence={adherence}
              logs={logsQuery.data}
              appointments={appointmentsQuery.data}
              plans={plansQuery.data}
              sessions={chatSessionsQuery.data}
              onOpenChat={() => {
                setTab('chat')
                setSearchParams({ tab: 'chat' })
              }}
            />

            <Tabs tabs={TABS} value={tab} onChange={setTab}>
              {/* --- Overview ------------------------------------------- */}
              {tab === 'overview' ? (
                <div className="grid gap-section lg:grid-cols-3 lg:gap-8">
                  <div className="space-y-section lg:col-span-2">
                    <Card>
                      <CardHeader
                        title="Recovery trend"
                        description="How the patient rated each day."
                      />
                      <CardBody>
                        <MoodTrend logs={logsQuery.data ?? []} />
                      </CardBody>
                    </Card>

                    {/* --- Notify — module 7.1 --------------------------- */}
                    <NotifyPatient
                      patientUserId={patient.user_id}
                      patientName={fullName(
                        patient.pat_first_name,
                        patient.pat_last_name,
                      )}
                    />
                  </div>

                  <div className="space-y-section">
                    <Card>
                      <CardHeader title="Adherence, last 7 days" as="h2" />
                      <CardBody>
                        {adherence ? (
                          <AdherenceSummary adherence={adherence} />
                        ) : (
                          <p className="text-sm text-muted">Loading…</p>
                        )}
                      </CardBody>
                    </Card>

                    {/* Demographics are reference, not status: a compact
                        panel beside the clinical picture, every field kept. */}
                    <Card>
                      <CardHeader title="Patient details" as="h2" />
                      <CardBody>
                        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 text-sm">
                          {(
                            [
                              [
                                'Date of birth',
                                patient.pat_birth_date
                                  ? formatDate(patient.pat_birth_date)
                                  : 'Not recorded',
                              ],
                              ['Gender', patient.pat_gender ?? 'Not recorded'],
                              [
                                'Contact',
                                patient.pat_contact_no ?? 'Not recorded',
                              ],
                              [
                                'Address',
                                patient.pat_address ?? 'Not recorded',
                              ],
                              ['Registered', formatDate(patient.pat_created_at)],
                              [
                                'Privacy consent',
                                patient.pat_consent_at
                                  ? formatDate(patient.pat_consent_at)
                                  : 'Not yet given',
                              ],
                            ] as const
                          ).map(([label, value]) => (
                            <div key={label} className="contents">
                              <dt className="text-muted">{label}</dt>
                              <dd className="min-w-0 font-medium text-heading [overflow-wrap:anywhere]">
                                {value}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </CardBody>
                    </Card>
                  </div>
                </div>
              ) : null}

              {/* --- Recovery -------------------------------------------- */}
              {tab === 'recovery' ? (
                <Card>
                  <CardHeader
                    title="Recovery log"
                    description="Entries the patient has recorded."
                  />
                  <CardBody className="p-0">
                    <StateView
                      isPending={logsQuery.isPending}
                      error={logsQuery.error}
                      data={logsQuery.data}
                      onRetry={() => void logsQuery.refetch()}
                      empty={
                        <p className="px-4 py-10 text-center text-sm text-muted sm:px-5">
                          This patient has not recorded any entries yet.
                        </p>
                      }
                    >
                      {(logs) => (
                        <ul className="divide-y divide-[var(--color-border)]">
                          {logs.map((log) => (
                            <li
                              key={log.recovery_log_id}
                              className="px-4 py-4 sm:px-5"
                            >
                              <div className="flex flex-wrap items-baseline justify-between gap-2">
                                <p className="font-medium text-heading">
                                  {formatDateRelative(log.recovery_log_date)}
                                </p>
                                {log.recovery_log_mood_rating ? (
                                  <p
                                    className="text-sm text-muted"
                                    data-numeric
                                  >
                                    Rated {log.recovery_log_mood_rating} of 5
                                  </p>
                                ) : null}
                              </div>
                              {log.recovery_log_notes ? (
                                <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-body">
                                  {log.recovery_log_notes}
                                </p>
                              ) : (
                                <p className="mt-1.5 text-sm italic text-muted">
                                  No notes for this day.
                                </p>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </StateView>
                  </CardBody>
                </Card>
              ) : null}

              {/* --- Treatment ------------------------------------------- */}
              {/* The guided consultation lives inside this tab rather than
                  replacing the record: the clinician keeps the header, the
                  tabs and every other part of the patient's history one
                  click away while they work through it. */}
              {tab === 'treatment' && isConsulting ? (
                <ConsultationFlow
                  patientId={patientId}
                  doctorId={doctorId}
                  patientName={fullName(
                    patient.pat_first_name,
                    patient.pat_last_name,
                  )}
                  plans={plansQuery.data ?? []}
                  schedules={schedulesQuery.data ?? []}
                  onFinish={() => setConsulting(false)}
                />
              ) : null}

              {tab === 'treatment' && !isConsulting ? (
                <StateView
                  isPending={plansQuery.isPending}
                  error={plansQuery.error}
                  data={plansQuery.data}
                  onRetry={() => void plansQuery.refetch()}
                  empty={
                    <Card>
                      <CardHeader
                        title="Treatment plan"
                        description="Nothing has been planned for this patient yet."
                      />
                      <CardBody>
                        {isCreatingPlan ? (
                          <TreatmentPlanForm
                            patientId={patientId}
                            doctorId={doctorId}
                            onDone={() => setCreatingPlan(false)}
                            onCancel={() => setCreatingPlan(false)}
                          />
                        ) : (
                          <div className="py-6 text-center">
                            <p className="text-sm text-muted">
                              No treatment plan has been created for this
                              patient.
                            </p>
                            <Button
                              className="mt-4 max-sm:w-full"
                              onClick={() => setCreatingPlan(true)}
                            >
                              <ClipboardPlus aria-hidden="true" />
                              Create treatment plan
                            </Button>
                          </div>
                        )}
                      </CardBody>
                    </Card>
                  }
                >
                  {(plans) => (
                    <div className="space-y-5">
                      {plans.map((plan) => {
                        const progress = summariseGoals(plan.treatment_goal)
                        return (
                          <Card key={plan.treatment_plan_id}>
                            <CardHeader
                              title={plan.treatment_plan_title}
                              description={`${formatDate(plan.treatment_plan_start_date)}${
                                plan.treatment_plan_end_date
                                  ? ` — ${formatDate(plan.treatment_plan_end_date)}`
                                  : ' onwards'
                              } · ${progress.achieved} of ${progress.total} goals achieved`}
                              action={
                                <div className="flex items-center gap-2">
                                  <StatusBadge
                                    status={
                                      treatmentPlanStatus[
                                        plan.treatment_plan_status
                                      ]
                                    }
                                  />
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() =>
                                      setEditingPlanId(
                                        editingPlanId === plan.treatment_plan_id
                                          ? null
                                          : plan.treatment_plan_id,
                                      )
                                    }
                                  >
                                    <Pencil aria-hidden="true" />
                                    Edit plan
                                  </Button>
                                </div>
                              }
                            />
                            <CardBody>
                              {editingPlanId === plan.treatment_plan_id ? (
                                <div className="mb-5 border-b border-[var(--color-border)] pb-5">
                                  <TreatmentPlanForm
                                    patientId={patientId}
                                    doctorId={doctorId}
                                    plan={plan}
                                    onDone={() => setEditingPlanId(null)}
                                    onCancel={() => setEditingPlanId(null)}
                                  />
                                </div>
                              ) : null}

                              {plan.treatment_plan_description ? (
                                <p className="mb-4 whitespace-pre-wrap leading-relaxed text-body">
                                  {plan.treatment_plan_description}
                                </p>
                              ) : null}

                              {plan.treatment_goal.length === 0 ? (
                                <p className="text-sm text-muted">
                                  No goals defined for this plan.
                                </p>
                              ) : (
                                <>
                                  <div className="mb-4 flex items-center gap-3">
                                    <Target
                                      className="size-4 shrink-0 text-accent-700"
                                      aria-hidden="true"
                                    />
                                    {/* Restates the count already in the card
                                        description. `summariseGoals` counts
                                        goals the clinician has marked; nothing
                                        here is inferred. */}
                                    <ProgressBar
                                      value={progress.percentage ?? 0}
                                      tone="accent"
                                      label="Goals achieved in this plan"
                                      valueText={`${progress.achieved} of ${progress.total} goals achieved`}
                                    />
                                  </div>
                                  {/* One divided list, not a bordered box
                                      per goal inside the card: the rows are
                                      already grouped by the plan. */}
                                  <ul className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
                                  {plan.treatment_goal.map((goal) => {
                                    const goalState =
                                      treatmentGoalStatus[
                                        goal.treatment_goal_status
                                      ]
                                    const GoalIcon = goalState.icon
                                    return (
                                    <li
                                      key={goal.treatment_goal_id}
                                      className="flex flex-col gap-2.5 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                                    >
                                      <div className="flex min-w-0 gap-3 sm:flex-1">
                                        {/* The state as an icon; the select
                                            beside it says it in words, and is
                                            where it is changed. */}
                                        <GoalIcon
                                          className={cn(
                                            'mt-0.5 size-5 shrink-0',
                                            GOAL_ICON_TONE[goal.treatment_goal_status],
                                          )}
                                          aria-hidden="true"
                                        />
                                        <div className="min-w-0">
                                        <p className="text-body">
                                          {goal.treatment_goal_description}
                                        </p>
                                        {goal.treatment_goal_target_date ? (
                                          <p className="mt-0.5 text-sm text-muted">
                                            Target:{' '}
                                            {formatDate(
                                              goal.treatment_goal_target_date,
                                            )}
                                          </p>
                                        ) : null}
                                        </div>
                                      </div>
                                      <div className="flex items-center gap-2 sm:shrink-0">
                                        {/* Module 3.3's other half: the
                                            clinician records progress
                                            against the goal they set. */}
                                        <Field
                                          label="Progress"
                                          className="[&>label]:sr-only"
                                        >
                                          <Select
                                            // 44px on a phone, where it is
                                            // the only way to record progress.
                                            className="h-11 w-auto text-sm sm:h-9"
                                            value={goal.treatment_goal_status}
                                            disabled={goalStatus.isPending}
                                            onChange={(event) =>
                                              goalStatus.mutate({
                                                goalId: goal.treatment_goal_id,
                                                status: event.target
                                                  .value as TreatmentGoalStatus,
                                              })
                                            }
                                          >
                                            <option value="pending">
                                              Not started
                                            </option>
                                            <option value="in_progress">
                                              In progress
                                            </option>
                                            <option value="achieved">
                                              Achieved
                                            </option>
                                            <option value="missed">
                                              Missed
                                            </option>
                                          </Select>
                                        </Field>
                                      </div>
                                    </li>
                                    )
                                  })}
                                  </ul>
                                </>
                              )}

                              {goalStatus.isError ? (
                                <div className="mt-4">
                                  <FormError
                                    error={goalStatus.error}
                                    title="The goal was not updated"
                                  />
                                </div>
                              ) : null}

                              {/* Adding a goal to a plan that already exists,
                                  outside a guided consultation. */}
                              <div className="mt-5 border-t border-[var(--color-border)] pt-5">
                                {goalPlanId === plan.treatment_plan_id ? (
                                  <TreatmentGoalForm
                                    patientId={patientId}
                                    planId={plan.treatment_plan_id}
                                  />
                                ) : (
                                  <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() =>
                                      setGoalPlanId(plan.treatment_plan_id)
                                    }
                                  >
                                    <Target aria-hidden="true" />
                                    Add goal
                                  </Button>
                                )}
                              </div>
                            </CardBody>
                          </Card>
                        )
                      })}
                    </div>
                  )}
                </StateView>
              ) : null}

              {/* --- Medication ------------------------------------------- */}
              {tab === 'medication' ? (
                <Card>
                  <CardHeader
                    title="Prescriptions and schedules"
                    description="What this patient has been prescribed."
                    action={
                      // QA 9/12: printing belongs here, as the patient's
                      // prescription. Reports prints the rest of the record.
                      <Button
                        variant="outline"
                        size="sm"
                        className="print:hidden"
                        onClick={() => window.print()}
                      >
                        <Printer aria-hidden="true" />
                        Print prescription
                      </Button>
                    }
                  />
                  <CardBody className="p-0">
                    <StateView
                      isPending={schedulesQuery.isPending}
                      error={schedulesQuery.error}
                      data={schedulesQuery.data}
                      onRetry={() => void schedulesQuery.refetch()}
                      empty={
                        <p className="px-4 pb-2 pt-10 text-center text-sm text-muted sm:px-5">
                          No prescriptions on record for this patient.
                        </p>
                      }
                    >
                      {(schedules) => (
                        <ul className="divide-y divide-[var(--color-border)]">
                          {schedules.map((schedule) => (
                            <li
                              key={schedule.medication_schedule_id}
                              className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5"
                            >
                              <div className="min-w-0">
                                <p className="font-medium text-heading">
                                  {schedule.medication_schedule_name}
                                </p>
                                <p className="mt-0.5 text-sm text-body">
                                  {schedule.medication_schedule_dosage} ·{' '}
                                  {schedule.medication_schedule_frequency}×
                                  daily at{' '}
                                  <span data-numeric>
                                    {schedule.medication_schedule_times
                                      .map(formatScheduleTime)
                                      .join(', ')}
                                  </span>
                                </p>
                                <p className="mt-0.5 text-sm text-muted">
                                  From{' '}
                                  {formatDate(
                                    schedule.medication_schedule_start_date,
                                  )}
                                  {schedule.medication_schedule_end_date
                                    ? ` until ${formatDate(schedule.medication_schedule_end_date)}`
                                    : ', ongoing'}
                                </p>
                                {/* The prescription's notes, which the
                                    patient's own printed prescription also
                                    carries. Paper only (QA 9/12). */}
                                {schedule.prescription?.prescription_notes ? (
                                  <p className="mt-1.5 hidden whitespace-pre-wrap text-sm leading-relaxed text-body print:block">
                                    {schedule.prescription.prescription_notes}
                                  </p>
                                ) : null}
                              </div>

                              {/* QA-01. Only on a course that is still
                                  running; see canEndSchedule. `contents`
                                  keeps the row's layout exactly as it was;
                                  the control stays off the paper. */}
                              <div className="contents print:hidden">
                                <EndMedicationAction
                                  patientId={patientId}
                                  schedule={schedule}
                                />
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </StateView>

                    {/* Modules 4.3 and 4.1, outside a guided consultation.
                        One block whether or not anything is prescribed yet,
                        so there is a single place to look for it. */}
                    <div className="border-t border-[var(--color-border)] px-4 py-4 sm:px-5 print:hidden">
                      {isPrescribing ? (
                        <MedicationForm
                          patientId={patientId}
                          doctorId={doctorId}
                          {...(prescriptionId ? { prescriptionId } : {})}
                          onDone={() => setPrescribing(false)}
                          onCancel={() => setPrescribing(false)}
                        />
                      ) : (
                        <Button
                          variant={hasPrescription ? 'secondary' : 'primary'}
                          className="max-sm:w-full"
                          onClick={() => setPrescribing(true)}
                        >
                          <Pill aria-hidden="true" />
                          {hasPrescription
                            ? 'Add another medicine'
                            : 'Add prescription'}
                        </Button>
                      )}
                    </div>
                  </CardBody>
                </Card>
              ) : null}

              {/* --- Notes — modules 5.4, 5.5 ---------------------------- */}
              {tab === 'notes' ? (
                <div className="space-y-5">
                  <Card>
                    <CardHeader
                      title="Add a note"
                      description="Clinical notes are visible to clinicians only. Patients cannot read them."
                    />
                    <CardBody>
                      <form
                        onSubmit={(event) => {
                          event.preventDefault()
                          const form = event.currentTarget
                          const text = noteDraft.trim()
                          // "Save note" is always pressable; with nothing
                          // written, it says so beside the box and takes
                          // focus there, saving nothing.
                          if (!text) {
                            flushSync(() => setNoteProblem('Write the note.'))
                            focusFirstInvalid(form)
                            return
                          }
                          addNote.mutate(text, {
                            // Saved from the keyboard, focus goes back to the
                            // emptied box for the next note.
                            onSuccess: () =>
                              refocusAfterKeyboardSubmit(
                                form,
                                form.querySelector('textarea'),
                              ),
                          })
                        }}
                        className="space-y-4"
                      >
                        <Field label="Note" error={noteProblem}>
                          {/* Six rows rather than the four-row default: a
                              clinical note is a paragraph, and a box that
                              shows two lines of it makes reviewing what you
                              wrote a scrolling exercise on a phone. */}
                          <Textarea
                            rows={6}
                            value={noteDraft}
                            onChange={(event) => {
                              setNoteDraft(event.target.value)
                              setNoteProblem(undefined)
                            }}
                            placeholder="Wound healing well. Continue physiotherapy twice weekly."
                          />
                        </Field>

                        {addNote.isError ? (
                          <FormError
                            error={addNote.error}
                            title="The note was not saved"
                          />
                        ) : null}

                        <Button
                          type="submit"
                          className="max-sm:w-full"
                          isLoading={addNote.isPending}
                          loadingLabel="Saving note…"
                        >
                          <Send aria-hidden="true" />
                          Save note
                        </Button>
                      </form>
                    </CardBody>
                  </Card>

                  <Card>
                    <CardHeader title="Note history" />
                    <CardBody className="p-0">
                      <StateView
                        isPending={notesQuery.isPending}
                        error={notesQuery.error}
                        data={notesQuery.data}
                        onRetry={() => void notesQuery.refetch()}
                        empty={
                          // One line, as the record's other empty lists
                          // read: the card is titled and the form that fills
                          // it sits directly above.
                          <p className="px-4 py-10 text-center text-sm text-muted sm:px-5">
                            No notes recorded for this patient yet.
                          </p>
                        }
                      >
                        {(notes) => (
                          <ul className="divide-y divide-[var(--color-border)]">
                            {notes.map((note) => (
                              <li
                                key={note.doctor_note_id}
                                className="px-4 py-4 sm:px-5"
                              >
                                <p className="text-sm text-muted">
                                  {formatDateRelative(
                                    note.doctor_note_created_at,
                                  )}
                                </p>
                                <p className="mt-1 whitespace-pre-wrap leading-relaxed text-body">
                                  {note.doctor_note_text}
                                </p>
                              </li>
                            ))}
                          </ul>
                        )}
                      </StateView>
                    </CardBody>
                  </Card>
                </div>
              ) : null}

              {/* --- Chat — module 8.5 ------------------------------------
                  Read-only. A critical-chat notification links here with
                  `?tab=chat&session=<id>`, which opens that conversation. */}
              {tab === 'chat' ? (
                <PatientChatTranscript
                  patientId={patient.pat_id}
                  initialSessionId={searchParams.get('session')}
                />
              ) : null}
            </Tabs>
          </>
        )
      }}
    </StateView>
  )
}

/**
 * The patient record's summary strip (RecoverEase 2.0).
 *
 * The five facts a clinician checks before anything else - how adherence has
 * been, when the patient last wrote, when they are next seen, how far through
 * the plan they are, and whether anything has been flagged - in one band at
 * the top of the record, above the tabs, so they are the first thing read on
 * every tab. Every value is one the application already holds; nothing here
 * is derived beyond a count or the most recent date. A flagged conversation
 * is tinted, says so in words, and opens the Chat tab where it is read.
 *
 * Laid out by the room each fact needs, measured: a label wants about 160px
 * and a date about 230px. On a phone the facts are a list, one full-width row
 * each, with a value's detail beside it - two to a row left 112px at 320px,
 * and every label wrapped. Three across from `sm`, including a 1024px desktop,
 * where the sidebar leaves 670px; five across only from `xl`.
 */
function RecordSummary({
  adherence,
  logs,
  appointments,
  plans,
  sessions,
  onOpenChat,
}: {
  adherence: Adherence | null
  logs: RecoveryLog[] | undefined
  appointments: Appointment[] | undefined
  plans: PlanWithGoals[] | undefined
  sessions: ChatSession[] | undefined
  onOpenChat: () => void
}) {
  const lastLog = logs?.reduce<RecoveryLog | undefined>(
    (latest, log) =>
      !latest || log.recovery_log_date > latest.recovery_log_date
        ? log
        : latest,
    undefined,
  )
  const nextAppointment = appointments
    ?.filter(
      (appointment) =>
        new Date(appointment.appointment_date) >= new Date() &&
        appointment.appointment_status !== 'cancelled',
    )
    .sort(
      (a, b) =>
        new Date(a.appointment_date).getTime() -
        new Date(b.appointment_date).getTime(),
    )[0]
  const activePlan = plans?.find(
    (plan) => plan.treatment_plan_status === 'active',
  )
  const goals = activePlan ? summariseGoals(activePlan.treatment_goal) : null
  const flagged =
    sessions?.filter((session) => session.chat_session_has_critical_flag)
      .length ?? 0

  const loading = <span className="text-muted">Loading…</span>

  return (
    <dl
      aria-label="Patient summary"
      className="mb-6 grid gap-px overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-3 lg:mb-8 xl:grid-cols-5 print:hidden"
    >
      <SummaryItem
        label="Adherence, 7 days"
        value={
          !adherence
            ? loading
            : adherence.rate === null
              ? 'No doses due'
              : `${adherence.rate}%`
        }
        detail={
          adherence && adherence.rate !== null
            ? `${adherence.taken} of ${adherence.resolved} doses taken`
            : undefined
        }
      />
      <SummaryItem
        label="Last recovery entry"
        value={
          logs === undefined
            ? loading
            : lastLog
              ? formatDateRelative(lastLog.recovery_log_date)
              : 'None yet'
        }
        detail={
          lastLog?.recovery_log_mood_rating
            ? `Rated ${lastLog.recovery_log_mood_rating} of 5`
            : undefined
        }
      />
      <SummaryItem
        label="Next appointment"
        value={
          appointments === undefined
            ? loading
            : nextAppointment
              ? formatDateTime(nextAppointment.appointment_date)
              : 'None booked'
        }
      />
      <SummaryItem
        label="Treatment plan"
        value={
          plans === undefined
            ? loading
            : goals && goals.total > 0
              ? `${goals.achieved} of ${goals.total} goals`
              : activePlan
                ? 'No goals yet'
                : 'No active plan'
        }
      />
      <div
        className={cn(
          // A column at every width, so "Read in Chat" keeps a line - and on
          // a phone a 44px target - of its own. Takes the rest of the second
          // row where there are three columns.
          'flex min-w-0 flex-col px-4 py-3 sm:col-span-2 xl:col-span-1',
          flagged > 0 ? 'bg-warning-50' : 'bg-surface',
        )}
      >
        <dt className="text-sm text-muted">Flags</dt>
        <dd className="mt-0.5 flex items-center gap-1.5 font-semibold text-heading">
          {sessions === undefined ? (
            loading
          ) : flagged > 0 ? (
            <>
              <AlertTriangle
                className="size-4 shrink-0 text-warning-700"
                aria-hidden="true"
              />
              {flagged} flagged{' '}
              {flagged === 1 ? 'conversation' : 'conversations'}
            </>
          ) : (
            <>
              <CheckCircle2
                className="size-4 shrink-0 text-success-700"
                aria-hidden="true"
              />
              None
            </>
          )}
        </dd>
        {flagged > 0 ? (
          <dd>
            <button
              type="button"
              onClick={onOpenChat}
              className="mt-0.5 inline-flex min-h-11 items-center text-sm font-semibold text-role underline-offset-4 hover:underline sm:min-h-0"
            >
              Read in Chat
            </button>
          </dd>
        ) : null}
      </div>
    </dl>
  )
}

function SummaryItem({
  label,
  value,
  detail,
}: {
  label: string
  value: React.ReactNode
  detail?: string | undefined
}) {
  return (
    // On a phone, a full-width row: the label on its own line, then the
    // value with its detail beside it. From `sm`, label, value and detail
    // each take a line.
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 bg-surface px-4 py-3 sm:flex-col sm:flex-nowrap sm:items-stretch">
      <dt className="basis-full text-sm text-muted sm:basis-auto">{label}</dt>
      <dd className="mt-0.5 font-semibold text-heading" data-numeric>
        {value}
      </dd>
      {detail ? (
        <dd className="text-sm text-muted">
          {detail}
        </dd>
      ) : null}
    </div>
  )
}
