import { useQuery } from '@tanstack/react-query'
import { ScrollText, ShieldCheck } from 'lucide-react'
import { useMemo, useState } from 'react'

import { StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { Badge } from '@/components/ui/badge'
import { Card, CardBody } from '@/components/ui/card'
import { Field, Input, Select } from '@/components/ui/field'
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
        title="Audit log"
        description="A record of security-sensitive changes across the system."
      />

      <div className="mb-4 flex items-start gap-2.5 rounded-[var(--radius-lg)] border border-info-200 bg-info-50 p-4 text-sm text-info-800">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <p>
          Entries for patient records show which fields changed, never their
          contents. Administrators do not have access to patient health
          information, and the audit trail does not provide a way around that.
        </p>
      </div>

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
              <div className="px-5 py-12 text-center">
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
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">
                    Audit log entries, most recent first
                  </caption>
                  <thead className="border-b border-[var(--color-border)] bg-surface-sunken">
                    <tr>
                      <th scope="col" className="px-5 py-3 font-medium text-muted">
                        When
                      </th>
                      <th scope="col" className="px-5 py-3 font-medium text-muted">
                        Account
                      </th>
                      <th scope="col" className="px-5 py-3 font-medium text-muted">
                        Action
                      </th>
                      <th scope="col" className="px-5 py-3 font-medium text-muted">
                        Entity
                      </th>
                      <th scope="col" className="px-5 py-3 font-medium text-muted">
                        Fields changed
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--color-border)]">
                    {entries.map((entry) => {
                      const columns = changedColumns(entry)
                      const tone =
                        ACTION_TONE[
                          entry.audit_log_action as keyof typeof ACTION_TONE
                        ] ?? 'neutral'

                      return (
                        <tr key={entry.audit_log_id}>
                          <td className="whitespace-nowrap px-5 py-3 text-muted">
                            {formatDateTime(entry.audit_log_timestamp)}
                          </td>
                          <td className="px-5 py-3 text-body">
                            {entry.user_account?.user_email ?? (
                              <span className="italic text-muted">System</span>
                            )}
                          </td>
                          <td className="px-5 py-3">
                            <Badge tone={tone}>{entry.audit_log_action}</Badge>
                          </td>
                          <td className="px-5 py-3 text-body">
                            {entry.audit_log_entity.replace(/_/g, ' ')}
                          </td>
                          <td className="px-5 py-3 text-muted">
                            {columns.length > 0
                              ? columns.map((c) => c.replace(/_/g, ' ')).join(', ')
                              : '—'}
                          </td>
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
