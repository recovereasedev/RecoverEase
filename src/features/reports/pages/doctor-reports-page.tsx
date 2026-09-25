import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileBarChart, Printer } from 'lucide-react'
import { useState } from 'react'
import { flushSync } from 'react-dom'

import { FormError } from '@/components/feedback/form-error'
import {
  EmptyState,
  SavedNotice,
  StateView,
} from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { ListRow, ListRows } from '@/components/ui/list-row'
import { PageSection } from '@/components/ui/section-heading'
import { Combobox, Field } from '@/components/ui/field'
import { useCurrentUser } from '@/features/auth/auth-context'
import { useMyPatients } from '@/features/patients/hooks'
import { fetchReports, recordGeneratedReport } from '@/features/reports/api'
import { ReportLetterhead } from '@/features/reports/components/report-document'
import { ReportPreview } from '@/features/reports/components/report-preview'
import { reportDateTime } from '@/features/reports/report-format'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { useNow } from '@/hooks/use-now'
import { formatDateTime } from '@/lib/format'
import { queryKeys } from '@/lib/query-keys'
import { cn, fullName } from '@/lib/utils'

type PrintTarget = 'report' | 'list'

/**
 * Modules 9.1 "Generate Recovery Report" and 9.2 "Download/Print Recovery
 * Report".
 *
 * Generating a report records that it happened — who produced it, about whom
 * and when — which is what makes the report table an accountable record
 * rather than a list of files. The document itself then opens below as a
 * preview, in a clinical and a patient copy, and is produced through the
 * browser's print pipeline, which yields a real PDF via "Save as PDF" on
 * every platform.
 */
