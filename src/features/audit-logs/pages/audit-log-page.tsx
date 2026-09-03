import { useQuery } from '@tanstack/react-query'
import { ScrollText } from 'lucide-react'
import { useMemo, useState } from 'react'

import { StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { Badge } from '@/components/ui/badge'
import { Card, CardBody } from '@/components/ui/card'
import { Field, Input, Select } from '@/components/ui/field'
import { Notice } from '@/components/ui/notice'
import {
  distinctEntities,
  fetchAuditLog,
  type AuditLogEntry,
} from '@/features/audit-logs/api'
import { formatDateTime } from '@/lib/format'
import { queryKeys } from '@/lib/query-keys'

const ACTION_TONE = {
  insert: 'success',
  update: 'info',
  delete: 'danger',
} as const

function changedColumns(entry: AuditLogEntry): string[] {
  const details = entry.audit_log_details
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return []
  }

  const changed = (details as Record<string, unknown>)['changed_columns']
  return Array.isArray(changed) ? changed.map(String) : []
}

/**
 * Modules 13.1 "View Audit Logs" and 13.2 "Filter / Search Audit Logs".
 *
 * Administrators can read this table and deliberately cannot read patient
 * records. The audit trigger therefore records only WHICH columns changed on
 * patient-touching tables, never their values — otherwise the audit trail
 * would become a way around the access model it exists to police.
 *
 * There is no delete or edit control here, and no policy that would permit
 * one. The log is append-only for every role, administrators included.
 *
 * The redesign changes how the same five fields are laid out and nothing
 * about which five they are. The query is untouched: it returns the acting
 * account's email — an administrator or clinician, never a patient — the
 * action, the entity, the timestamp, and the list of column names.
 */
