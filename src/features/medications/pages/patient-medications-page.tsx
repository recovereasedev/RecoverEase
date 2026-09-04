import { addDays, endOfToday, startOfToday, subDays } from 'date-fns'
import { CalendarClock, ClipboardList, Pill, Printer } from 'lucide-react'

import { StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { ListRow, ListRows } from '@/components/ui/list-row'
import { useCurrentUser } from '@/features/auth/auth-context'
import { summariseAdherence } from '@/features/medications/api'
import { AdherenceSummary } from '@/features/medications/components/adherence-summary'
import {
  useDoses,
  useMedicationSchedules,
  useSetDoseStatus,
} from '@/features/medications/hooks'
import {
  formatDate,
  formatDateRelative,
  formatScheduleTime,
  formatTime,
} from '@/lib/format'
import { medicationLogStatus } from '@/lib/status'

/**
 * Modules 4.5 "View Medication Schedule", 4.6 "Mark Medication as Taken",
 * 4.8 "View Weekly Adherence Tracking" and 4.10 "Download Prescription".
 *
 * The page opens on what is due today, because that is the question a patient
 * has when they open it. The prescription list and the week's adherence sit
 * below — and on a phone, below means below: the adherence column is the last
 * thing in the document, not something competing with today's doses for the
 * first screen.
 */
export function PatientMedicationsPage() {
  const user = useCurrentUser()
  const patientId =
    user.profile.kind === 'patient' ? user.profile.patient.pat_id : ''

  const todayDoses = useDoses(
    patientId,
    startOfToday().toISOString(),
    endOfToday().toISOString(),
  )

  // The adherence window is the last seven days, matching module 4.8. It
  // stops at the end of today so future doses are never counted as failures.
  const weekDoses = useDoses(
    patientId,
    subDays(startOfToday(), 6).toISOString(),
    endOfToday().toISOString(),
  )

  const upcoming = useDoses(
    patientId,
    endOfToday().toISOString(),
    addDays(endOfToday(), 3).toISOString(),
  )

  const schedulesQuery = useMedicationSchedules(patientId)
  const setDoseStatus = useSetDoseStatus(patientId)

  const adherence = weekDoses.data
    ? summariseAdherence(weekDoses.data)
    : null

  return (
    <>
      <PageHeader
        eyebrow="Your medication"
        title="Medication"
        description="What is due, what you have taken, and what your doctor has prescribed."
        actions={
          <Button
            variant="outline"
            className="max-sm:w-full"
            onClick={() => window.print()}
          >
            <Printer aria-hidden="true" />
            Print prescriptions
          </Button>
        }
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          {/* --- Today --------------------------------------------------- */}
          <Card>
            <CardHeader
              icon={Pill}
              title="Due today"
              description="Mark each dose once you have taken it."
            />
            <CardBody className="p-0">
              <StateView
                isPending={todayDoses.isPending}
                error={todayDoses.error}
                data={todayDoses.data}
                onRetry={() => void todayDoses.refetch()}
                empty={
                  <div className="px-4 py-10 text-center sm:px-5">
                    <Pill
                      className="mx-auto size-6 text-neutral-400"
                      aria-hidden="true"
                    />
                    <p className="mt-2 font-medium text-heading">
                      Nothing due today
                    </p>
                  </div>
                }
              >
                {(doses) => (
                  <ListRows>
                    {doses.map((dose) => {
                      const isPending =
                        dose.medication_log_status === 'pending'
                      const isMutating =
                        setDoseStatus.isPending &&
                        setDoseStatus.variables?.doseId ===
                          dose.medication_log_id
                      // The button labels stay bare ("Taken", "Skip") so
                      // they read cleanly in a row and so the accessible name
                      // is exactly the word. In a list of identical controls a
                      // screen reader announces the row's own text alongside
                      // the button, which is what disambiguates them.
                      const name =
                        dose.medication_schedule?.medication_schedule_name ??
                        'Medication'
                      const time = formatTime(dose.medication_log_scheduled_at)

                      return (
                        <ListRow
                          key={dose.medication_log_id}
                          title={name}
                          description={
                            <>
                              {
                                dose.medication_schedule
                                  ?.medication_schedule_dosage
                              }{' '}
                              · due <span data-numeric>{time}</span>
                            </>
                          }
                          status={
                            <StatusBadge
                              status={
                                medicationLogStatus[dose.medication_log_status]
                              }
                            />
                          }
                          actions={
                            isPending ? (
                              <>
                                <Button
                                  size="sm"
                                  isLoading={isMutating}
                                  onClick={() =>
                                    setDoseStatus.mutate({
                                      doseId: dose.medication_log_id,
                                      status: 'taken',
                                    })
                                  }
                                >
                                  Taken
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  isLoading={isMutating}
                                  onClick={() =>
                                    setDoseStatus.mutate({
                                      doseId: dose.medication_log_id,
                                      status: 'skipped',
                                    })
                                  }
                                >
                                  Skip
                                </Button>
                              </>
                            ) : (
                              <Button
                                size="sm"
                                variant="ghost"
                                isLoading={isMutating}
                                onClick={() =>
                                  setDoseStatus.mutate({
                                    doseId: dose.medication_log_id,
                                    status: 'pending',
                                  })
                                }
                              >
                                Undo
                              </Button>
                            )
                          }
                        />
                      )
                    })}
                  </ListRows>
                )}
              </StateView>
            </CardBody>
          </Card>

          {/* --- Coming up ------------------------------------------------ */}
          <Card>
            <CardHeader
              icon={CalendarClock}
              title="Coming up"
              description="The next few days, so nothing is a surprise."
            />
            <CardBody className="p-0">
              <StateView
                isPending={upcoming.isPending}
                error={upcoming.error}
                data={upcoming.data}
                empty={
                  <p className="px-4 py-8 text-center text-sm text-muted sm:px-5">
                    No doses scheduled in the next few days.
                  </p>
                }
              >
                {(doses) => (
                  <ListRows>
                    {doses.slice(0, 12).map((dose) => (
                      <ListRow
                        key={dose.medication_log_id}
                        className="py-3"
                        title={
                          <span className="text-sm font-medium">
                            {
                              dose.medication_schedule
                                ?.medication_schedule_name
                            }
                          </span>
                        }
                        status={
                          <span className="text-sm text-muted" data-numeric>
                            {formatDateRelative(
                              dose.medication_log_scheduled_at,
                            )}{' '}
                            {formatTime(dose.medication_log_scheduled_at)}
                          </span>
                        }
                      />
                    ))}
                  </ListRows>
                )}
              </StateView>
            </CardBody>
          </Card>

          {/* --- Prescriptions -------------------------------------------- */}
          <Card>
            <CardHeader
              icon={ClipboardList}
              title="Your prescriptions"
              description="Everything your doctor has prescribed."
            />
            <CardBody className="p-0">
              <StateView
                isPending={schedulesQuery.isPending}
                error={schedulesQuery.error}
                data={schedulesQuery.data}
                onRetry={() => void schedulesQuery.refetch()}
                empty={
                  <p className="px-4 py-8 text-center text-sm text-muted sm:px-5">
                    You have no prescriptions on record.
                  </p>
                }
              >
                {(schedules) => (
                  <ListRows>
                    {schedules.map((schedule) => (
                      <ListRow
                        key={schedule.medication_schedule_id}
                        title={schedule.medication_schedule_name}
                        description={
                          <>
                            <span className="block text-body">
                              {schedule.medication_schedule_dosage} ·{' '}
                              {schedule.medication_schedule_frequency}{' '}
                              {schedule.medication_schedule_frequency === 1
                                ? 'time'
                                : 'times'}{' '}
                              a day at{' '}
                              <span data-numeric>
                                {schedule.medication_schedule_times
                                  .map(formatScheduleTime)
                                  .join(', ')}
                              </span>
                            </span>
                            <span className="mt-0.5 block">
                              From{' '}
                              {formatDate(
                                schedule.medication_schedule_start_date,
                              )}
                              {schedule.medication_schedule_end_date
                                ? ` until ${formatDate(schedule.medication_schedule_end_date)}`
                                : ', ongoing'}
                            </span>
                          </>
                        }
                      >
                        {schedule.prescription?.prescription_notes ? (
                          <p className="rounded-[var(--radius-md)] bg-surface-sunken px-3 py-2 text-sm leading-relaxed text-body">
                            {schedule.prescription.prescription_notes}
                          </p>
                        ) : null}
                      </ListRow>
                    ))}
                  </ListRows>
                )}
              </StateView>
            </CardBody>
          </Card>
        </div>

        {/* --- Adherence --------------------------------------------------- */}
        <div className="space-y-5">
          <Card>
            <CardHeader title="This week" as="h2" />
            <CardBody>
              {adherence ? (
                <AdherenceSummary adherence={adherence} />
              ) : (
                <p className="text-sm text-muted">Loading…</p>
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  )
}