export function DoctorReportsPage() {
  useDocumentTitle('Reports')
  const user = useCurrentUser()
  const queryClient = useQueryClient()
  const patientsQuery = useMyPatients()
  const [selectedPatientId, setSelectedPatientId] = useState('')

  const reportsQuery = useQuery({
    queryKey: queryKeys.reports.list(),
    queryFn: fetchReports,
  })

  const generate = useMutation({
    mutationFn: (patientId: string) =>
      recordGeneratedReport({
        userId: user.userId,
        type: 'patient_recovery',
        patientId,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.reports.all })
    },
  })

  // The document shown is always the one just recorded: the patient the
  // mutation ran for, not whoever the picker happens to show now.
  const previewPatientId =
    generate.isSuccess && generate.variables ? generate.variables : null

  // What goes to paper. With a report open, printing means the report — the
  // browser's own Print as much as the button. "Print list" asks for the list
  // explicitly, and printing goes back to the report once it is done.
  const [printTarget, setPrintTarget] = useState<PrintTarget>('report')
  const printOnly = (target: PrintTarget) => {
    // Committed before the print dialog snapshots the page.
    flushSync(() => setPrintTarget(target))
    window.addEventListener('afterprint', () => setPrintTarget('report'), {
      once: true,
    })
    window.print()
  }
  const isPageHiddenInPrint =
    previewPatientId !== null && printTarget === 'report'

  // Named on paper as the report names its preparer.
  const clinician =
    user.profile.kind === 'doctor'
      ? `Dr. ${fullName(
          user.profile.doctor.doc_first_name,
          user.profile.doctor.doc_last_name,
        )}`
      : null

  return (
    <>
      <div className={cn(isPageHiddenInPrint && 'print:hidden')}>
        {/* The header and the form are the screen's, as is "Print list": the
            printout of this page is the list of generated reports. */}
        <PageHeader
          title="Reports"
          description="Recovery reports you have generated."
          className="print:hidden"
        />

        {/* A block on paper, so the list below can take its named page. */}
        <div className="grid gap-section lg:grid-cols-3 lg:gap-8 print:block">
          <PageSection
            title="Generate a recovery report"
            className="h-fit print:hidden lg:col-span-1"
          >
            <Card>
              <CardBody>
                <form
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (selectedPatientId) generate.mutate(selectedPatientId)
                  }}
                  className="space-y-4"
                >
                  <Field label="Patient" required>
                    {/* Searchable rather than a native select, for the same
                        reason as the scheduling dialog: a full caseload is a
                        long list to scroll. It reads the same `useMyPatients()`
                        list as before, so it still offers only this clinician's
                        own patients, and still yields a patient id. */}
                    <Combobox
                      options={(patientsQuery.data ?? []).map((patient) => ({
                        value: patient.pat_id,
                        label: fullName(
                          patient.pat_first_name,
                          patient.pat_last_name,
                        ),
                      }))}
                      value={selectedPatientId}
                      onChange={(patientId) => {
                        // Choosing someone else closes the preview, rather than
                        // leaving one patient's record under another's name.
                        if (patientId !== selectedPatientId && !generate.isPending) {
                          generate.reset()
                        }
                        setSelectedPatientId(patientId)
                      }}
                      placeholder="Choose a patient…"
                      emptyLabel="No patient of yours matches that name"
                    />
                  </Field>

                  {generate.isError ? (
                    <FormError
                      error={generate.error}
                      title="The report was not generated"
                    />
                  ) : null}

                  <SavedNotice at={generate.submittedAt}>
                    {generate.isSuccess
                      ? 'Report recorded. Its preview is below, ready to print or save as a PDF.'
                      : null}
                  </SavedNotice>

                  <Button
                    type="submit"
                    block
                    disabled={!selectedPatientId}
                    isLoading={generate.isPending}
                    loadingLabel="Generating…"
                  >
                    <FileBarChart aria-hidden="true" />
                    Generate report
                  </Button>
                </form>
              </CardBody>
            </Card>
          </PageSection>

          <PageSection
            title="Generated reports"
            action={
              // Laid out no taller than the heading's line, so this heading
              // starts level with "Generate a recovery report" beside it: a
              // 40px button sharing the row pushed it, and the card under
              // it, 12px lower. The button itself keeps its full size.
              <Button
                variant="outline"
                size="sm"
                className="print:hidden lg:-my-1.5"
                onClick={() => printOnly('list')}
              >
                <Printer aria-hidden="true" />
                Print list
              </Button>
            }
            // On paper the list is a document like the report beside it:
            // `report-sheet` puts it on the report's A4 page, with its margins
            // and running footer, and the letterhead below stands in for the
            // section heading, which is the first child and stays on screen.
            className="lg:col-span-2 report-sheet print:[&>:first-child]:hidden"
          >
            <PrintedListLetterhead clinician={clinician} />
            <Card className="print:rounded-none print:border-0 print:bg-transparent">
              {/* `sm:p-5` survives `p-0` here. On paper that padding would
                  inset the list from the letterhead and, under the last row,
                  can spill onto a sheet of its own. */}
              <CardBody className="p-0 print:p-0!">
                <StateView
                  isPending={reportsQuery.isPending}
                  error={reportsQuery.error}
                  data={reportsQuery.data}
                  onRetry={() => void reportsQuery.refetch()}
                  empty={
                    <EmptyState
                      icon={FileBarChart}
                      title="No reports yet"
                      description="Reports you generate will be listed here."
                    />
                  }
                >
                  {(reports) => (
                    <ListRows>
                      {reports.map((report) => (
                        <ListRow
                          key={report.report_id}
                          // Flush with the letterhead on paper, and never
                          // split across two sheets.
                          className="py-3 break-inside-avoid print:px-0!"
                          title={
                            report.patient
                              ? fullName(
                                  report.patient.pat_first_name,
                                  report.patient.pat_last_name,
                                )
                              : 'System-wide report'
                          }
                          description={formatDateTime(report.report_generated_at)}
                        />
                      ))}
                    </ListRows>
                  )}
                </StateView>
              </CardBody>
            </Card>
          </PageSection>
        </div>
      </div>

      {previewPatientId ? (
        <ReportPreview
          patientId={previewPatientId}
          generatedAt={generate.data?.report_generated_at ?? null}
          onPrint={() => printOnly('report')}
          onClose={() => generate.reset()}
          className={cn(printTarget === 'list' && 'print:hidden')}
        />
      ) : null}
    </>
  )
}

/**
 * The printed list's letterhead: the recovery report's own, saying who
 * printed the list and when. Paper only - on screen the page header already
 * says what the list is.
 */
function PrintedListLetterhead({ clinician }: { clinician: string | null }) {
  // Kept to the minute while the page is open, so the time printed is the
  // time of printing, not of arriving on the page.
  const now = useNow()

  return (
    <div className="mb-6 hidden print:block">
      <ReportLetterhead
        title="Generated reports"
        subtitle="Recovery reports you have generated"
        meta={
          <>
            <p>
              <span className="text-muted">Printed</span>{' '}
              <span className="font-semibold text-heading" data-numeric>
                {reportDateTime(new Date(now).toISOString())}
              </span>
            </p>
            {clinician ? (
              <p>
                <span className="text-muted">Prepared by</span>{' '}
                <span className="font-semibold text-heading">{clinician}</span>
              </p>
            ) : null}
          </>
        }
      />
    </div>
  )
}
