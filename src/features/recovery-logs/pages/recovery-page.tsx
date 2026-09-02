import { Flame } from 'lucide-react'

import { LoadingState, StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { useCurrentUser } from '@/features/auth/auth-context'
import { calculateStreak } from '@/features/recovery-logs/api'
import { DailyEntryForm } from '@/features/recovery-logs/components/daily-entry-form'
import { MoodTrend } from '@/features/recovery-logs/components/mood-trend'
import {
  useRecoveryLogs,
  useSaveRecoveryLog,
} from '@/features/recovery-logs/hooks'
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

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          {/* --- Today's entry ------------------------------------------ */}
          <Card>
            <CardHeader
              title={todaysLog ? 'Edit today’s entry' : 'Log today'}
              description={formatDateRelative(new Date())}
            />
            <CardBody>
              {logsQuery.isPending ? (
                <LoadingState label="Loading today's entry…" />
              ) : (
                /* Keyed on the entry being edited. A new key remounts the
                   form with the saved values as its initial state, instead of
                   copying them in with an effect after the first render. */
                <DailyEntryForm
                  key={todaysLog?.recovery_log_id ?? 'new-entry'}
                  initialMood={todaysLog?.recovery_log_mood_rating ?? null}
                  initialNotes={todaysLog?.recovery_log_notes ?? ''}
                  isEditing={Boolean(todaysLog)}
                  isSaving={saveLog.isPending}
                  wasJustSaved={saveLog.isSuccess}
                  error={saveLog.error}
                  onSave={(values) =>
                    saveLog.mutate({ date: todayKey, ...values })
                  }
                />
              )}
            </CardBody>
          </Card>

          {/* --- Journal ------------------------------------------------- */}
          <Card>
            <CardHeader
              title="Your journal"
              description="Everything you have recorded, most recent first."
            />
            <CardBody className="p-0">
              <StateView
                isPending={logsQuery.isPending}
                error={logsQuery.error}
                data={logsQuery.data}
                onRetry={() => void logsQuery.refetch()}
                empty={
                  <div className="px-5 py-10 text-center text-muted">
                    <p className="font-medium text-heading">
                      No entries yet
                    </p>
                    <p className="mt-1 text-sm">
                      Your first entry will appear here once you save it.
                    </p>
                  </div>
                }
              >
                {(logs) => (
                  <ul className="divide-y divide-[var(--color-border)]">
                    {logs.map((log) => (
                      <li key={log.recovery_log_id} className="px-5 py-4">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <p className="font-medium text-heading">
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
                        {log.recovery_log_notes ? (
                          <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-body">
                            {log.recovery_log_notes}
                          </p>
                        ) : (
                          <p className="mt-1.5 text-sm italic text-muted">
                            No notes recorded for this day.
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </StateView>
            </CardBody>
          </Card>
        </div>

        {/* --- Side column ------------------------------------------------ */}
        <div className="space-y-5">
          <Card>
            <CardBody className="text-center">
              <span className="mx-auto flex size-11 items-center justify-center rounded-full bg-warning-50">
                <Flame className="size-5 text-warning-700" aria-hidden="true" />
              </span>
              <p
                className="mt-3 text-3xl font-semibold text-heading"
                data-numeric
              >
                {streak}
              </p>
              <p className="text-sm text-muted">
                {streak === 1 ? 'day in a row' : 'days in a row'}
              </p>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="How you have felt" as="h3" />
            <CardBody>
              <MoodTrend logs={logsQuery.data ?? []} />
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  )
}

const MOOD_WORDS = ['very poor', 'poor', 'okay', 'good', 'very good'] as const
