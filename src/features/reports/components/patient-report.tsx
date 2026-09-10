import type { ScheduleWithPrescription } from '@/features/medications/api'
import type { Doctor } from '@/features/patients/api'
import { MOOD_OPTIONS } from '@/features/recovery-logs/components/mood-scale'
import { summariseGoals } from '@/features/treatment-plans/api'
import { calculateAge, formatScheduleTime } from '@/lib/format'
import {
  appointmentStatus,
  patientStatus,
  treatmentGoalStatus,
  treatmentPlanStatus,
} from '@/lib/status'
import { fullName } from '@/lib/utils'

import { summariseReport, type PatientReportData } from '../report-data'
import { reportDate, reportDateTime, reportTime } from '../report-format'
import {
  ReportCell,
  ReportEmpty,
  ReportFacts,
  ReportFooter,
  ReportLetterhead,
  ReportRow,
  ReportSection,
  ReportSheet,
  ReportStats,
  ReportStatus,
  ReportTable,
  type ReportDensity,
} from './report-document'

/**
 * The patient report, in the two versions a clinician prints.
 *
 * The clinical copy is the record as the care team reviews it: dense tables,
 * the patient's full details and the clinical notes. The patient copy is the
 * same record handed across the desk: plain wording, larger type, and no
 * clinical notes, which are clinician-only everywhere else in the app too.
 *
 * Everything printed is a field the database holds. Where the Stitch design
 * shows something RecoverEase does not record — a record number, a facility,
 * pain or range-of-motion scores, per-medicine adherence, a written summary,
 * a signature or attestation — it is left out rather than approximated. A
 * printed clinical document is the last place for a plausible-looking guess.
 */

export type ReportVariant = 'clinical' | 'patient'

function moodText(rating: number | null): string {
  if (rating === null) return 'Not rated'
  const option = MOOD_OPTIONS.find((candidate) => candidate.value === rating)
  return option ? `${rating} of 5 · ${option.label}` : `${rating} of 5`
}

function scheduleText(
  schedule: ScheduleWithPrescription,
  variant: ReportVariant,
): string {
  const times = schedule.medication_schedule_times
    .map(formatScheduleTime)
    .join(', ')
  const count = schedule.medication_schedule_frequency

  return variant === 'clinical'
    ? `${count}× daily · ${times}`
    : `${count} ${count === 1 ? 'time' : 'times'} a day at ${times}`
}

