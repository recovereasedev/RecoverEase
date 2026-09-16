import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileBarChart, ListChecks, Printer } from 'lucide-react'
import { useState } from 'react'
import { flushSync } from 'react-dom'

import { FormError } from '@/components/feedback/form-error'
import { StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { ListRow, ListRows } from '@/components/ui/list-row'
import { Combobox, Field } from '@/components/ui/field'
import { useCurrentUser } from '@/features/auth/auth-context'
import { useMyPatients } from '@/features/patients/hooks'
import { fetchReports, recordGeneratedReport } from '@/features/reports/api'
import { ReportPreview } from '@/features/reports/components/report-preview'
import { useDocumentTitle } from '@/hooks/use-document-title'
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

  return (
    <>
      <div className={cn(isPageHiddenInPrint && 'print:hidden')}>
        {/* The header and the form are the screen's, as is "Print list": the
            printout of this page is the list of generated reports. */}
        <PageHeader
          eyebrow="Records"
          title="Reports"
          description="Recovery reports you have generated."
          className="print:hidden"
        />

        <div className="grid gap-5 lg:grid-cols-3">
          <Card className="lg:col-span-1 h-fit print:hidden">
            <CardHeader
              icon={FileBarChart}
              title="Generate a recovery report"
              as="h2"
            />
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

                {generate.isSuccess ? (
                  <p
                    role="status"
                    className="text-sm font-medium text-success-700"
                  >
                    Report recorded. Its preview is below, ready to print or
                    save as a PDF.
                  </p>
                ) : null}

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

          <Card className="lg:col-span-2">
            <CardHeader
              icon={ListChecks}
              title="Generated reports"
              as="h2"
              action={
                <Button
                  variant="outline"
                  size="sm"
                  className="print:hidden"
                  onClick={() => printOnly('list')}
                >
                  <Printer aria-hidden="true" />
                  Print list
                </Button>
              }
            />
            <CardBody className="p-0">
              <StateView
                isPending={reportsQuery.isPending}
                error={reportsQuery.error}
                data={reportsQuery.data}
                onRetry={() => void reportsQuery.refetch()}
                empty={
                  <div className="px-4 py-12 text-center sm:px-5">
                    <FileBarChart
                      className="mx-auto size-6 text-neutral-400"
                      aria-hidden="true"
                    />
                    <p className="mt-2 font-medium text-heading">
                      No reports yet
                    </p>
                    <p className="mt-1 text-sm text-muted">
                      Reports you generate will be listed here.
                    </p>
                  </div>
                }
              >
                {(reports) => (
                  <ListRows>
                    {reports.map((report) => (
                      <ListRow
                        key={report.report_id}
                        className="py-3"
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
