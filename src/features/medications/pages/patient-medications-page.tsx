import { addDays, endOfToday, startOfToday, subDays } from 'date-fns'
import { AlarmClock, Download, Pill, Printer } from 'lucide-react'
import { useState } from 'react'

import { FormError } from '@/components/feedback/form-error'
import { PrintOutcomeNotice } from '@/components/feedback/print-outcome-notice'
import { InlineEmpty, StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { ListRow, ListRows } from '@/components/ui/list-row'
import { PageSection } from '@/components/ui/section-heading'
import { useCurrentUser } from '@/features/auth/auth-context'
import { summariseAdherence } from '@/features/medications/api'
import { AdherenceSummary } from '@/features/medications/components/adherence-summary'
import { PhoneReminders } from '@/features/medications/components/phone-reminders'
import { PrescriptionPrintHeader } from '@/features/medications/components/prescription-print-header'
import { patientDoseState } from '@/features/medications/dose-status'
import { prescribedBy } from '@/features/medications/prescriber'
import {
  useDoses,
  useMedicationSchedules,
  useSetDoseStatus,
} from '@/features/medications/hooks'
import { fetchOwnClinicName } from '@/features/patients/api'
import { useMyDoctor } from '@/features/patients/hooks'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { useNow } from '@/hooks/use-now'
import { useDocumentFile } from '@/lib/documents/use-document-file'
import {
  formatDate,
  formatDateRelative,
  formatScheduleTime,
  formatTime,
} from '@/lib/format'
import { patientDoseStatus } from '@/lib/status'
import { cn } from '@/lib/utils'

/**
 * Modules 4.5 "View Medication Schedule", 4.6 "Mark Medication as Taken",
 * 4.8 "View Weekly Adherence Tracking" and 4.10 "Download Prescription".
 *
 * Download and Print hand on the same prescription sheet, built once by
 * `buildPrescriptionPdf`: Print prints that PDF, not this page
 * (`@/lib/documents/print`).
 *
 * The page opens on what is due today, because that is the question a patient
 * has when they open it. RecoverEase 2.0 sets today's doses as a timeline: the
 * time leads each row, in a column of its own, and a time shared by two
 * medicines is written once, so the day reads as "08:00, 12:00, 16:00" before
 * it reads as a list of drug names. An overdue dose is tinted and gets the
 * solid "Mark taken"; the action is always "Mark taken" - the same words as
 * the dashboard - and never "Taken", which is the status a dose moves to.
 *
 * With nothing scheduled, Coming up is one line under its heading instead of
 * an empty card. The prescription list
 * is reference, so it sits below; and on a phone the week's adherence is the
 * last thing in the document, not something competing with today's doses for
 * the first screen.
 */
export function PatientMedicationsPage() {
  useDocumentTitle('Medications')
  const user = useCurrentUser()
  const patient =
    user.profile.kind === 'patient' ? user.profile.patient : null
  const patientId = patient?.pat_id ?? ''
  const doctorQuery = useMyDoctor(patient?.doc_id)

  const todayDoses = useDoses(
    patientId,
    startOfToday().toISOString(),
    endOfToday().toISOString(),
  )
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
  // Re-evaluated every minute, so a dose turns Overdue while the page is open.
  const now = useNow()
  // The dose just marked taken: only its badge animates in.
  const [confirmedId, setConfirmedId] = useState<string | null>(null)
  const prescriptionFile = useDocumentFile()

  // Module 4.10 as a file: one prescription sheet per prescription, built
  // from what this page has loaded - the one document both Download and
  // Print hand on. Offered once the prescriptions are here
  // and the doctor has either loaded or will not (no assigned doctor), so a
  // sheet never says "Not available" only because it was asked for too soon -
  // and not at all while there is no prescription to put on it.
  const hasNoPrescriptions = schedulesQuery.data?.length === 0
  const canDownloadPrescription =
    Boolean(patient) &&
    Boolean(schedulesQuery.data) &&
    !hasNoPrescriptions &&
    !doctorQuery.isLoading
  const buildPrescription = () => {
    if (!patient || !schedulesQuery.data) return null
    const schedules = schedulesQuery.data
    return async () => {
      const [{ buildPrescriptionPdf }, clinicName] = await Promise.all([
        import('@/features/medications/prescription-document'),
        // The letterhead's clinic name is a courtesy: without it the sheet
        // is still the prescription, so a failed read leaves it off.
        fetchOwnClinicName().catch(() => null),
      ])
      return buildPrescriptionPdf({
        patient,
        // The only doctor a patient may read is their current one, so a
        // prescription an earlier doctor issued names no prescriber.
        doctors: [doctorQuery.data],
        clinicName,
        schedules,
        generatedAt: new Date(),
      })
    }
  }
  const downloadPrescription = () => {
    const build = buildPrescription()
    if (build) void prescriptionFile.download(build)
  }
  const printPrescription = () => {
    const build = buildPrescription()
    if (build) void prescriptionFile.print(build)
  }

  const adherence = weekDoses.data
    ? summariseAdherence(weekDoses.data)
    : null

  const doses = todayDoses.data ?? []
  const takenCount = doses.filter(
    (dose) => dose.medication_log_status === 'taken',
  ).length
  const overdueCount = doses.filter(
    (dose) => patientDoseState(dose, now) === 'overdue',
  ).length

  // With nothing scheduled, Coming up is one quiet line under its heading
  // rather than an empty card.
  const nothingComingUp =
    !upcoming.isPending && !upcoming.error && upcoming.data?.length === 0

  return (
    <>
      {patient ? (
        <PrescriptionPrintHeader
          patient={patient}
          doctor={doctorQuery.data}
          printedAt={new Date(now).toISOString()}
        />
      ) : null}

      <PageHeader
        className="print:hidden"
        title="Medications"
        description="What is due, what you have taken, and what your doctor has prescribed."
        actions={
          <>
            <Button
              variant="outline"
              className="max-sm:w-full"
              onClick={downloadPrescription}
              disabled={!canDownloadPrescription || prescriptionFile.pending !== null}
              isLoading={prescriptionFile.pending === 'download'}
              loadingLabel="Preparing…"
              {...(hasNoPrescriptions
                ? { 'aria-describedby': 'prescription-download-unavailable' }
                : {})}
            >
              <Download aria-hidden="true" />
              Download prescription (PDF)
            </Button>
            <Button
              variant="outline"
              className="max-sm:w-full"
              onClick={printPrescription}
              disabled={!canDownloadPrescription || prescriptionFile.pending !== null}
              isLoading={prescriptionFile.pending === 'print'}
              loadingLabel="Preparing…"
              {...(hasNoPrescriptions
                ? { 'aria-describedby': 'prescription-download-unavailable' }
                : {})}
            >
              <Printer aria-hidden="true" />
              Print prescriptions
            </Button>
          </>
        }
      />

      {/* Why the download is unavailable, beside it rather than in a
          tooltip a disabled button could never show. */}
      {hasNoPrescriptions ? (
        <p
          id="prescription-download-unavailable"
          className="-mt-2 mb-6 text-sm text-muted print:hidden"
        >
          There is no prescription to download or print yet: your doctor
          has not prescribed anything.
        </p>
      ) : null}

      {prescriptionFile.error ? (
        <div className="mb-6 print:hidden">
          <FormError
            error={prescriptionFile.error.cause}
            title={
              prescriptionFile.error.action === 'print'
                ? 'The prescription was not printed'
                : 'The prescription was not downloaded'
            }
          />
        </div>
      ) : null}
      <PrintOutcomeNotice
        outcome={prescriptionFile.printOutcome}
        what="prescription"
        className="-mt-2 mb-6"
      />

      <div className="grid gap-section lg:grid-cols-3 lg:gap-8">
        <div className="space-y-section lg:col-span-2">
          {/* --- Today --------------------------------------------------- */}
          <PageSection
            className="print:hidden"
            title="Due today"
            description={
              doses.length > 0 ? (
                <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span data-numeric>
                    {takenCount} of {doses.length}{' '}
                    {doses.length === 1 ? 'dose' : 'doses'} taken
                  </span>
                  {overdueCount > 0 ? (
                    <span className="inline-flex items-center gap-1 font-medium text-warning-800">
                      <AlarmClock className="size-4" aria-hidden="true" />
                      {overdueCount} overdue
                    </span>
                  ) : null}
                </span>
              ) : (
                'Mark each dose once you have taken it.'
              )
            }
          >
            <Card variant="elevated" className="overflow-hidden">
              <StateView
                isPending={todayDoses.isPending}
                error={todayDoses.error}
                data={todayDoses.data}
                onRetry={() => void todayDoses.refetch()}
                empty={
                  <InlineEmpty icon={Pill}>Nothing due today.</InlineEmpty>
                }
              >
                {(todays) => (
                  <ListRows>
                    {todays.map((dose, index) => {
                      const isPending =
                        dose.medication_log_status === 'pending'
                      const state = patientDoseState(dose, now)
                      const isOverdue = state === 'overdue'
                      const isMutating =
                        setDoseStatus.isPending &&
                        setDoseStatus.variables?.doseId ===
                          dose.medication_log_id
                      const name =
                        dose.medication_schedule?.medication_schedule_name ??
                        'Medication'
                      const time = formatTime(dose.medication_log_scheduled_at)
                      // The time is written once per group of doses due
                      // together; the rows after it continue the group.
                      const previous = todays[index - 1]
                      const startsGroup =
                        !previous ||
                        formatTime(previous.medication_log_scheduled_at) !==
                          time

                      return (
                        <ListRow
                          key={dose.medication_log_id}
                          className={cn(isOverdue && 'bg-warning-50')}
                          leading={
                            startsGroup ? (
                              <span
                                className="block pt-px text-base font-semibold text-heading"
                                data-numeric
                              >
                                {time}
                              </span>
                            ) : null
                          }
                          title={name}
                          description={
                            <>
                              {
                                dose.medication_schedule
                                  ?.medication_schedule_dosage
                              }
                              {/* The time column is visual; the row says it
                                  too, for anyone not seeing the column. */}
                              <span className="sr-only">
                                {' '}
                                · due <span data-numeric>{time}</span>
                              </span>
                            </>
                          }
                          status={
                            <StatusBadge
                              key={state}
                              status={patientDoseStatus[state]}
                              className={cn(
                                state === 'taken' &&
                                  confirmedId === dose.medication_log_id &&
                                  'motion-confirm',
                              )}
                            />
                          }
                          actions={
                            isPending ? (
                              <Button
                                size="sm"
                                variant={isOverdue ? 'primary' : 'secondary'}
                                isLoading={isMutating}
                                onClick={() => {
                                  setConfirmedId(dose.medication_log_id)
                                  setDoseStatus.mutate({
                                    doseId: dose.medication_log_id,
                                    status: 'taken',
                                  })
                                }}
                              >
                                Mark taken
                                <span className="sr-only">
                                  : {name} at {time}
                                </span>
                              </Button>
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
            </Card>
          </PageSection>

          {/* --- Coming up ------------------------------------------------ */}
          <PageSection
            className="print:hidden"
            title="Coming up"
            description={
              nothingComingUp
                ? 'Nothing is scheduled in the next three days.'
                : 'The next three days, so nothing is a surprise.'
            }
          >
            {nothingComingUp ? null : (
              <Card className="overflow-hidden">
                <StateView
                  isPending={upcoming.isPending}
                  error={upcoming.error}
                  data={upcoming.data}
                >
                  {(next) => (
                    <ListRows>
                      {next.slice(0, 12).map((dose) => (
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
              </Card>
            )}
          </PageSection>

          {/* --- Prescriptions -------------------------------------------- */}
          <PageSection
            title="Your prescriptions"
            description="Everything your doctor has prescribed."
          >
            <Card className="overflow-hidden">
              <StateView
                isPending={schedulesQuery.isPending}
                error={schedulesQuery.error}
                data={schedulesQuery.data}
                onRetry={() => void schedulesQuery.refetch()}
                empty={
                  <InlineEmpty>You have no prescriptions on record.</InlineEmpty>
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
                            {/* Who issued it and when: the prescription's own
                                doctor, who is named only while they are this
                                patient's doctor - the one doctor a patient's
                                account may read. */}
                            <span className="mt-0.5 block">
                              Issued{' '}
                              {formatDate(
                                schedule.prescription?.prescription_issued_date,
                              )}{' '}
                              · {prescribedBy(schedule, doctorQuery.data)}
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
            </Card>
          </PageSection>
        </div>

        <div className="space-y-section">
          {/* --- Adherence ------------------------------------------------- */}
          <PageSection className="print:hidden" title="This week">
            <Card>
              <CardBody>
                {adherence ? (
                  <AdherenceSummary adherence={adherence} />
                ) : (
                  <p className="text-sm text-muted">Loading…</p>
                )}
              </CardBody>
            </Card>
          </PageSection>

          {/* --- Offline reminders, on the phone's own calendar ------------ */}
          {patient ? <PhoneReminders patient={patient} /> : null}
        </div>
      </div>
    </>
  )
}