export function PatientReport({
  variant,
  data,
  preparedBy,
  generatedAt,
  now = new Date(),
}: {
  variant: ReportVariant
  data: PatientReportData
  /** The signed-in clinician, who generated the report. */
  preparedBy: Doctor | null
  generatedAt: string
  now?: Date
}) {
  const isClinical = variant === 'clinical'
  const density: ReportDensity = isClinical ? 'compact' : 'comfortable'
  const { patient } = data
  const name = fullName(patient.pat_first_name, patient.pat_last_name)
  const age = calculateAge(patient.pat_birth_date, now)
  const overview = summariseReport(data, now)
  const generated = reportDateTime(generatedAt)

  // Named as the patient's clinician only when that is what the record says.
  const clinician =
    preparedBy && preparedBy.doc_id === patient.doc_id
      ? `Dr. ${fullName(preparedBy.doc_first_name, preparedBy.doc_last_name)}`
      : null
  const preparer = preparedBy
    ? `Dr. ${fullName(preparedBy.doc_first_name, preparedBy.doc_last_name)}`
    : null

  const birth = patient.pat_birth_date
    ? `${reportDate(patient.pat_birth_date)}${age !== null ? ` (${age} years)` : ''}`
    : 'Not recorded'

  let sectionCount = 0
  const nextSection = () => String(++sectionCount).padStart(2, '0')

  const goalsShare =
    overview.goals.total > 0 ? (overview.goals.percentage ?? 0) : null
  const { weekAdherence } = data

  return (
    <ReportSheet label={isClinical ? 'Clinical copy' : 'Patient copy'}>
      <ReportLetterhead
        title={isClinical ? 'Patient care report' : 'Patient recovery report'}
        subtitle={
          isClinical
            ? 'Clinical copy · For the care team'
            : 'Patient copy · Your recovery summary'
        }
        meta={
          <>
            <p>
              <span className="text-muted">
                {isClinical ? 'Generated' : 'Prepared'}
              </span>{' '}
              <span className="font-semibold text-heading" data-numeric>
                {generated}
              </span>
            </p>
            {preparer ? (
              <p>
                <span className="text-muted">
                  {isClinical ? 'Prepared by' : 'By'}
                </span>{' '}
                <span className="font-semibold text-heading">{preparer}</span>
              </p>
            ) : null}
          </>
        }
      />

      <ReportFacts
        items={
          isClinical
            ? [
                { label: 'Patient', value: name },
                { label: 'Date of birth', value: birth },
                { label: 'Gender', value: patient.pat_gender ?? 'Not recorded' },
                {
                  label: 'Contact number',
                  value: patient.pat_contact_no ?? 'Not recorded',
                },
                {
                  label: 'Address',
                  value: patient.pat_address ?? 'Not recorded',
                },
                {
                  label: 'Record status',
                  value: patientStatus[patient.pat_status].label,
                },
                { label: 'Registered', value: reportDate(patient.pat_created_at) },
                {
                  label: 'Privacy consent',
                  value: patient.pat_consent_at
                    ? reportDate(patient.pat_consent_at)
                    : 'Not yet given',
                },
                ...(clinician
                  ? [{ label: 'Assigned clinician', value: clinician }]
                  : []),
              ]
            : [
                { label: 'Name', value: name },
                { label: 'Date of birth', value: birth },
                ...(clinician ? [{ label: 'Your doctor', value: clinician }] : []),
                { label: 'Report prepared', value: reportDate(generatedAt) },
              ]
        }
      />

      {/* --- Overview ------------------------------------------------------ */}
      <ReportSection
        number={nextSection()}
        title={isClinical ? 'Recovery overview' : 'Your recovery at a glance'}
        aside={`Records held as of ${reportDate(generatedAt)}`}
      >
        <ReportStats
          items={
            isClinical
              ? [
                  {
                    label: 'Recovery entries',
                    value: String(overview.recoveryEntries),
                    note: 'recorded',
                  },
                  {
                    label: 'Goals achieved',
                    value: `${overview.goals.achieved} / ${overview.goals.total}`,
                    note: 'goals',
                    share: goalsShare,
                  },
                  {
                    label: 'Active plans',
                    value: String(overview.activePlans),
                    note: `of ${overview.totalPlans}`,
                  },
                  {
                    label: 'Current medicines',
                    value: String(overview.currentMedicines),
                    note: 'on schedule',
                  },
                  {
                    label: 'Upcoming appointments',
                    value: String(overview.upcomingAppointments),
                    note: 'booked',
                  },
                ]
              : [
                  {
                    label: 'Journal entries',
                    value: String(overview.recoveryEntries),
                    note: 'written',
                  },
                  {
                    label: 'Goals reached',
                    value: `${overview.goals.achieved} / ${overview.goals.total}`,
                    note: 'goals',
                    share: goalsShare,
                  },
                  {
                    label: 'Treatment plans',
                    value: String(overview.activePlans),
                    note: 'active',
                  },
                  {
                    label: 'Medicines',
                    value: String(overview.currentMedicines),
                    note: 'to take now',
                  },
                  {
                    label: 'Appointments',
                    value: String(overview.upcomingAppointments),
                    note: 'coming up',
                  },
                ]
          }
        />
      </ReportSection>

      {/* --- Recovery log -------------------------------------------------- */}
      <ReportSection
        number={nextSection()}
        title={isClinical ? 'Recovery log' : 'Your recovery journal'}
        aside={
          data.recoveryLogs.length > 0
            ? `${data.recoveryLogs.length} ${data.recoveryLogs.length === 1 ? 'entry' : 'entries'} · newest first`
            : undefined
        }
      >
        {data.recoveryLogs.length === 0 ? (
          <ReportEmpty
            title={
              isClinical
                ? 'No recovery entries recorded'
                : 'No journal entries yet'
            }
          >
            {isClinical
              ? 'The patient has not recorded any recovery entries.'
              : 'Entries you write in RecoverEase will appear here.'}
          </ReportEmpty>
        ) : (
          <ReportTable
            caption={isClinical ? 'Recovery log' : 'Your recovery journal'}
            density={density}
            columns={[
              { label: 'Date', className: 'w-28' },
              {
                label: isClinical ? 'Mood' : 'How you felt',
                className: 'w-32',
              },
              { label: isClinical ? 'Patient notes' : 'Your notes' },
            ]}
          >
            {data.recoveryLogs.map((log) => (
              <ReportRow key={log.recovery_log_id}>
                <ReportCell className="whitespace-nowrap font-semibold text-brand-800">
                  {reportDate(log.recovery_log_date)}
                </ReportCell>
                <ReportCell className="text-heading">
                  {moodText(log.recovery_log_mood_rating)}
                </ReportCell>
                <ReportCell className="whitespace-pre-wrap text-body">
                  {log.recovery_log_notes ?? (
                    <span className="italic text-muted">No notes for this day.</span>
                  )}
                </ReportCell>
              </ReportRow>
            ))}
          </ReportTable>
        )}
      </ReportSection>

      {/* --- Treatment plans and goals ------------------------------------- */}
      <ReportSection
        number={nextSection()}
        title={isClinical ? 'Treatment plans and goals' : 'Your treatment plan'}
      >
        {data.plans.length === 0 ? (
          <ReportEmpty
            title={
              isClinical ? 'No treatment plan on record' : 'No treatment plan yet'
            }
          >
            {isClinical
              ? 'No treatment plan has been created for this patient.'
              : 'Your doctor has not set a treatment plan yet.'}
          </ReportEmpty>
        ) : (
          <div className="space-y-3">
            {data.plans.map((plan) => {
              const progress = summariseGoals(plan.treatment_goal)
              return (
                <div key={plan.treatment_plan_id} className="space-y-2">
                  <div className="break-inside-avoid rounded-[var(--radius-xs)] bg-surface-sunken p-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <p className="text-[13px] font-bold text-brand-800">
                        {plan.treatment_plan_title}
                      </p>
                      <div className="flex items-center gap-2">
                        <span
                          className="text-[8.5px] font-semibold uppercase tracking-wider text-muted"
                          data-numeric
                        >
                          {reportDate(plan.treatment_plan_start_date)} –{' '}
                          {plan.treatment_plan_end_date
                            ? reportDate(plan.treatment_plan_end_date)
                            : 'ongoing'}
                        </span>
                        <ReportStatus
                          status={treatmentPlanStatus[plan.treatment_plan_status]}
                        />
                      </div>
                    </div>
                    {plan.treatment_plan_description ? (
                      <p className="mt-1 whitespace-pre-wrap text-[11px] leading-4 text-body">
                        {plan.treatment_plan_description}
                      </p>
                    ) : null}
                    {progress.total > 0 ? (
                      <p className="mt-1 text-[10px] text-muted" data-numeric>
                        {progress.achieved} of {progress.total}{' '}
                        {isClinical ? 'goals achieved' : 'goals reached'}
                      </p>
                    ) : null}
                  </div>

                  {plan.treatment_goal.length === 0 ? (
                    <ReportEmpty title="No goals set for this plan" />
                  ) : (
                    <ReportTable
                      caption={`Goals: ${plan.treatment_plan_title}`}
                      density={density}
                      columns={[
                        { label: 'Goal' },
                        {
                          label: isClinical ? 'Target date' : 'Aim to reach by',
                          className: 'w-32',
                        },
                        {
                          label: isClinical ? 'Status' : 'Progress',
                          className: 'w-28',
                        },
                      ]}
                    >
                      {plan.treatment_goal.map((goal) => (
                        <ReportRow key={goal.treatment_goal_id}>
                          <ReportCell className="font-medium text-heading">
                            {goal.treatment_goal_description}
                          </ReportCell>
                          <ReportCell className="whitespace-nowrap text-body">
                            {goal.treatment_goal_target_date
                              ? reportDate(goal.treatment_goal_target_date)
                              : 'No target date'}
                          </ReportCell>
                          <ReportCell>
                            <ReportStatus
                              status={treatmentGoalStatus[goal.treatment_goal_status]}
                            />
                          </ReportCell>
                        </ReportRow>
                      ))}
                    </ReportTable>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </ReportSection>

      {/* --- Medication ---------------------------------------------------- */}
      <ReportSection
        number={nextSection()}
        title={
          isClinical ? 'Prescriptions and medication schedule' : 'Your medicines'
        }
      >
        {data.schedules.length === 0 ? (
          <ReportEmpty
            title={
              isClinical ? 'No prescriptions on record' : 'No medicines prescribed'
            }
          >
            {isClinical
              ? 'No prescriptions have been issued for this patient.'
              : 'No medicines are prescribed for you at the moment.'}
          </ReportEmpty>
        ) : (
          <div className="space-y-2">
            <ReportTable
              caption={isClinical ? 'Medication schedule' : 'Your medicines'}
              density={density}
              columns={[
                { label: 'Medicine' },
                { label: isClinical ? 'Dosage' : 'Dose', className: 'w-24' },
                {
                  label: isClinical ? 'Schedule' : 'When to take it',
                  className: 'w-44',
                },
                { label: isClinical ? 'Start' : 'Started', className: 'w-24' },
                { label: isClinical ? 'End' : 'Until', className: 'w-24' },
              ]}
            >
              {data.schedules.map((schedule) => (
                <ReportRow key={schedule.medication_schedule_id}>
                  <ReportCell>
                    <span className="font-semibold text-brand-800">
                      {schedule.medication_schedule_name}
                    </span>
                    {schedule.prescription?.prescription_notes ? (
                      <span className="mt-0.5 block whitespace-pre-wrap text-muted">
                        {schedule.prescription.prescription_notes}
                      </span>
                    ) : null}
                  </ReportCell>
                  <ReportCell className="text-heading">
                    {schedule.medication_schedule_dosage}
                  </ReportCell>
                  <ReportCell className="text-body">
                    <span data-numeric>{scheduleText(schedule, variant)}</span>
                  </ReportCell>
                  <ReportCell className="whitespace-nowrap text-body">
                    {reportDate(schedule.medication_schedule_start_date)}
                  </ReportCell>
                  <ReportCell className="whitespace-nowrap text-body">
                    {schedule.medication_schedule_end_date
                      ? reportDate(schedule.medication_schedule_end_date)
                      : 'Ongoing'}
                  </ReportCell>
                </ReportRow>
              ))}
            </ReportTable>

            {/* The same seven-day figure the patient record shows. Doses
                still to come are not counted against the patient. */}
            <p className="break-inside-avoid text-[10.5px] text-body" data-numeric>
              {weekAdherence.resolved === 0
                ? 'No doses were due in the last 7 days.'
                : isClinical
                  ? `Doses due in the last 7 days: ${weekAdherence.taken} taken, ${weekAdherence.missed} missed, ${weekAdherence.skipped} skipped of ${weekAdherence.resolved}${weekAdherence.rate !== null ? ` (${weekAdherence.rate}% taken)` : ''}.`
                  : `In the last 7 days you took ${weekAdherence.taken} of the ${weekAdherence.resolved} doses that were due.`}
            </p>
          </div>
        )}
      </ReportSection>

      {/* --- Appointments -------------------------------------------------- */}
      <ReportSection
        number={nextSection()}
        title={isClinical ? 'Appointment history' : 'Your appointments'}
        aside={
          data.appointments.length > 0
            ? `${data.appointments.length} on record · newest first`
            : undefined
        }
      >
        {data.appointments.length === 0 ? (
          <ReportEmpty
            title={
              isClinical ? 'No appointments on record' : 'No appointments yet'
            }
          >
            {isClinical
              ? 'No appointments have been scheduled for this patient.'
              : 'You have no appointments on record.'}
          </ReportEmpty>
        ) : (
          <ReportTable
            caption={isClinical ? 'Appointment history' : 'Your appointments'}
            density={density}
            columns={[
              { label: 'Date', className: 'w-32' },
              { label: 'Time', className: 'w-20' },
              { label: 'Status' },
            ]}
          >
            {data.appointments.map((appointment) => (
              <ReportRow key={appointment.appointment_id}>
                <ReportCell className="whitespace-nowrap font-semibold text-brand-800">
                  {reportDate(appointment.appointment_date)}
                </ReportCell>
                <ReportCell className="whitespace-nowrap text-body">
                  <span data-numeric>{reportTime(appointment.appointment_date)}</span>
                </ReportCell>
                <ReportCell>
                  <ReportStatus
                    status={appointmentStatus[appointment.appointment_status]}
                  />
                </ReportCell>
              </ReportRow>
            ))}
          </ReportTable>
        )}
      </ReportSection>

      {/* --- Clinical notes: clinical copy only ---------------------------- */}
      {isClinical ? (
        <ReportSection
          number={nextSection()}
          title="Clinical notes"
          aside="Clinician-only · not on the patient copy"
        >
          {data.notes.length === 0 ? (
            <ReportEmpty title="No clinical notes recorded">
              No notes have been written for this patient.
            </ReportEmpty>
          ) : (
            <ol className="space-y-2">
              {data.notes.map((note) => (
                <li
                  key={note.doctor_note_id}
                  className="break-inside-avoid rounded-[var(--radius-xs)] bg-surface-sunken px-3 py-2.5"
                >
                  <p
                    className="text-[9.5px] font-semibold uppercase tracking-wider text-muted"
                    data-numeric
                  >
                    {reportDateTime(note.doctor_note_created_at)}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-[11px] leading-4 text-heading [overflow-wrap:anywhere]">
                    {note.doctor_note_text}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </ReportSection>
      ) : null}

      {/* --- Prepared by: clinical copy only ------------------------------- */}
      {isClinical ? (
        <section className="mt-8 grid gap-6 break-inside-avoid border-t border-neutral-200 pt-4 sm:grid-cols-2 print:mt-6 print:grid-cols-2">
          <div>
            <p className="text-[8.5px] font-semibold uppercase tracking-wider text-muted">
              Prepared by
            </p>
            <p className="mt-1 text-[13px] font-semibold text-heading">
              {preparer ?? 'Not recorded'}
            </p>
            {preparedBy?.doc_specialization ? (
              <p className="text-[10px] text-body">
                {preparedBy.doc_specialization}
              </p>
            ) : null}
            {preparedBy ? (
              <p className="text-[10px] text-muted">
                Licence no. {preparedBy.doc_license_no}
              </p>
            ) : null}
          </div>
          {/* Blank lines to sign by hand. RecoverEase has no electronic
              signature, so the page does not claim one. */}
          <div className="grid grid-cols-[2fr_1fr] items-end gap-4">
            <div>
              <div aria-hidden="true" className="h-8 border-b border-neutral-800" />
              <p className="mt-1 text-[8.5px] uppercase tracking-wider text-muted">
                Clinician signature
              </p>
            </div>
            <div>
              <div aria-hidden="true" className="h-8 border-b border-neutral-800" />
              <p className="mt-1 text-[8.5px] uppercase tracking-wider text-muted">
                Date
              </p>
            </div>
          </div>
        </section>
      ) : null}

      <ReportFooter generated={generated} />
    </ReportSheet>
  )
}
