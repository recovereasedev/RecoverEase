import type { AppointmentWithPatient } from '@/features/appointments/api'
import type { DoseWithSchedule } from '@/features/medications/api'
import { formatTime } from '@/lib/format'
import { fullName } from '@/lib/utils'

/**
 * The 2nd-half plan, section 6: the "10-minute reminder popup" - an in-app,
 * non-blocking reminder of a dose or an appointment that is nearly due.
 *
 * It is a surface for reminders that already exist, not a second reminder
 * system, and it never decides anything the server has not:
 *
 *   - **A dose** is shown once the server has sent its reminder before the
 *     dose (migration 37 stamps `medication_log_pre_dose_sent_at`). So it
 *     keeps every rule that reminder keeps - the clinic's lead time, ten
 *     minutes unless the clinic set 5, 15 or 30; the patient's choice not to
 *     be reminded; their preferred time of day; the course's end - and needs
 *     no rule of its own about when "ten minutes before" is. It stays until
 *     the dose is recorded, the patient dismisses it, or the follow-up takes
 *     over 30 minutes after the dose time, as that job always has
 *     (migration 09).
 *   - **An appointment** is shown from ten minutes before it starts, as the
 *     plan has it, until it starts. Nothing on the server sends one then -
 *     the appointment reminder is a day ahead - so this one is worked out
 *     here, from the appointments the page already has. Only a scheduled or
 *     confirmed one counts.
 *
 * It only shows while RecoverEase is open. The reminders that reach a
 * patient when it is closed are the notifications, which this does not
 * replace.
 */

export type ReminderItem =
  | {
      kind: 'dose'
      id: string
      doseId: string
      /** e.g. "Medication due in 10 minutes", "Medication due now". */
      title: string
      /** e.g. "Amoxicillin 500 mg at 08:00". */
      detail: string
      medicine: string
      dueAt: number
      /**
       * Whether "Remind me in 5 min" can keep its word: false in the last
       * five minutes before the follow-up takes over, when a snoozed card
       * would never come back.
       */
      canSnooze: boolean
    }
  | {
      kind: 'appointment'
      id: string
      title: string
      /** e.g. "Dr. Alan Cruz · 14:30", or the patient's name for a doctor. */
      detail: string
      /** Where its action goes: the appointments page, or the patient's record. */
      href: string
      actionLabel: string
      startsAt: number
    }

export type DoseReminder = Extract<ReminderItem, { kind: 'dose' }>
export type AppointmentReminder = Extract<ReminderItem, { kind: 'appointment' }>

export const APPOINTMENT_LEAD_MS = 10 * 60_000
/** The follow-up reminder's delay (migration 09): the dose is its from then. */
export const FOLLOW_UP_AFTER_MS = 30 * 60_000
export const SNOOZE_MS = 5 * 60_000

/** Whole minutes to go, rounded up, so "in 10 minutes" means at most ten. */
export function minutesUntil(at: number, now: number): number {
  return Math.ceil((at - now) / 60_000)
}

function inMinutes(minutes: number): string {
  return minutes === 1 ? 'in 1 minute' : `in ${minutes} minutes`
}

export type ReminderState = {
  /** Reminders the patient has dismissed, by item id. */
  dismissed: ReadonlySet<string>
  /** Reminders snoozed, by item id, until when. */
  snoozedUntil: Readonly<Record<string, number>>
}

const isHidden = (id: string, state: ReminderState, now: number) =>
  state.dismissed.has(id) || (state.snoozedUntil[id] ?? 0) > now

/** The patient's doses to remind them of now. */
export function doseReminders(
  doses: DoseWithSchedule[],
  now: number,
  state: ReminderState,
): DoseReminder[] {
  const items: DoseReminder[] = []
  for (const dose of doses) {
    if (dose.medication_log_status !== 'pending') continue
    // The server has not reminded them - not yet due for one, reminders
    // turned off, before their preferred time - so neither does this.
    if (!dose.medication_log_pre_dose_sent_at) continue
    const dueAt = Date.parse(dose.medication_log_scheduled_at)
    if (Number.isNaN(dueAt) || now >= dueAt + FOLLOW_UP_AFTER_MS) continue
    const id = `dose:${dose.medication_log_id}`
    if (isHidden(id, state, now)) continue

    const medicine = dose.medication_schedule?.medication_schedule_name ?? 'Your medicine'
    const dosage = dose.medication_schedule?.medication_schedule_dosage
    const minutes = minutesUntil(dueAt, now)
    items.push({
      kind: 'dose',
      id,
      doseId: dose.medication_log_id,
      title: minutes > 0 ? `Medication due ${inMinutes(minutes)}` : 'Medication due now',
      detail: `${medicine}${dosage ? ` ${dosage}` : ''} at ${formatTime(dose.medication_log_scheduled_at)}`,
      medicine,
      dueAt,
      canSnooze: dueAt + FOLLOW_UP_AFTER_MS - now >= SNOOZE_MS,
    })
  }
  return items.sort((a, b) => a.dueAt - b.dueAt)
}

/** Appointments starting within ten minutes, as the patient or the doctor sees them. */
export function appointmentReminders(
  appointments: AppointmentWithPatient[],
  now: number,
  state: ReminderState,
  viewer:
    | { role: 'patient'; doctorName: string | null }
    | { role: 'doctor' },
): AppointmentReminder[] {
  const items: AppointmentReminder[] = []
  for (const appointment of appointments) {
    if (appointment.appointment_status !== 'scheduled' && appointment.appointment_status !== 'confirmed') {
      continue
    }
    const startsAt = Date.parse(appointment.appointment_date)
    if (Number.isNaN(startsAt) || startsAt <= now || startsAt - now > APPOINTMENT_LEAD_MS) continue
    const id = `appointment:${appointment.appointment_id}`
    if (isHidden(id, state, now)) continue

    const time = formatTime(appointment.appointment_date)
    const who =
      viewer.role === 'patient'
        ? viewer.doctorName
        : appointment.patient
          ? fullName(appointment.patient.pat_first_name, appointment.patient.pat_last_name)
          : null
    items.push({
      kind: 'appointment',
      id,
      title: `Appointment ${inMinutes(minutesUntil(startsAt, now))}`,
      detail: who ? `${who} · ${time}` : time,
      href:
        viewer.role === 'patient'
          ? '/patient/appointments'
          : `/doctor/patients/${appointment.pat_id}`,
      actionLabel: viewer.role === 'patient' ? 'View appointment' : 'Open record',
      startsAt,
    })
  }
  return items.sort((a, b) => a.startsAt - b.startsAt)
}
