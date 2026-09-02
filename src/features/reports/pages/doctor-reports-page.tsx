import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileBarChart, Printer } from 'lucide-react'
import { useState } from 'react'

import { ErrorState, StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Field, Select } from '@/components/ui/field'
import { useCurrentUser } from '@/features/auth/auth-context'
import { useMyPatients } from '@/features/patients/hooks'
import { fetchReports, recordGeneratedReport } from '@/features/reports/api'
import { formatDateTime } from '@/lib/format'
import { queryKeys } from '@/lib/query-keys'
import { fullName } from '@/lib/utils'

/**
 * Modules 9.1 "Generate Recovery Report" and 9.2 "Download/Print Recovery
 * Report".
 *
 * Generating a report records that it happened — who produced it, about whom
 * and when — which is what makes the report table an accountable record
 * rather than a list of files. The document itself is produced through the
 * browser's print pipeline, which yields a real PDF via "Save as PDF" on
 * every platform.
 */
export function DoctorReportsPage() {
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

  return (
    <>
      <PageHeader
        title="Reports"
        description="Recovery reports you have generated."
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-1 h-fit">
          <CardHeader title="Generate a recovery report" as="h2" />
          <CardBody>
            <form
              onSubmit={(event) => {
                event.preventDefault()
                if (selectedPatientId) generate.mutate(selectedPatientId)
              }}
              className="space-y-4"
            >
              <Field label="Patient" required>
                <Select
                  value={selectedPatientId}
                  onChange={(event) =>
                    setSelectedPatientId(event.target.value)
                  }
                >
                  <option value="">Choose a patient…</option>
                  {(patientsQuery.data ?? []).map((patient) => (
                    <option key={patient.pat_id} value={patient.pat_id}>
                      {fullName(
                        patient.pat_first_name,
                        patient.pat_last_name,
                      )}
                    </option>
                  ))}
                </Select>
              </Field>

              {generate.isError ? (
                <ErrorState error={generate.error} />
              ) : null}

              {generate.isSuccess ? (
                <p
                  role="status"
                  className="text-sm font-medium text-success-700"
                >
                  Report recorded. Open the patient record and use Print to
                  save it as a PDF.
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
            title="Generated reports"
            action={
              <Button
                variant="secondary"
                size="sm"
                onClick={() => window.print()}
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
                <div className="px-5 py-12 text-center">
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
                <ul className="divide-y divide-[var(--color-border)]">
                  {reports.map((report) => (
                    <li
                      key={report.report_id}
                      className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5"
                    >
                      <div className="min-w-0">
                        <p className="font-medium text-heading">
                          {report.patient
                            ? fullName(
                                report.patient.pat_first_name,
                                report.patient.pat_last_name,
                              )
                            : 'System-wide report'}
                        </p>
                        <p className="text-sm text-muted">
                          {formatDateTime(report.report_generated_at)}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </StateView>
          </CardBody>
        </Card>
      </div>
    </>
  )
}
