import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { subDays, startOfToday, endOfToday } from 'date-fns'
import { NotebookPen, Printer, Send } from 'lucide-react'
import { useState } from 'react'
import { useParams } from 'react-router-dom'

import { ErrorState, StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Field, Textarea } from '@/components/ui/field'
import { Tabs } from '@/components/ui/tabs'
import { useCurrentUser } from '@/features/auth/auth-context'
import { createDoctorNote, fetchDoctorNotes } from '@/features/doctor-notes/api'
import { AdherenceSummary } from '@/features/medications/components/adherence-summary'
import { summariseAdherence } from '@/features/medications/api'
import { useDoses, useMedicationSchedules } from '@/features/medications/hooks'
import { usePatient } from '@/features/patients/hooks'
import { MoodTrend } from '@/features/recovery-logs/components/mood-trend'
import { useRecoveryLogs } from '@/features/recovery-logs/hooks'
import { useTreatmentPlans } from '@/features/treatment-plans/hooks'
import { summariseGoals } from '@/features/treatment-plans/api'
import {
  calculateAge,
  formatDate,
  formatDateRelative,
  formatScheduleTime,
} from '@/lib/format'
import { queryKeys } from '@/lib/query-keys'
import {
  patientStatus,
  treatmentGoalStatus,
  treatmentPlanStatus,
} from '@/lib/status'
import { fullName } from '@/lib/utils'

type TabId = 'overview' | 'recovery' | 'treatment' | 'medication' | 'notes'

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'recovery', label: 'Recovery' },
  { id: 'treatment', label: 'Treatment' },
  { id: 'medication', label: 'Medication' },
  { id: 'notes', label: 'Notes' },
] as const satisfies readonly { id: TabId; label: string }[]

/**
 * Modules 2.4, 5.1-5.5 and 5.3.
 *
 * The clinician's single view of one patient. Tabs rather than one long
 * scroll: a consultation asks a specific question — how has adherence been,
 * what did I write last time — and answering it should not require scrolling
 * past four other sections.
 */
