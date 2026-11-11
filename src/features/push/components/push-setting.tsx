import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BellRing } from 'lucide-react'

import { Notice } from '@/components/ui/notice'
import { useQueryKeys } from '@/features/auth/use-query-keys'
import {
  browserPushEnvironment,
  disablePush,
  enablePush,
  PushSetupError,
  readPushState,
  type PushEnvironment,
  type PushState,
} from '@/features/push/push-device'
import { cn } from '@/lib/utils'

/**
 * "Notifications on this phone": the patient's switch for Web Push on the
 * device they are holding (migration 53).
 *
 * It acts at once, not with the profile form's Save: the browser's own
 * permission prompt has to come straight from a tap, and the setting
 * belongs to this device, not to the patient's record. What the lock screen
 * shows is said before it is switched on - never a medicine's name.
 */
export function PushSetting({ environment }: { environment?: PushEnvironment }) {
  const env = environment ?? browserPushEnvironment()
  const queryKeys = useQueryKeys()
  const queryClient = useQueryClient()
  const key = queryKeys.pushDevice.state()

  const state = useQuery({
    queryKey: key,
    queryFn: () => readPushState(env),
    staleTime: 30_000,
  })

  const change = useMutation({
    mutationFn: (turnOn: boolean) => (turnOn ? enablePush(env) : disablePush(env)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  })

  const current: PushState | undefined = state.data
  const isOn = current === 'on'
  const canSwitch = current === 'on' || current === 'off'
  const busy = state.isPending || change.isPending

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 rounded-[var(--radius-md)] bg-surface-sunken p-3">
        <BellRing aria-hidden className="mt-0.5 size-5 shrink-0 text-brand-700" />
        <div className="min-w-0 flex-1">
          <p id="push-setting-label" className="font-medium text-heading">
            Reminders on this phone
          </p>
          <p id="push-setting-description" className="text-sm text-muted">
            Your phone shows &ldquo;You have a reminder in RecoverEase.&rdquo; when a
            medication or appointment reminder is sent, even with the app closed. It
            never shows a medicine&rsquo;s name. Tap it to open RecoverEase and see the
            details after signing in.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={isOn}
          aria-labelledby="push-setting-label"
          aria-describedby="push-setting-description"
          disabled={!canSwitch || busy}
          onClick={() => change.mutate(!isOn)}
          className={cn(
            'relative mt-0.5 inline-flex h-7 w-12 shrink-0 items-center rounded-full border-2 border-transparent',
            'transition-colors duration-[var(--duration-fast)] disabled:cursor-not-allowed disabled:opacity-50',
            isOn ? 'bg-fill-brand-800' : 'bg-neutral-400',
          )}
        >
          <span
            aria-hidden
            className={cn(
              'inline-block size-6 rounded-full bg-white shadow transition-transform duration-[var(--duration-fast)]',
              isOn ? 'translate-x-5' : 'translate-x-0',
            )}
          />
        </button>
      </div>

      <StateNotice state={current} failed={state.isError} />

      {change.isError ? (
        <Notice tone="danger" title="That did not work" live="assertive">
          {change.error instanceof PushSetupError
            ? change.error.message
            : 'RecoverEase could not change phone reminders. Check your connection and try again.'}
        </Notice>
      ) : null}

      <p className="text-sm text-muted">
        This is for this phone only. Your in-app reminders and the calendar file on
        the Medications page work as before.
      </p>
    </div>
  )
}

function StateNotice({ state, failed }: { state: PushState | undefined; failed: boolean }) {
  if (failed) {
    return (
      <Notice tone="warning">
        Could not check whether phone reminders are on. Reload the page to try again.
      </Notice>
    )
  }
  switch (state) {
    case 'unsupported':
      return (
        <Notice tone="info">
          This browser cannot show RecoverEase notifications. On Android, open
          RecoverEase in Chrome and install it to your home screen.
        </Notice>
      )
    case 'unavailable':
      return <Notice tone="info">Phone reminders are not available yet.</Notice>
    case 'no-worker':
      return (
        <Notice tone="info">
          Open RecoverEase from the app on your home screen to turn on phone reminders.
        </Notice>
      )
    case 'blocked':
      return (
        <Notice tone="warning" title="Notifications are blocked">
          Your browser is set to block notifications from RecoverEase. To allow them,
          open the site settings in Chrome (or Android&rsquo;s app settings for
          RecoverEase), allow notifications, then come back here.
        </Notice>
      )
    default:
      return null
  }
}
