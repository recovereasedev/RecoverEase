import { addDays } from 'date-fns'
import { CalendarPlus } from 'lucide-react'
import { useState } from 'react'

import { FormError } from '@/components/feedback/form-error'
import { SavedNotice } from '@/components/feedback/state-view'
import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { Field, Select } from '@/components/ui/field'
import { PageSection } from '@/components/ui/section-heading'
import { fetchAllDoses } from '@/features/medications/api'
import {
  buildReminderCalendar,
  REMINDER_LEADS,
  type ReminderLead,
} from '@/features/medications/reminder-calendar'
import { saveFile } from '@/lib/documents/download'

/** Dose slots are made 30 days ahead (migration 09), so that is what a file can hold. */
const DAYS_AHEAD = 30

const LEAD_LABEL: Record<ReminderLead, string> = {
  5: '5 minutes before, and at the time',
  10: '10 minutes before, and at the time',
  15: '15 minutes before, and at the time',
  30: '30 minutes before, and at the time',
  0: 'At the time only',
}

/**
 * Offline medication reminders: the patient's upcoming doses, saved to their
 * phone's own calendar, whose alarms go off without a connection and with
 * RecoverEase closed (`reminder-calendar.ts` says why this is the honest way
 * to do it on the web). There is no "offline reminders on" switch, because
 * nothing here runs in the background: the patient downloads a file, and the
 * page says plainly what that file does and does not do.
 */
export function PhoneReminders({
  patient,
}: {
  patient: { pat_id: string; pat_first_name: string; pat_last_name: string }
}) {
  const [lead, setLead] = useState<ReminderLead>(10)
  const [includeNames, setIncludeNames] = useState(true)
  const [isPending, setPending] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [result, setResult] = useState<{ message: string; at: number } | null>(null)

  const download = async () => {
    setPending(true)
    setError(null)
    setResult(null)
    try {
      const now = new Date()
      const doses = await fetchAllDoses({
        patientId: patient.pat_id,
        from: now.toISOString(),
        to: addDays(now, DAYS_AHEAD + 1).toISOString(),
      })
      const file = buildReminderCalendar({
        patient,
        doses,
        leadMinutes: lead,
        includeNames,
        generatedAt: now,
      })
      if (file.count === 0) {
        setResult({ message: 'There are no upcoming doses to add yet.', at: Date.now() })
        return
      }
      saveFile(file)
      setResult({
        message: `Saved ${file.count} dose ${file.count === 1 ? 'time' : 'times'} for the next ${DAYS_AHEAD} days. Open the file to add them to your calendar.`,
        at: Date.now(),
      })
    } catch (cause) {
      setError(cause)
    } finally {
      setPending(false)
    }
  }

  return (
    <PageSection
      className="print:hidden"
      title="Reminders on your phone"
      description="Your phone's calendar can remind you of each dose, even with no internet and RecoverEase closed."
    >
      <Card>
        <CardBody className="space-y-4">
          <Field label="Remind me">
            <Select
              value={lead}
              onChange={(event) => setLead(Number(event.target.value) as ReminderLead)}
            >
              {REMINDER_LEADS.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {LEAD_LABEL[minutes]}
                </option>
              ))}
            </Select>
          </Field>

          <label className="flex cursor-pointer items-start gap-3 rounded-[var(--radius-md)] bg-surface-sunken p-3 transition-colors hover:bg-neutral-200/60">
            <input
              type="checkbox"
              checked={includeNames}
              onChange={(event) => setIncludeNames(event.target.checked)}
              className="mt-0.5 size-5 shrink-0 rounded border-[var(--color-border-strong)] accent-brand-700"
            />
            <span>
              <span className="block font-medium text-heading">Show medicine names</span>
              <span className="block text-sm text-muted">
                If your calendar syncs to an online account, the names go there too. Turned
                off, each reminder says only &ldquo;Medicine due&rdquo;.
              </span>
            </span>
          </label>

          {error ? <FormError error={error} title="The reminders were not downloaded" /> : null}

          <div className="space-y-2">
            <Button
              variant="outline"
              className="max-sm:w-full"
              onClick={() => void download()}
              isLoading={isPending}
              loadingLabel="Preparing…"
            >
              <CalendarPlus aria-hidden="true" />
              Download reminders (.ics)
            </Button>
            <SavedNotice {...(result ? { at: result.at } : {})}>{result?.message}</SavedNotice>
          </div>

          <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
            <li>The reminders do not change by themselves. When your prescription changes, delete the old ones and download a new file.</li>
            <li>They cover the doses scheduled for the next {DAYS_AHEAD} days.</li>
            <li>Mark each dose as taken here, in RecoverEase.</li>
          </ul>
        </CardBody>
      </Card>
    </PageSection>
  )
}
