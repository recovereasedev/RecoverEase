import { useId, useState } from 'react'

import { FormError } from '@/components/feedback/form-error'
import type { MedicationSchedule } from '@/features/medications/api'
import { useSetMedicationReminders } from '@/features/medications/hooks'
import { cn } from '@/lib/utils'

/**
 * The doctor's reminder switch on one medicine (migration 59).
 *
 * On unless the doctor turns it off. It decides reminders only: the doses
 * stay on the patient's checklist and still become missed when not recorded.
 * A reminder also needs the patient's own setting, which this never touches.
 * The app never decides for the doctor which medicine needs reminders.
 */

type SwitchableSchedule = Pick<
  MedicationSchedule,
  'medication_schedule_id' | 'medication_schedule_name'
> &
  Partial<Pick<MedicationSchedule, 'medication_schedule_reminders_is_enabled'>>

/** Off only when the doctor said so: a schedule read without the column is on. */
export function remindersAreOn(
  schedule: Partial<Pick<MedicationSchedule, 'medication_schedule_reminders_is_enabled'>>,
): boolean {
  return schedule.medication_schedule_reminders_is_enabled !== false
}

export function MedicationReminderSwitch({
  patientId,
  schedule,
}: {
  patientId: string
  schedule: SwitchableSchedule
}) {
  // One mutation per medicine, so each row saves, fails and confirms alone.
  const setReminders = useSetMedicationReminders(patientId)
  const [wasSaved, setSaved] = useState(false)
  const helpId = useId()
  const isOn = remindersAreOn(schedule)

  return (
    <div className="mt-2 rounded-[var(--radius-md)] bg-surface-sunken px-3 py-2 print:hidden">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-heading">
          Medication reminders {isOn ? 'ON' : 'OFF'}
        </p>
        <button
          type="button"
          role="switch"
          aria-checked={isOn}
          // Names the medicine, so a list of several reads as distinct switches.
          aria-label={`Medication reminders: ${schedule.medication_schedule_name}`}
          aria-describedby={helpId}
          // Disabled while saving: a second press cannot send a conflicting change.
          disabled={setReminders.isPending}
          onClick={() => {
            setSaved(false)
            setReminders.mutate(
              { scheduleId: schedule.medication_schedule_id, enabled: !isOn },
              { onSuccess: () => setSaved(true) },
            )
          }}
          className={cn(
            'relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border-2 border-transparent',
            'transition-colors duration-[var(--duration-fast)] disabled:cursor-not-allowed disabled:opacity-50',
            isOn ? 'bg-fill-brand-800' : 'bg-neutral-400',
          )}
        >
          <span
            aria-hidden
            className={cn(
              'inline-block size-6 rounded-full bg-white shadow transition-transform duration-[var(--duration-fast)]',
              isOn ? 'translate-x-5' : 'translate-x-0',
            )}
          />
        </button>
      </div>
      <p id={helpId} className="mt-0.5 text-xs text-muted">
        For this medicine only. Doses stay on the patient’s schedule either way.
      </p>
      {setReminders.isPending ? (
        <p role="status" className="mt-1 text-xs text-muted">
          Saving…
        </p>
      ) : wasSaved ? (
        <p role="status" className="mt-1 text-xs text-muted">
          Saved.
        </p>
      ) : null}
      {setReminders.isError ? (
        <div className="mt-2">
          <FormError error={setReminders.error} title="The reminder setting was not saved" />
        </div>
      ) : null}
    </div>
  )
}

/** What the patient reads under a medicine whose reminders the doctor turned off. */
export function RemindersOffNotice() {
  // A span: it sits inside a row's description, among other spans.
  return (
    <span className="mt-0.5 block text-sm text-muted">
      Medication reminders are turned off by your doctor.
    </span>
  )
}
