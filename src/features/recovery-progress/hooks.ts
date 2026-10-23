import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { parseISO } from 'date-fns'
import { useMemo, useState } from 'react'

import { useQueryKeys } from '@/features/auth/use-query-keys'
import { fetchAllDoses } from '@/features/medications/api'
import { fetchRecoveryLogs } from '@/features/recovery-logs/api'
import { fetchTreatmentPlans } from '@/features/treatment-plans/api'
import { useNow } from '@/hooks/use-now'
import { toDateKey } from '@/lib/format'

import { periodDays, periodWindow, type ProgressRange } from './progress'

/**
 * The clinician's copy keeps itself current the way the notification bell
 * does: every minute, and when the window regains focus. A patient may log a
 * day or mark a dose while their record is open on the clinician's screen,
 * and a minute is well inside the time that matters for that - without a
 * realtime subscription for a chart. The patient's own copy needs neither:
 * everything that changes it is something they did on this device, and
 * each of those writes already refreshes these queries.
 */
const LIVE = { refetchInterval: 60_000, refetchOnWindowFocus: true } as const

/**
 * The three reads the recovery progress panel is built from, each loading
 * and failing on its own:
 *
 *   - recovery entries, through the query My recovery and the record's
 *     Recovery tab already make - its 90 most recent entries, at most one a
 *     day and none in the future, cover any 30-day period;
 *   - every dose in the period, read in full (`fetchAllDoses`);
 *   - treatment plans with their goals, through the Treatment pages' query.
 *
 * Switching period keeps the previous period's doses on screen until the
 * new window arrives - `shownRange` is the period those rows belong to - so
 * the panel holds its frame, dimmed, instead of flashing a loading state.
 */
export function useRecoveryProgress(
  patientId: string,
  range: ProgressRange,
  { live = false }: { live?: boolean } = {},
) {
  const queryKeys = useQueryKeys()
  const refresh = live ? LIVE : {}
  const enabled = Boolean(patientId)

  // Read each minute, so a panel left open across midnight moves on to the
  // new day. Only the day matters, so nothing below changes until it does.
  const today = toDateKey(new Date(useNow()))

  const [shownRange, setShownRange] = useState(range)
  const bounds = useMemo(() => periodWindow(range, parseISO(today)), [range, today])

  const logs = useQuery({
    queryKey: queryKeys.recoveryLogs.forPatient(patientId),
    queryFn: () => fetchRecoveryLogs(patientId),
    enabled,
    ...refresh,
  })

  const doses = useQuery({
    queryKey: queryKeys.medications.allDosesFor(patientId, bounds.from, bounds.to),
    queryFn: () => fetchAllDoses({ patientId, ...bounds }),
    enabled,
    placeholderData: keepPreviousData,
    ...refresh,
  })

  const plans = useQuery({
    queryKey: queryKeys.treatment.plansFor(patientId),
    queryFn: () => fetchTreatmentPlans(patientId),
    enabled,
    ...refresh,
  })

  // Once the selected period's own rows have arrived - or failed - it is the
  // one on screen. Adjusted during render, as React advises for state that
  // follows a value, so there is no frame showing one period's days with
  // another's doses.
  if (shownRange !== range && !doses.isPlaceholderData) {
    setShownRange(range)
  }

  const days = useMemo(() => periodDays(shownRange, parseISO(today)), [shownRange, today])

  return {
    today,
    days,
    shownRange,
    /** The previous period's chart is on screen while the new one loads. */
    isSwitching: doses.isPlaceholderData,
    logs,
    doses,
    plans,
  }
}
