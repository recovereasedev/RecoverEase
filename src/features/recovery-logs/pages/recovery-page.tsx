import { Flame } from 'lucide-react'

import { LoadingState, StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { Card, CardBody } from '@/components/ui/card'
import { PageSection } from '@/components/ui/section-heading'
import { useCurrentUser } from '@/features/auth/auth-context'
import { calculateStreak } from '@/features/recovery-logs/api'
import { DailyEntryForm } from '@/features/recovery-logs/components/daily-entry-form'
import { MoodTrend } from '@/features/recovery-logs/components/mood-trend'
import {
  useRecoveryLogs,
  useSaveRecoveryLog,
} from '@/features/recovery-logs/hooks'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { formatDateRelative, toDateKey } from '@/lib/format'

/**
 * Modules 5.9 "Log Daily Recovery Progress", 5.10 "Maintain Recovery
 * Journal", 5.11 "View Recovery Trend Charts" and 5.12 "View Recovery
 * Streak".
 *
 * One entry per day, which the database enforces. Re-submitting today edits
 * the existing entry rather than failing, so a patient who wants to add
 * something later in the day simply can.
 */
export function RecoveryPage() {
  useDocumentTitle('My Recovery')
  const user = useCurrentUser()
  const patientId =
    user.profile.kind === 'patient' ? user.profile.patient.pat_id : ''

  const logsQuery = useRecoveryLogs(patientId)
  const saveLog = useSaveRecoveryLog(patientId)

  const todayKey = toDateKey()
  const todaysLog = logsQuery.data?.find(
    (log) => log.recovery_log_date === todayKey,
  )

  const streak = logsQuery.data ? calculateStreak(logsQuery.data) : 0

  return (
    <>
      <PageHeader
        title="My recovery"
        description="Record how each day goes. Your doctor sees these entries."
      />

      <div className="grid gap-section lg:grid-cols-3 lg:gap-8">
        <div className="space-y-section lg:col-span-2">
          {/* --- Today's entry ------------------------------------------ */}
          <PageSection
            title={todaysLog ? 'Edit today’s entry' : 'Log today'}
            description={formatDateRelative(new Date())}
          >
            <Card variant="elevated">
              <CardBody>
                {logsQuery.isPending ? (
                  <LoadingState label="Loading today's entry…" />
                ) : (
                  /* Keyed on the entry being edited. A new key remounts the
                     form with the saved values as its initial state, instead
                     of copying them in with an effect after the first
                     render. */
                  <DailyEntryForm
                    key={todaysLog?.recovery_log_id ?? 'new-entry'}
                    initialMood={todaysLog?.recovery_log_mood_rating ?? null}
                    initialNotes={todaysLog?.recovery_log_notes ?? ''}
                    isEditing={Boolean(todaysLog)}
                    isSaving={saveLog.isPending}
                    wasJustSaved={saveLog.isSuccess}
                    savedAt={saveLog.submittedAt}
                    error={saveLog.error}
                    onSave={(values) =>
                      saveLog.mutate({ date: todayKey, ...values })
                    }
                  />
                )}
              </CardBody>
            </Card>
          </PageSection>

          {/* --- Journal ------------------------------------------------- */}
          <PageSection
            title="Your journal"
            description="Everything you have recorded, most recent first."
          >
            <Card className="overflow-hidden">
              <StateView
                isPending={logsQuery.isPending}
                error={logsQuery.error}
                data={logsQuery.data}
                onRetry={() => void logsQuery.refetch()}
                empty={
                  <div className="px-4 py-6 sm:px-5">
                    <p className="font-medium text-heading">No entries yet</p>
                    <p className="mt-1 text-sm text-muted">
                      Your first entry will appear here once you save it.
                    </p>
                  </div>
                }
              >
                {(logs) => (
                  <ul className="divide-y divide-[var(--color-border)]">
                    {logs.map((log) => (
                      <li
                        key={log.recovery_log_id}
                        className="px-4 py-4 sm:px-5"
                      >
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <p className="font-semibold text-heading">
                            {formatDateRelative(log.recovery_log_date)}
                          </p>
                          {log.recovery_log_mood_rating ? (
                            <p className="text-sm text-muted">
                              Felt{' '}
                              <span className="font-medium text-body">
                                {MOOD_WORDS[log.recovery_log_mood_rating - 1]}
                              </span>
                            </p>
                          ) : null}
                        </div>
                        {/* The patient's own words, at reading size. */}
                        {log.recovery_log_notes ? (
                          <p className="mt-1 whitespace-pre-wrap leading-relaxed text-body">
                            {log.recovery_log_notes}
                          </p>
                        ) : (
                          <p className="mt-1 text-sm text-muted">
                            No notes recorded for this day.
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </StateView>
            </Card>
          </PageSection>
        </div>

        {/* --- Progress: module 5.12 (streak) and 5.11 (trend) --------------
            One panel, not two cards: both answer "how is it going". */}
        <PageSection title="Your progress">
          <Card>
            <CardBody className="space-y-5">
              <div className="flex items-center gap-3">
                <Flame
                  className="size-6 shrink-0 text-warning-700"
                  aria-hidden="true"
                />
                <p className="text-body">
                  <span className="text-headline-md text-heading" data-numeric>
                    {streak}
                  </span>{' '}
                  {streak === 1 ? 'day in a row' : 'days in a row'}
                </p>
              </div>
              <div className="border-t border-[var(--color-border)] pt-4">
                <h3 className="text-base font-semibold text-heading">
                  How you have felt
                </h3>
                <div className="mt-3">
                  <MoodTrend logs={logsQuery.data ?? []} />
                </div>
              </div>
            </CardBody>
          </Card>
        </PageSection>
      </div>
    </>
  )
}

const MOOD_WORDS = ['very poor', 'poor', 'okay', 'good', 'very good'] as const
