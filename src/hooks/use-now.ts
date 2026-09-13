import { useEffect, useState } from 'react'

/**
 * The current time, refreshed every `intervalMs` while the component is
 * mounted.
 *
 * For what depends on the clock rather than on data: a dose due at 08:00
 * should read Overdue on a page opened at 07:55 once 08:00 has passed, without
 * waiting for a refetch or a click to re-render it. Doses are scheduled to the
 * minute, so a minute is fine enough.
 */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])

  return now
}
