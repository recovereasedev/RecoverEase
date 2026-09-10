import { FileText, Printer, X } from 'lucide-react'
import { useId, useState } from 'react'

import { ErrorState, LoadingState } from '@/components/feedback/state-view'
import { Button } from '@/components/ui/button'
import { useCurrentUser } from '@/features/auth/auth-context'
import { cn } from '@/lib/utils'

import { usePatientReportData } from '../report-data'
import { PatientReport, type ReportVariant } from './patient-report'

const VARIANTS = [
  {
    id: 'clinical',
    label: 'Clinical copy',
    hint: 'Everything on record, including your clinical notes.',
  },
  {
    id: 'patient',
    label: 'Patient copy',
    hint: 'Plain wording for the patient. Clinical notes are left out.',
  },
] as const satisfies readonly {
  id: ReportVariant
  label: string
  hint: string
}[]

/**
 * The report just recorded, as the document that will be printed.
 *
 * The controls — which copy, print, close — sit in a bar above the sheet and
 * are hidden in print, so none of them can end up on the paper. The sheet
 * itself is the same component the printer receives, not a picture of it.
 */
export function ReportPreview({
  patientId,
  generatedAt,
  onPrint,
  onClose,
  className,
}: {
  patientId: string
  /** When the report row was recorded. */
  generatedAt: string | null
  onPrint: () => void
  onClose: () => void
  className?: string
}) {
  const user = useCurrentUser()
  const preparedBy = user.profile.kind === 'doctor' ? user.profile.doctor : null
  const [variant, setVariant] = useState<ReportVariant>('clinical')
  // Stands in only if the row came back without its timestamp, and is fixed
  // for the life of the preview so the printed time cannot drift.
  const [openedAt] = useState(() => new Date().toISOString())
  const report = usePatientReportData(patientId)
  const headingId = useId()
  const hint = VARIANTS.find((candidate) => candidate.id === variant)?.hint

  return (
    <section
      aria-labelledby={headingId}
      data-report-preview
      className={cn('mt-8 print:mt-0', className)}
    >
      <div className="flex flex-col gap-4 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-surface p-4 sm:p-5 lg:flex-row lg:items-center lg:justify-between print:hidden">
        <div className="min-w-0">
          <h2
            id={headingId}
            className="flex items-center gap-2 text-headline-md text-heading"
          >
            <FileText className="size-5 text-accent-700" aria-hidden="true" />
            Report preview
          </h2>
          <p className="mt-1 text-sm text-muted">
            {hint} Only the document below is printed.
          </p>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <div
            role="group"
            aria-label="Report version"
            className="flex rounded-[var(--radius-md)] bg-surface-sunken p-1"
          >
            {VARIANTS.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                aria-pressed={variant === candidate.id}
                onClick={() => setVariant(candidate.id)}
                className={cn(
                  'h-10 flex-1 whitespace-nowrap rounded-[var(--radius-sm)] px-3 text-sm font-medium transition-colors duration-[var(--duration-fast)]',
                  variant === candidate.id
                    ? 'bg-surface text-brand-800 shadow-[var(--shadow-xs)]'
                    : 'text-body hover:text-heading',
                )}
              >
                {candidate.label}
              </button>
            ))}
          </div>

          <Button
            className="max-sm:w-full"
            onClick={onPrint}
            disabled={!report.data}
          >
            <Printer aria-hidden="true" />
            Print or save as PDF
          </Button>
          <Button variant="ghost" className="max-sm:w-full" onClick={onClose}>
            <X aria-hidden="true" />
            Close preview
          </Button>
        </div>
      </div>

      <div className="mt-4 rounded-[var(--radius-lg)] bg-surface-sunken px-2 py-4 sm:p-6 print:mt-0 print:rounded-none print:bg-transparent print:p-0!">
        {report.error ? (
          <ErrorState error={report.error} onRetry={report.retry} />
        ) : report.data ? (
          <PatientReport
            variant={variant}
            data={report.data}
            preparedBy={preparedBy}
            generatedAt={generatedAt ?? openedAt}
          />
        ) : (
          <LoadingState label="Preparing the report…" />
        )}
      </div>
    </section>
  )
}