export function AuditLogPage() {
  const [entityFilter, setEntityFilter] = useState('')
  const [actionFilter, setActionFilter] = useState('')
  const [search, setSearch] = useState('')

  const auditQuery = useQuery({
    queryKey: queryKeys.admin.auditLog(`${entityFilter}|${actionFilter}`),
    queryFn: () =>
      fetchAuditLog({
        ...(entityFilter ? { entity: entityFilter } : {}),
        ...(actionFilter ? { action: actionFilter } : {}),
      }),
  })

  const entities = useMemo(
    () => distinctEntities(auditQuery.data ?? []),
    [auditQuery.data],
  )

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return auditQuery.data ?? []

    return (auditQuery.data ?? []).filter((entry) =>
      [
        entry.audit_log_entity,
        entry.audit_log_action,
        entry.user_account?.user_email ?? '',
      ]
        .join(' ')
        .toLowerCase()
        .includes(query),
    )
  }, [auditQuery.data, search])

  return (
    <>
      <PageHeader
        eyebrow="Security"
        title="Audit log"
        description="A record of security-sensitive changes across the system."
      />

      <Notice tone="info" className="mb-4">
        Entries for patient records show which fields changed, never their
        contents. Administrators do not have access to patient health
        information, and the audit trail does not provide a way around that.
      </Notice>

      <Card>
        <div className="grid gap-4 border-b border-[var(--color-border)] p-4 sm:grid-cols-3">
          <Field label="Entity">
            <Select
              value={entityFilter}
              onChange={(event) => setEntityFilter(event.target.value)}
            >
              <option value="">All entities</option>
              {entities.map((entity) => (
                <option key={entity} value={entity}>
                  {entity.replace(/_/g, ' ')}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Action">
            <Select
              value={actionFilter}
              onChange={(event) => setActionFilter(event.target.value)}
            >
              <option value="">All actions</option>
              <option value="insert">Created</option>
              <option value="update">Updated</option>
              <option value="delete">Deleted</option>
            </Select>
          </Field>

          <Field label="Search">
            <Input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Entity or account"
            />
          </Field>
        </div>

        <CardBody className="p-0">
          <StateView
            isPending={auditQuery.isPending}
            error={auditQuery.error}
            data={filtered}
            onRetry={() => void auditQuery.refetch()}
            loadingLabel="Loading audit entries…"
            empty={
              <div className="px-4 py-12 text-center sm:px-5">
                <ScrollText
                  className="mx-auto size-6 text-neutral-400"
                  aria-hidden="true"
                />
                <p className="mt-2 font-medium text-heading">
                  No matching entries
                </p>
                <p className="mt-1 text-sm text-muted">
                  Try clearing the filters.
                </p>
              </div>
            }
          >
            {(entries) => (
              <div className="md:overflow-x-auto">
                {/*
                  One table that restyles, rather than a table plus a card
                  list. Rendering both would put every value in the document
                  twice — bad for assistive technology, which reads the hidden
                  copy in some modes, and worse for a page whose entire purpose
                  is an exact record of what happened.

                  Below `md` the rows become stacked blocks with a visible
                  label per field. The ARIA roles are written out explicitly
                  because changing `display` on a table element is what
                  removes its implicit table semantics; with the roles stated,
                  the structure survives the restyle.
                */}
                <table
                  role="table"
                  className="w-full text-left text-sm max-md:block"
                >
                  <caption className="sr-only">
                    Audit log entries, most recent first
                  </caption>
                  <thead
                    role="rowgroup"
                    className="border-b border-[var(--color-border)] bg-surface-sunken text-label-sm uppercase tracking-wider text-muted max-md:sr-only"
                  >
                    <tr role="row">
                      <th role="columnheader" scope="col" className="px-5 py-3 font-semibold">
                        When
                      </th>
                      <th role="columnheader" scope="col" className="px-5 py-3 font-semibold">
                        Account
                      </th>
                      <th role="columnheader" scope="col" className="px-5 py-3 font-semibold">
                        Action
                      </th>
                      <th role="columnheader" scope="col" className="px-5 py-3 font-semibold">
                        Entity
                      </th>
                      <th role="columnheader" scope="col" className="px-5 py-3 font-semibold">
                        Fields changed
                      </th>
                    </tr>
                  </thead>
                  <tbody
                    role="rowgroup"
                    className="divide-y divide-[var(--color-border)] max-md:block"
                  >
                    {entries.map((entry) => {
                      const columns = changedColumns(entry)
                      const tone =
                        ACTION_TONE[
                          entry.audit_log_action as keyof typeof ACTION_TONE
                        ] ?? 'neutral'

                      return (
                        <tr
                          key={entry.audit_log_id}
                          role="row"
                          className="max-md:block max-md:px-4 max-md:py-4"
                        >
                          <AuditCell label="When" className="whitespace-nowrap text-muted">
                            {formatDateTime(entry.audit_log_timestamp)}
                          </AuditCell>

                          <AuditCell label="Account" className="text-body">
                            {entry.user_account?.user_email ?? (
                              <span className="italic text-muted">System</span>
                            )}
                          </AuditCell>

                          <AuditCell label="Action">
                            <Badge tone={tone}>{entry.audit_log_action}</Badge>
                          </AuditCell>

                          <AuditCell label="Entity" className="text-body">
                            {entry.audit_log_entity.replace(/_/g, ' ')}
                          </AuditCell>

                          <AuditCell label="Fields changed" className="text-muted">
                            {columns.length > 0
                              ? columns
                                  .map((c) => c.replace(/_/g, ' '))
                                  .join(', ')
                              : '—'}
                          </AuditCell>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </StateView>
        </CardBody>
      </Card>
    </>
  )
}

/**
 * One cell. Below `md` it becomes a labelled key/value row, because a stacked
 * value with no column header above it is unreadable — the header row is
 * exactly what a stacked table loses.
 */
function AuditCell({
  label,
  className,
  children,
}: {
  label: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <td
      role="cell"
      className="px-5 py-3 max-md:flex max-md:gap-3 max-md:px-0 max-md:py-1"
    >
      <span
        aria-hidden="true"
        className="hidden shrink-0 basis-32 text-label-sm uppercase tracking-wider text-muted max-md:block"
      >
        {label}
      </span>
      <span className={className}>{children}</span>
    </td>
  )
}
