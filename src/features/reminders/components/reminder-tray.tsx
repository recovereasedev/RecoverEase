import { useQuery } from '@tanstack/react-query'
import { endOfTomorrow, startOfToday } from 'date-fns'
import { CalendarClock, Pill, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import { Button, buttonVariants } from '@/components/ui/button'
import { fetchAppointments } from '@/features/appointments/api'
import { useCurrentUser } from '@/features/auth/auth-context'
import { useQueryKeys } from '@/features/auth/use-query-keys'
import { fetchDoses } from '@/features/medications/api'
import { useSetDoseStatus } from '@/features/medications/hooks'
import type { Patient } from '@/features/patients/api'
import { useMyDoctor } from '@/features/patients/hooks'
import {
  appointmentReminders,
  doseReminders,
  SNOOZE_MS,
  type ReminderItem,
  type ReminderState,
} from '@/features/reminders/reminder-items'
import { useNow } from '@/hooks/use-now'
import { cn, fullName } from '@/lib/utils'

/**
 * The 2nd-half plan, section 6: the in-app reminder of a dose or an
 * appointment that is nearly due (`reminder-items.ts` says which, and when).
 *
 * Compact and non-blocking: a card at the foot of the screen - above the
 * bottom bar on a phone, at the bottom right on a larger screen - that never
 * takes focus, never stops the page, and is announced politely once. It
 * stays until it is acted on, dismissed, or no longer relevant. While it is
 * there it reserves its own space (`--reminder-tray-space`, index.css), so the
 * end of the page, a focused field and the chat's message box all stay clear
 * of it rather than underneath it. Nothing in it moves: no entrance
 * animation, so reduced motion has nothing to reduce.
 *
 * Dismissing or snoozing is remembered for the browser session only
 * (`sessionStorage`), on this device: it is a convenience, never the record.
 * Patients see their doses and appointments; doctors their appointments;
 * nobody else is shown anything.
 */
export function ReminderTray() {
  const user = useCurrentUser()
  if (user.profile.kind === 'patient') return <PatientReminders patient={user.profile.patient} />
  if (user.profile.kind === 'doctor') return <DoctorReminders />
  return null
}

function PatientReminders({ patient }: { patient: Patient }) {
  const queryKeys = useQueryKeys()
  const now = useNow(30_000)
  const [from] = useState(() => startOfToday().toISOString())
  const [to] = useState(() => endOfTomorrow().toISOString())
  const state = useReminderState()

  // Refetched each minute: the reminder is shown once the server has sent
  // its own, which it marks on the dose.
  const doses = useQuery({
    queryKey: queryKeys.medications.dosesFor(patient.pat_id, from, to),
    queryFn: () => fetchDoses({ patientId: patient.pat_id, from, to }),
    refetchInterval: 60_000,
  })
  const appointments = useReminderAppointments(patient.pat_id)
  const doctor = useMyDoctor(patient.doc_id)
  const setDoseStatus = useSetDoseStatus(patient.pat_id)

  const doctorName = doctor.data
    ? `Dr. ${fullName(doctor.data.doc_first_name, doctor.data.doc_last_name)}`
    : null
  const items: ReminderItem[] = [
    ...doseReminders(doses.data ?? [], now, state.current),
    ...appointmentReminders(appointments.data ?? [], now, state.current, {
      role: 'patient',
      doctorName,
    }),
  ]

  return (
    <Tray
      items={items}
      state={state}
      markTaken={(doseId) => setDoseStatus.mutate({ doseId, status: 'taken' })}
      markingDoseId={setDoseStatus.isPending ? (setDoseStatus.variables?.doseId ?? null) : null}
      failedDoseId={setDoseStatus.isError ? (setDoseStatus.variables?.doseId ?? null) : null}
    />
  )
}

function DoctorReminders() {
  const now = useNow(30_000)
  const state = useReminderState()
  const appointments = useReminderAppointments()
  const items = appointmentReminders(appointments.data ?? [], now, state.current, { role: 'doctor' })
  return <Tray items={items} state={state} />
}

/**
 * The appointments the card reminds of, refetched each minute like the
 * doses, so one cancelled or moved while the page stays open is not
 * announced for its old time. Its own copy (`forReminders`), so a refetch
 * that fails here never turns a page's list into an error.
 */
function useReminderAppointments(patientId?: string) {
  const queryKeys = useQueryKeys()
  return useQuery({
    queryKey: queryKeys.appointments.forReminders(patientId),
    queryFn: () => fetchAppointments(patientId),
    refetchInterval: 60_000,
  })
}

// --- Dismissed and snoozed, for this browser session ---------------------------

const STORAGE_KEY = 'recoverease.reminder-tray'

type ReminderStore = ReturnType<typeof useReminderState>

function readStored(): ReminderState {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as { dismissed?: unknown; snoozedUntil?: unknown }
      return {
        dismissed: new Set(Array.isArray(parsed.dismissed) ? parsed.dismissed.map(String) : []),
        snoozedUntil:
          parsed.snoozedUntil && typeof parsed.snoozedUntil === 'object'
            ? (parsed.snoozedUntil as Record<string, number>)
            : {},
      }
    }
  } catch {
    // Storage blocked or unreadable: start empty, and keep working in memory.
  }
  return { dismissed: new Set(), snoozedUntil: {} }
}

