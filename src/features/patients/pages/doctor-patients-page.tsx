import { Search, UserPlus, Users } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import { StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import {
  DataTable,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '@/components/ui/data-table'
import { RegisterAccountDialog } from '@/features/patients/components/register-account-dialog'
import { useMyPatients } from '@/features/patients/hooks'
import { calculateAge, formatDate } from '@/lib/format'
import { patientStatus } from '@/lib/status'
import { fullName, initials } from '@/lib/utils'

/**
 * Module 2.3 "View Patient List".
 *
 * The list contains only this clinician's own patients — enforced by the RLS
 * policy on `patient`, not by a filter here. The search box filters what has
 * already been returned; it does not widen the query.
 *
 * Rendered as cards on small screens and a table on wide ones. A table
 * squeezed onto a phone forces horizontal scrolling, which is exactly the
 * pattern that makes clinical software unusable on a ward round.
 *
 * The card carries the same facts as the table row — age, contact, registered
 * date, status — rather than a reduced set. A clinician on a phone is looking
 * at the same caseload for the same reasons, and dropping the contact number
 * is what turns "call this patient" into "go and find a desktop".
 */
export function DoctorPatientsPage() {
  const patientsQuery = useMyPatients()
  const [search, setSearch] = useState('')
  const [isRegisterOpen, setRegisterOpen] = useState(false)

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return patientsQuery.data ?? []

    return (patientsQuery.data ?? []).filter((patient) =>
      fullName(patient.pat_first_name, patient.pat_last_name)
        .toLowerCase()
        .includes(query),
    )
  }, [patientsQuery.data, search])

  return (
    <>
      <PageHeader
        eyebrow="Your caseload"
        title="Patients"
        description="Everyone assigned to your care."
        actions={
          <Button
            className="max-sm:w-full"
            onClick={() => setRegisterOpen(true)}
          >
            <UserPlus aria-hidden="true" />
            Register a patient
          </Button>
        }
      />

      <RegisterAccountDialog
        mode="patient"
        isOpen={isRegisterOpen}
        onClose={() => setRegisterOpen(false)}
      />

      <Card>
        <div className="border-b border-[var(--color-border)] p-4">
          <label htmlFor="patient-search" className="sr-only">
            Search patients by name
          </label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-neutral-500"
              aria-hidden="true"
            />
            <input
              id="patient-search"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by name"
              className="h-11 w-full rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-surface pl-9 pr-3 text-base text-heading transition-colors placeholder:text-neutral-400 hover:border-neutral-400"
            />
          </div>
        </div>

        <CardBody className="p-0">
          <StateView
            isPending={patientsQuery.isPending}
            error={patientsQuery.error}
            data={filtered}
            onRetry={() => void patientsQuery.refetch()}
            loadingLabel="Loading your patients…"
            empty={
              <div className="px-4 py-12 text-center sm:px-5">
                <Users
                  className="mx-auto size-6 text-neutral-400"
                  aria-hidden="true"
                />
                <p className="mt-2 font-medium text-heading">
                  {search ? 'No matching patients' : 'No patients yet'}
                </p>
                <p className="mt-1 text-sm text-muted">
                  {search
                    ? 'Try a different name.'
                    : 'Register a patient to get started.'}
                </p>
              </div>
            }
          >
            {(patients) => (
              <>
                {/* Cards: small screens */}
                <ul className="divide-y divide-[var(--color-border)] md:hidden">
                  {patients.map((patient) => {
                    const age = calculateAge(patient.pat_birth_date)
                    const name = fullName(
                      patient.pat_first_name,
                      patient.pat_last_name,
                    )

                    return (
                      <li key={patient.pat_id}>
                        <Link
                          to={`/doctor/patients/${patient.pat_id}`}
                          className="flex items-start gap-3 px-4 py-4 transition-colors hover:bg-neutral-100"
                        >
                          <span
                            aria-hidden="true"
                            className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-50 text-sm font-semibold text-brand-700"
                          >
                            {initials(
                              patient.pat_first_name,
                              patient.pat_last_name,
                            )}
                          </span>

                          <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <span className="font-medium text-heading">
                                {name}
                              </span>
                              {/* Full badge, not icon-only. A status a
                                  clinician has to decode from a glyph is a
                                  status they will not read. */}
                              <StatusBadge
                                status={patientStatus[patient.pat_status]}
                              />
                            </span>

                            <span className="mt-1 block text-sm text-muted">
                              {age !== null ? `${age} years old` : 'Age not recorded'}
                              {patient.pat_contact_no
                                ? ` · ${patient.pat_contact_no}`
                                : ''}
                            </span>
                            <span className="mt-0.5 block text-sm text-muted">
                              Registered {formatDate(patient.pat_created_at)}
                            </span>
                          </span>
                        </Link>
                      </li>
                    )
                  })}
                </ul>

                {/* Table: wide screens */}
                <div className="hidden md:block">
                  <DataTable
                    caption="Patients assigned to you"
                    // The card already provides the border and the radius;
                    // the table only needs its scroll container.
                    containerClassName="rounded-none border-0"
                  >
                    <THead>
                      <tr>
                        <TH>Name</TH>
                        <TH>Age</TH>
                        <TH>Contact</TH>
                        <TH>Registered</TH>
                        <TH>Status</TH>
                      </tr>
                    </THead>
                    <TBody>
                      {patients.map((patient) => {
                        const age = calculateAge(patient.pat_birth_date)
                        return (
                          <TR key={patient.pat_id}>
                            <TH scope="row" className="font-normal">
                              <Link
                                to={`/doctor/patients/${patient.pat_id}`}
                                className="font-medium text-brand-700 hover:underline"
                              >
                                {fullName(
                                  patient.pat_first_name,
                                  patient.pat_last_name,
                                )}
                              </Link>
                            </TH>
                            <TD className="text-body">{age ?? '—'}</TD>
                            <TD className="text-body">
                              {patient.pat_contact_no ?? '—'}
                            </TD>
                            <TD className="text-body">
                              {formatDate(patient.pat_created_at)}
                            </TD>
                            <TD>
                              <StatusBadge
                                status={patientStatus[patient.pat_status]}
                              />
                            </TD>
                          </TR>
                        )
                      })}
                    </TBody>
                  </DataTable>
                </div>
              </>
            )}
          </StateView>
        </CardBody>
      </Card>
    </>
  )
}
