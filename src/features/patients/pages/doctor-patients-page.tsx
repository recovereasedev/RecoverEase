import { Search, Users } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import { StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { StatusBadge } from '@/components/ui/badge'
import { Card, CardBody } from '@/components/ui/card'
import { useMyPatients } from '@/features/patients/hooks'
import { calculateAge, formatDate } from '@/lib/format'
import { patientStatus } from '@/lib/status'
import { fullName, initials } from '@/lib/utils'

/**
 * Module 2.3 "View Patient List".
 *
 * The list contains only this clinician's own patients — enforced by the RLS
 * policy on `patient`, not by a filter here.
 *
 * Rendered as cards on small screens and a table on wide ones. A table
 * squeezed onto a phone forces horizontal scrolling, which is exactly the
 * pattern that makes clinical software unusable on a ward round.
 */
export function DoctorPatientsPage() {
  const patientsQuery = useMyPatients()
  const [search, setSearch] = useState('')

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
        title="Patients"
        description="Everyone assigned to your care."
      />

      <Card>
        <div className="border-b border-[var(--color-border)] p-4">
          <label htmlFor="patient-search" className="sr-only">
            Search patients by name
          </label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-neutral-400"
              aria-hidden="true"
            />
            <input
              id="patient-search"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by name"
              className="h-11 w-full rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-surface pl-9 pr-3 text-base text-heading placeholder:text-neutral-400"
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
              <div className="px-5 py-12 text-center">
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
                    : 'Patients you register will appear here.'}
                </p>
              </div>
            }
          >
            {(patients) => (
              <>
                {/* Cards: small screens */}
                <ul className="divide-y divide-[var(--color-border)] md:hidden">
                  {patients.map((patient) => (
                    <li key={patient.pat_id}>
                      <Link
                        to={`/doctor/patients/${patient.pat_id}`}
                        className="flex items-center gap-3 px-5 py-4 hover:bg-neutral-50"
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
                          <span className="block font-medium text-heading">
                            {fullName(
                              patient.pat_first_name,
                              patient.pat_last_name,
                            )}
                          </span>
                          <span className="block text-sm text-muted">
                            Registered {formatDate(patient.pat_created_at)}
                          </span>
                        </span>
                        <StatusBadge
                          status={patientStatus[patient.pat_status]}
                          iconOnly
                        />
                      </Link>
                    </li>
                  ))}
                </ul>

                {/* Table: wide screens */}
                <div className="hidden overflow-x-auto md:block">
                  <table className="w-full text-left text-sm">
                    <caption className="sr-only">
                      Patients assigned to you
                    </caption>
                    <thead className="border-b border-[var(--color-border)] bg-surface-sunken">
                      <tr>
                        <th scope="col" className="px-5 py-3 font-medium text-muted">
                          Name
                        </th>
                        <th scope="col" className="px-5 py-3 font-medium text-muted">
                          Age
                        </th>
                        <th scope="col" className="px-5 py-3 font-medium text-muted">
                          Contact
                        </th>
                        <th scope="col" className="px-5 py-3 font-medium text-muted">
                          Registered
                        </th>
                        <th scope="col" className="px-5 py-3 font-medium text-muted">
                          Status
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--color-border)]">
                      {patients.map((patient) => {
                        const age = calculateAge(patient.pat_birth_date)
                        return (
                          <tr key={patient.pat_id} className="hover:bg-neutral-50">
                            <th scope="row" className="px-5 py-3 font-normal">
                              <Link
                                to={`/doctor/patients/${patient.pat_id}`}
                                className="font-medium text-brand-700 hover:underline"
                              >
                                {fullName(
                                  patient.pat_first_name,
                                  patient.pat_last_name,
                                )}
                              </Link>
                            </th>
                            <td className="px-5 py-3 text-body">
                              {age ?? '—'}
                            </td>
                            <td className="px-5 py-3 text-body">
                              {patient.pat_contact_no ?? '—'}
                            </td>
                            <td className="px-5 py-3 text-body">
                              {formatDate(patient.pat_created_at)}
                            </td>
                            <td className="px-5 py-3">
                              <StatusBadge
                                status={patientStatus[patient.pat_status]}
                              />
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </StateView>
        </CardBody>
      </Card>
    </>
  )
}