export function DoctorPatientDetailPage() {
  const { patientId = '' } = useParams()
  const user = useCurrentUser()
  const doctorId = user.profile.kind === 'doctor' ? user.profile.doctor.doc_id : ''
  const queryClient = useQueryClient()

  const [tab, setTab] = useState<TabId>('overview')
  const [noteDraft, setNoteDraft] = useState('')

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
              actions={
                <>
                  <StatusBadge status={patientStatus[patient.pat_status]} />
                  <Button
                    variant="secondary"
                    onClick={() => window.print()}
                  >
                    <Printer aria-hidden="true" />
                    Print record
                  </Button>
                </>
              }
            />

            <Tabs tabs={TABS} value={tab} onChange={setTab}>
              {/* --- Overview ------------------------------------------- */}
              {tab === 'overview' ? (
                <div className="grid gap-5 lg:grid-cols-3">
                  <Card className="lg:col-span-2">
                    <CardHeader title="Patient details" />
                    <CardBody>
                      <dl className="grid gap-4 sm:grid-cols-2">
                        <div>
                          <dt className="text-sm text-muted">Date of birth</dt>
                          <dd className="font-medium text-heading">
                            {patient.pat_birth_date
                              ? formatDate(patient.pat_birth_date)
                              : 'Not recorded'}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-sm text-muted">Gender</dt>
                          <dd className="font-medium text-heading">
                            {patient.pat_gender ?? 'Not recorded'}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-sm text-muted">Contact</dt>
                          <dd className="font-medium text-heading">
                            {patient.pat_contact_no ?? 'Not recorded'}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-sm text-muted">Address</dt>
                          <dd className="font-medium text-heading">
                            {patient.pat_address ?? 'Not recorded'}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-sm text-muted">Registered</dt>
                          <dd className="font-medium text-heading">
                            {formatDate(patient.pat_created_at)}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-sm text-muted">
                            Privacy consent
                          </dt>
                          <dd className="font-medium text-heading">
                            {patient.pat_consent_at
                              ? formatDate(patient.pat_consent_at)
                              : 'Not yet given'}
                          </dd>
                        </div>
                      </dl>
                    </CardBody>
                  </Card>

                  <div className="space-y-5">
                    <Card>
                      <CardHeader title="Adherence, last 7 days" as="h3" />
                      <CardBody>
                        {adherence ? (
                          <AdherenceSummary adherence={adherence} />
                        ) : (
                          <p className="text-sm text-muted">Loading…</p>
                        )}
                      </CardBody>
                    </Card>

                    <Card>
                      <CardHeader title="Recovery trend" as="h3" />
                      <CardBody>
                        <MoodTrend logs={logsQuery.data ?? []} />
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
                        <p className="px-5 py-10 text-center text-sm text-muted">
                          This patient has not recorded any entries yet.
                        </p>
                      }
                    >
                      {(logs) => (
                        <ul className="divide-y divide-[var(--color-border)]">
                          {logs.map((log) => (
                            <li key={log.recovery_log_id} className="px-5 py-4">
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
              {tab === 'treatment' ? (
                <StateView
                  isPending={plansQuery.isPending}
                  error={plansQuery.error}
                  data={plansQuery.data}
                  onRetry={() => void plansQuery.refetch()}
                  empty={
                    <Card>
                      <CardBody>
                        <p className="py-8 text-center text-sm text-muted">
                          No treatment plan has been created for this patient.
                        </p>
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
                                <StatusBadge
                                  status={
                                    treatmentPlanStatus[
                                      plan.treatment_plan_status
                                    ]
                                  }
                                />
                              }
                            />
                            <CardBody>
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
                                <ul className="space-y-2">
                                  {plan.treatment_goal.map((goal) => (
                                    <li
                                      key={goal.treatment_goal_id}
                                      className="flex flex-wrap items-start justify-between gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] px-4 py-3"
                                    >
                                      <div className="min-w-0 flex-1">
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
                                      <StatusBadge
                                        status={
                                          treatmentGoalStatus[
                                            goal.treatment_goal_status
                                          ]
                                        }
                                      />
                                    </li>
                                  ))}
                                </ul>
                              )}
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
                  />
                  <CardBody className="p-0">
                    <StateView
                      isPending={schedulesQuery.isPending}
                      error={schedulesQuery.error}
                      data={schedulesQuery.data}
                      onRetry={() => void schedulesQuery.refetch()}
                      empty={
                        <p className="px-5 py-10 text-center text-sm text-muted">
                          No prescriptions on record for this patient.
                        </p>
                      }
                    >
                      {(schedules) => (
                        <ul className="divide-y divide-[var(--color-border)]">
                          {schedules.map((schedule) => (
                            <li
                              key={schedule.medication_schedule_id}
                              className="px-5 py-4"
                            >
                              <p className="font-medium text-heading">
                                {schedule.medication_schedule_name}
                              </p>
                              <p className="mt-0.5 text-sm text-body">
                                {schedule.medication_schedule_dosage} ·{' '}
                                {schedule.medication_schedule_frequency}× daily
                                at{' '}
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
                            </li>
                          ))}
                        </ul>
                      )}
                    </StateView>
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
                          const text = noteDraft.trim()
                          if (text) addNote.mutate(text)
                        }}
                        className="space-y-4"
                      >
                        <Field label="Note">
                          <Textarea
                            value={noteDraft}
                            onChange={(event) =>
                              setNoteDraft(event.target.value)
                            }
                            placeholder="Wound healing well. Continue physiotherapy twice weekly."
                          />
                        </Field>

                        {addNote.isError ? (
                          <ErrorState error={addNote.error} />
                        ) : null}

                        <Button
                          type="submit"
                          disabled={!noteDraft.trim()}
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
                          <div className="px-5 py-10 text-center">
                            <NotebookPen
                              className="mx-auto size-6 text-neutral-400"
                              aria-hidden="true"
                            />
                            <p className="mt-2 text-sm text-muted">
                              No notes recorded for this patient yet.
                            </p>
                          </div>
                        }
                      >
                        {(notes) => (
                          <ul className="divide-y divide-[var(--color-border)]">
                            {notes.map((note) => (
                              <li
                                key={note.doctor_note_id}
                                className="px-5 py-4"
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
            </Tabs>
          </>
        )
      }}
    </StateView>
  )
}
