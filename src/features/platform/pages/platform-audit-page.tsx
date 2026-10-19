import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { ScrollText } from 'lucide-react'
import { useMemo } from 'react'

import { EmptyState, StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { DataTable, TBody, TD, TH, THead, TR } from '@/components/ui/data-table'
import { Notice } from '@/components/ui/notice'
import { toneForAuditAction } from '@/features/audit-logs/api'
import { useCurrentUser } from '@/features/auth/auth-context'
import {
  fetchClinics,
  fetchPlatformAudit,
  nextAuditCursor,
  type AuditCursor,
  type PlatformAuditEntry,
} from '@/features/platform/api'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { formatDateTime } from '@/lib/format'
import { queryKeys } from '@/lib/query-keys'

const ACTION_LABEL: Record<string, string> = {
  insert: 'Created',
  create: 'Created',
  update: 'Changed',
  delete: 'Deleted',
}

const ENTITY_LABEL: Record<string, string> = {
  clinic: 'Clinic',
  clinic_admin_account: 'Clinic Admin account',
  super_admin: 'Super Admin profile',
  announcement: 'Platform announcement',
  user_account: 'Account',
  account_password: 'Password',
  platform_setting: 'Guidance assistant switch',
}

const COLUMN_LABEL: Record<string, string> = {
  clinic_name: 'name',
  clinic_status: 'status',
  clinic_timezone: 'time zone',
  announcement_title: 'title',
  announcement_content: 'message',
  announcement_published_at: 'published',
  platform_setting_value: 'on or off',
}

/** The fields an update changed, by name only - never their values. */
function changedFields(entry: PlatformAuditEntry): string[] {
  const details = entry.audit_log_details
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return []
  }
  const changed = (details as Record<string, unknown>)['changed_columns']
  return Array.isArray(changed)
    ? changed.map((column) => {
        const name = String(column)
        return COLUMN_LABEL[name] ?? name.replace(/_/g, ' ')
      })
    : []
}

/**
 * The platform's own audit trail: clinics, Clinic Admin and Super Admin
 * accounts, and platform announcements, newest first.
 *
 * Which entries count as platform ones is decided in the database, by
 * `super_admin_list_audit`, from the entry's own scope; this page cannot ask
 * for any other kind, and nothing clinical is ever one. Older entries load a
 * page at a time, continuing from the last one shown.
 */
export function PlatformAuditPage() {
  useDocumentTitle('Platform Audit Log')
  const user = useCurrentUser()

  const auditQuery = useInfiniteQuery({
    queryKey: queryKeys.platform.audit(),
    queryFn: ({ pageParam }) => fetchPlatformAudit(pageParam),
    initialPageParam: undefined as AuditCursor | undefined,
    getNextPageParam: (lastPage) => nextAuditCursor(lastPage),
  })

  // For clinic names. The same list the Clinics page shows, from the cache
  // when it is already there.
  const clinicsQuery = useQuery({
    queryKey: queryKeys.platform.clinics(),
    queryFn: fetchClinics,
  })

  const clinicName = useMemo(() => {
    const names = new Map(
      (clinicsQuery.data ?? []).map((clinic) => [clinic.clinic_id, clinic.clinic_name]),
    )
    return (clinicId: string | null) =>
      clinicId === null ? '—' : (names.get(clinicId) ?? 'A clinic')
  }, [clinicsQuery.data])

  const entries = useMemo(
    () => auditQuery.data?.pages.flat(),
    [auditQuery.data],
  )

  return (
    <>
      <PageHeader
        title="Platform audit log"
        description="Changes to clinics, Clinic Admin and Super Admin accounts, and platform announcements."
      />

      <Notice tone="info" className="mb-4">
        Only platform changes are here. Nothing from inside a clinic - its
        patients, their care, or its own settings - appears in this log.
      </Notice>

      <StateView
        isPending={auditQuery.isPending}
        // A failed "Load older entries" keeps the entries already shown,
        // with its own message under them.
        error={auditQuery.isFetchNextPageError ? null : auditQuery.error}
        data={entries}
        onRetry={() => void auditQuery.refetch()}
        loadingLabel="Loading audit entries…"
        empty={
          <Card>
            <EmptyState
              icon={ScrollText}
              title="No platform changes yet"
              description="Creating a clinic, adding a Clinic Admin or publishing a platform announcement is recorded here."
            />
          </Card>
        }
      >
        {(rows) => (
          <>
            <DataTable caption="Platform audit entries, most recent first">
              <THead>
                <TR>
                  <TH>When</TH>
                  <TH>Action</TH>
                  <TH>What</TH>
                  <TH>Clinic</TH>
                  <TH>By</TH>
                  <TH>Fields changed</TH>
                </TR>
              </THead>
              <TBody>
                {rows.map((entry) => {
                  const fields = changedFields(entry)
                  return (
                    <TR key={entry.audit_log_id}>
                      <TD className="whitespace-nowrap text-muted">
                        {formatDateTime(entry.audit_log_timestamp)}
                      </TD>
                      <TD>
                        <Badge
                          tone={
                            entry.audit_log_action === 'create'
                              ? 'success'
                              : toneForAuditAction(entry.audit_log_action)
                          }
                        >
                          {ACTION_LABEL[entry.audit_log_action] ??
                            entry.audit_log_action}
                        </Badge>
                      </TD>
                      <TD className="text-body">
                        {ENTITY_LABEL[entry.audit_log_entity] ??
                          entry.audit_log_entity.replace(/_/g, ' ')}
                      </TD>
                      <TD className="text-body">{clinicName(entry.clinic_id)}</TD>
                      <TD className="text-body">
                        {entry.actor_user_id === null ? (
                          <span className="italic text-muted">System</span>
                        ) : entry.actor_user_id === user.userId ? (
                          'You'
                        ) : (
                          // Another account's id, shortened: the platform
                          // log does not look up anyone's email.
                          <span
                            className="font-mono text-muted"
                            title={entry.actor_user_id}
                          >
                            {entry.actor_user_id.slice(0, 8)}
                          </span>
                        )}
                      </TD>
                      <TD className="text-muted">
                        {fields.length > 0 ? fields.join(', ') : '—'}
                      </TD>
                    </TR>
                  )
                })}
              </TBody>
            </DataTable>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted" role="status" aria-live="polite">
                {rows.length === 1
                  ? 'Showing 1 entry.'
                  : `Showing ${rows.length} entries.`}
                {auditQuery.hasNextPage ? '' : ' That is every entry.'}
              </p>
              {auditQuery.hasNextPage ? (
                <Button
                  variant="outline"
                  isLoading={auditQuery.isFetchingNextPage}
                  loadingLabel="Loading older entries…"
                  onClick={() => void auditQuery.fetchNextPage()}
                >
                  Load older entries
                </Button>
              ) : null}
            </div>

            {auditQuery.isFetchNextPageError ? (
              <div className="mt-3">
                <Notice tone="danger" live="assertive">
                  Older entries could not be loaded. Try again.
                </Notice>
              </div>
            ) : null}
          </>
        )}
      </StateView>
    </>
  )
}