function useReminderState() {
  const [current, setCurrent] = useState<ReminderState>(readStored)

  const save = useCallback((next: ReminderState) => {
    setCurrent(next)
    try {
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ dismissed: [...next.dismissed], snoozedUntil: next.snoozedUntil }),
      )
    } catch {
      // Remembered for this page only.
    }
  }, [])

  return {
    current,
    dismiss: (id: string) =>
      save({ ...current, dismissed: new Set([...current.dismissed, id]) }),
    snooze: (id: string) =>
      save({ ...current, snoozedUntil: { ...current.snoozedUntil, [id]: Date.now() + SNOOZE_MS } }),
  }
}

// --- The card ------------------------------------------------------------------

function Tray({
  items,
  state,
  markTaken,
  markingDoseId = null,
  failedDoseId = null,
}: {
  items: ReminderItem[]
  state: ReminderStore
  markTaken?: (doseId: string) => void
  markingDoseId?: string | null
  failedDoseId?: string | null
}) {
  const trayRef = useRef<HTMLElement>(null)
  const [announcement, setAnnouncement] = useState('')
  const announced = useRef(new Set<string>())
  // Set when an action taken inside the card removes the reminder that had
  // focus, so focus goes somewhere sensible instead of to the page's top.
  const restoreFocus = useRef(false)

  // Each reminder is announced once, when it first appears, through a status
  // region that is always there - never by moving focus to it.
  const ids = items.map((item) => item.id).join('|')
  useEffect(() => {
    const fresh = items.filter((item) => !announced.current.has(item.id))
    for (const item of fresh) announced.current.add(item.id)
    if (fresh.length > 0) {
      setAnnouncement(fresh.map((item) => `${item.title}. ${item.detail}.`).join(' '))
    }
    // `items` is rebuilt every render; its ids are what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids])

  // The space the card takes, for the page to keep clear (index.css).
  const hasItems = items.length > 0
  useLayoutEffect(() => {
    const root = document.documentElement
    const tray = trayRef.current
    if (!hasItems || !tray) {
      delete root.dataset['reminderTray']
      root.style.removeProperty('--reminder-tray-space')
      return
    }
    const measure = () =>
      root.style.setProperty('--reminder-tray-space', `${Math.ceil(tray.offsetHeight) + 16}px`)
    root.dataset['reminderTray'] = ''
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(tray)
    return () => {
      observer?.disconnect()
      delete root.dataset['reminderTray']
      root.style.removeProperty('--reminder-tray-space')
    }
  }, [hasItems])

  useEffect(() => {
    if (!restoreFocus.current) return
    // Only when focus went with the reminder. Marking a dose taken removes
    // it only once the save is back: while focus is still on the card it
    // keeps waiting, and if the patient has gone to type somewhere else,
    // focus stays there.
    const active = document.activeElement
    if (active && active !== document.body && active.isConnected) {
      if (!trayRef.current?.contains(active)) restoreFocus.current = false
      return
    }
    restoreFocus.current = false
    const next = trayRef.current?.querySelector<HTMLElement>('li button, li a')
    ;(next ?? document.getElementById('main-content'))?.focus()
  }, [ids])

  // A save that failed removes nothing, so nothing later is owed focus.
  useEffect(() => {
    if (failedDoseId) restoreFocus.current = false
  }, [failedDoseId])

  // The list scrolls only once the cards are taller than it may be: a
  // scrolling list clips each card's shadow, so one or two cards keep theirs.
  const listRef = useRef<HTMLUListElement>(null)
  const [scrolls, setScrolls] = useState(false)
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const check = () => setScrolls(list.scrollHeight > list.clientHeight + 1)
    check()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(check)
    observer?.observe(list)
    return () => observer?.disconnect()
  }, [ids])

  const act = (event: { currentTarget: Element }, run: () => void) => {
    if (event.currentTarget.closest('li')?.contains(document.activeElement)) {
      restoreFocus.current = true
    }
    run()
  }

  // A snoozed reminder comes back after five minutes and is read out again
  // then, as when it first appeared. The region is emptied too: unemptied,
  // a reminder whose words have not changed - still "Medication due now" -
  // would come back without anything for a screen reader to announce.
  const snooze = (id: string) => {
    announced.current.delete(id)
    setAnnouncement('')
    state.snooze(id)
  }

  return (
    <>
      {/* Always rendered, so a new reminder is read out by every screen reader.
          A live region without the status role: the page's own status
          messages - "Saved", "Preparing a response" - stay the only status
          on the page. */}
      <div aria-live="polite" aria-atomic="true" data-reminder-announcer className="sr-only">
        {announcement}
      </div>
      {hasItems ? (
        <section
          ref={trayRef}
          aria-label="Reminders"
          data-reminder-tray
          className={cn(
            'fixed z-30 print:hidden',
            // A phone: across the foot of the screen, above the bottom bar.
            'inset-x-3 bottom-[calc(4rem+env(safe-area-inset-bottom)+0.75rem)]',
            // Larger: a column at the bottom right.
            'md:inset-x-auto md:bottom-6 md:right-6 md:w-[22rem]',
          )}
        >
          {/* At most half the screen, scrolling beyond it: several doses at
              once is common after an operation, and the soonest - first in
              the list - must stay reachable rather than pushed off the top. */}
          <ul
            ref={listRef}
            className={cn(
              '-m-1 flex max-h-[50dvh] flex-col gap-2 p-1',
              scrolls && 'overflow-y-auto overscroll-contain',
            )}
          >
            {items.map((item) => {
              const isDose = item.kind === 'dose'
              const Icon = isDose ? Pill : CalendarClock
              const subject = isDose ? item.medicine : item.title
              return (
                <li
                  key={item.id}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.stopPropagation()
                      act(event, () => state.dismiss(item.id))
                    }
                  }}
                  className="rounded-[var(--radius-lg)] border border-[var(--color-border-strong)] bg-surface p-3 shadow-lg"
                >
                  <div className="flex items-start gap-3">
                    <Icon className="mt-0.5 size-5 shrink-0 text-role" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-heading">{item.title}</p>
                      <p className="text-sm text-body" data-numeric>
                        {item.detail}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="-mr-1 -mt-1 shrink-0"
                      aria-label={`Dismiss reminder: ${subject}`}
                      onClick={(event) => act(event, () => state.dismiss(item.id))}
                    >
                      <X aria-hidden="true" />
                    </Button>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2 pl-8">
                    {isDose ? (
                      <>
                        {/* Named in full - which medicine - and starting with
                            the words on the button, so speaking what is seen
                            still finds it. */}
                        <Button
                          size="sm"
                          aria-label={`Mark taken: ${item.medicine}`}
                          isLoading={markingDoseId === item.doseId}
                          loadingLabel="Saving…"
                          onClick={(event) => act(event, () => markTaken?.(item.doseId))}
                        >
                          Mark taken
                        </Button>
                        {/* Unavailable once the card would be gone before the
                            five minutes are up - the follow-up takes over -
                            but still there, so focus on it is not lost. */}
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={`Remind me in 5 min: ${item.medicine}`}
                          aria-disabled={item.canSnooze ? undefined : true}
                          aria-describedby={item.canSnooze ? undefined : `${item.id}-no-snooze`}
                          className={cn(!item.canSnooze && 'cursor-not-allowed opacity-50 focus-visible:opacity-100')}
                          onClick={(event) => {
                            if (item.canSnooze) act(event, () => snooze(item.id))
                          }}
                        >
                          Remind me in 5 min
                        </Button>
                        {item.canSnooze ? null : (
                          <span id={`${item.id}-no-snooze`} className="sr-only">
                            Not available: the follow-up reminder comes in a few minutes.
                          </span>
                        )}
                      </>
                    ) : (
                      <Link to={item.href} className={buttonVariants({ size: 'sm', variant: 'outline' })}>
                        {item.actionLabel}
                      </Link>
                    )}
                  </div>
                  {isDose && failedDoseId === item.doseId ? (
                    <p role="alert" className="mt-2 pl-8 text-sm font-medium text-danger-700">
                      That was not saved. Try again, or mark it on Medications.
                    </p>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}
    </>
  )
}
