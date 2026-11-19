import type { DoseWithSchedule } from '@/features/medications/api'
import { documentFileName, type DownloadableFile } from '@/lib/documents/download'

/**
 * Offline medication reminders (the adviser's "Offline Medication Reminders
 * (Patient)"), as a calendar file the patient adds to their phone.
 *
 * A website cannot promise to alert a phone that is offline with the site
 * closed: a web push needs a connection to arrive, and no browser lets a page
 * schedule an alert for later on its own (the Notification Triggers proposal
 * was abandoned). The phone's own calendar can: an event's alarm is kept on
 * the device and goes off at its time with or without a connection. So this
 * writes the patient's upcoming doses as an iCalendar file (RFC 5545) - one
 * event per dose time, each with an alarm before it and one at it - for the
 * patient to open in their calendar app.
 *
 * What it is, plainly:
 *
 * - **The doses that exist.** Only pending dose slots from now to the end of
 *   the slots the scheduled job has made (30 days ahead) - the same doses
 *   the Medications page lists. Nothing is projected past them.
 * - **A copy, not a link.** The file does not update itself. A changed or
 *   ended prescription needs a new file, and the old events removed, so the
 *   page says so. Recording a dose is still done in RecoverEase.
 * - **The patient's choice of words.** With names off, an event says only
 *   "Medicine due (RecoverEase)", for a calendar that syncs to an account
 *   the patient would rather not hold medicine names.
 *
 * Built on the device from what the patient's own access returns; nothing is
 * uploaded or stored.
 */

export const ICS_TYPE = 'text/calendar'

/** Minutes before a dose time the first alarm goes off; 0 is at the time only. */
export const REMINDER_LEADS = [5, 10, 15, 30, 0] as const
export type ReminderLead = (typeof REMINDER_LEADS)[number]

export type ReminderCalendarInput = {
  patient: { pat_first_name: string; pat_last_name: string }
  doses: readonly DoseWithSchedule[]
  leadMinutes: ReminderLead
  includeNames: boolean
  generatedAt: Date
}

/** `20261104T000000Z`: an instant in iCalendar's UTC form. */
function icsInstant(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

/** A TEXT value, escaped as RFC 5545 section 3.3.11 asks. */
export function icsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n')
}

/**
 * A content line folded at 75 octets (RFC 5545 section 3.1): each further
 * piece starts on a new line with one space. A character is never split
 * across two pieces.
 */
export function foldLine(line: string): string {
  const encoder = new TextEncoder()
  const pieces: string[] = []
  let current = ''
  let octets = 0
  for (const char of line) {
    const size = encoder.encode(char).length
    // The first line holds 75 octets; the rest 74, after their space.
    const limit = pieces.length === 0 ? 75 : 74
    if (octets + size > limit) {
      pieces.push(current)
      current = ''
      octets = 0
    }
    current += char
    octets += size
  }
  pieces.push(current)
  return pieces.join('\r\n ')
}

type DoseTime = { at: Date; doses: DoseWithSchedule[] }

/** The pending doses still to come, gathered by the moment they are due. */
export function upcomingDoseTimes(doses: readonly DoseWithSchedule[], now: Date): DoseTime[] {
  const byTime = new Map<number, DoseWithSchedule[]>()
  for (const dose of doses) {
    if (dose.medication_log_status !== 'pending') continue
    const at = new Date(dose.medication_log_scheduled_at).getTime()
    if (Number.isNaN(at) || at <= now.getTime()) continue
    byTime.set(at, [...(byTime.get(at) ?? []), dose])
  }
  return [...byTime.entries()]
    .sort(([a], [b]) => a - b)
    .map(([at, list]) => ({
      at: new Date(at),
      doses: [...list].sort((a, b) => a.medication_log_id.localeCompare(b.medication_log_id)),
    }))
}

function medicineNames(doses: readonly DoseWithSchedule[]): string {
  return doses
    .map((dose) =>
      dose.medication_schedule
        ? `${dose.medication_schedule.medication_schedule_name} ${dose.medication_schedule.medication_schedule_dosage}`
        : 'your medicine',
    )
    .join(', ')
}

export function buildReminderCalendar(input: ReminderCalendarInput): DownloadableFile & { count: number } {
  const stamp = icsInstant(input.generatedAt)
  const times = upcomingDoseTimes(input.doses, input.generatedAt)
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//RecoverEase//Medication reminders//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsText('RecoverEase medicine reminders')}`,
  ]

  for (const { at, doses } of times) {
    const summary = input.includeNames
      ? `Take ${medicineNames(doses)}`
      : 'Medicine due (RecoverEase)'
    const description = input.includeNames
      ? 'A dose your doctor scheduled in RecoverEase. Record it in RecoverEase once you have taken it.'
      : 'A dose your doctor scheduled in RecoverEase. Open RecoverEase to see which medicine, and record it once taken.'
    const end = new Date(at.getTime() + 15 * 60_000)

    lines.push(
      'BEGIN:VEVENT',
      // The first dose's id: the same dose time gets the same event if the
      // patient downloads again, so a calendar that honours UIDs updates it.
      `UID:dose-${doses[0]!.medication_log_id}@recoverease`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsInstant(at)}`,
      `DTEND:${icsInstant(end)}`,
      `SUMMARY:${icsText(summary)}`,
      `DESCRIPTION:${icsText(description)}`,
      'TRANSP:TRANSPARENT',
    )
    if (input.leadMinutes > 0) {
      lines.push(
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        `DESCRIPTION:${icsText(`${summary} in ${input.leadMinutes} minutes`)}`,
        `TRIGGER:-PT${input.leadMinutes}M`,
        'END:VALARM',
      )
    }
    lines.push(
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${icsText(`${summary} now`)}`,
      'TRIGGER:PT0M',
      'END:VALARM',
      'END:VEVENT',
    )
  }
  lines.push('END:VCALENDAR')

  const text = `${lines.map(foldLine).join('\r\n')}\r\n`
  return {
    bytes: new TextEncoder().encode(text),
    mimeType: ICS_TYPE,
    fileName: documentFileName(
      ['medicine-reminders', input.patient.pat_first_name, input.patient.pat_last_name],
      input.generatedAt,
      'ics',
    ),
    count: times.length,
  }
}
