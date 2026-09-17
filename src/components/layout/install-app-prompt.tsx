import { Download, Share, Smartphone } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'

import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import {
  installPromptStore,
  isAppInstalled,
  isAppInstalledElsewhere,
  isIosDevice,
  isIosSafari,
  rememberInstallPromptDismissed,
  supportsInstallPromptEvent,
  waitForInstallPrompt,
  wasInstallPromptDismissed,
  INSTALL_PROMPT_GRACE_MS,
  type InstallPromptStore,
} from '@/lib/pwa-install'

/**
 * RecoverEase's own offer to install itself as an app.
 *
 * It is a RecoverEase popup, not the browser's. Install always prefers the
 * browser's own installation: it uses the `beforeinstallprompt` event the
 * browser handed over, and where none has arrived yet it waits a moment for
 * one rather than deciding the browser cannot install. Only when no event is
 * coming does the popup say what to do by hand, and it never imitates an
 * installation that is not happening.
 *
 * When it appears:
 *
 * - Not when this window *is* the installed app, and not when the browser can
 *   tell us RecoverEase is already installed on the device from some other
 *   window. Only Chromium can answer the second question; where it cannot,
 *   the first one stands on its own, exactly as before.
 * - Not twice in one visit. Closing it - by any route - is an answer, and it
 *   is remembered for the rest of the visit only, so the offer comes back on
 *   the next one. See `wasInstallPromptDismissed`.
 * - After the page has loaded, and a moment after that, so it never competes
 *   with the first screen. One timer, once; never a reminder that reopens
 *   itself while someone is reading the page.
 */

/** How long after the page has loaded the offer appears. */
const APPEARS_AFTER_MS = 1500

/**
 * `offer` is the popup as specified. The rest are what Install falls back to
 * when no install event is coming, and they are three different situations:
 *
 *   ios          - the person adds it themselves, and always has to.
 *   browserMenu  - a browser that can install RecoverEase but has not offered
 *                  to here. It has its own way in, and saying it "cannot
 *                  install" would be untrue.
 *   unsupported  - a browser with no installation of any kind.
 */
type Step = 'offer' | 'ios' | 'browserMenu' | 'unsupported'

export function InstallAppPrompt({
  store = installPromptStore,
  appearsAfterMs = APPEARS_AFTER_MS,
  graceMs = INSTALL_PROMPT_GRACE_MS,
}: {
  /** Injectable so a test can supply the browser's event itself. */
  store?: InstallPromptStore
  appearsAfterMs?: number
  /** How long Install waits for an event that has not arrived yet. */
  graceMs?: number
} = {}) {
  const [isOpen, setOpen] = useState(false)
  const [step, setStep] = useState<Step>('offer')
  const [isAsking, setAsking] = useState(false)
  const hasAppeared = useRef(false)

  const deferred = useSyncExternalStore(store.subscribe, store.get, () => null)

  // Harmless where `main.tsx` has already started it, and what makes the
  // component work on its own.
  useEffect(() => {
    store.start()
  }, [store])

  useEffect(() => {
    if (hasAppeared.current) return
    if (isAppInstalled() || wasInstallPromptDismissed()) return

    let timer: ReturnType<typeof setTimeout> | undefined
    let abandoned = false

    const offer = () => {
      timer = setTimeout(() => {
        // Checked again here: the app can be installed, or the offer answered,
        // while this timer is running.
        if (isAppInstalled() || wasInstallPromptDismissed()) return

        // The browser's own answer to the wider question, where it has one.
        // It resolves `false` rather than failing when it has none, so the
        // offer is only ever held back by a real installation.
        void isAppInstalledElsewhere().then((installedElsewhere) => {
          if (abandoned || installedElsewhere) return
          if (isAppInstalled() || wasInstallPromptDismissed()) return
          hasAppeared.current = true
          setOpen(true)
        })
      }, appearsAfterMs)
    }

    if (document.readyState === 'complete') offer()
    else window.addEventListener('load', offer, { once: true })

    return () => {
      abandoned = true
      clearTimeout(timer)
      window.removeEventListener('load', offer)
    }
  }, [appearsAfterMs])

  const close = useCallback(() => {
    rememberInstallPromptDismissed()
    setOpen(false)
  }, [])

  // An event can arrive after the popup has already fallen back to saying how
  // to install by hand - Chromium decides when to offer one. When it does,
  // the offer comes back: the browser can install after all, and instructions
  // are the wrong thing to be reading. iOS keeps its steps, which are the
  // only way in there.
  useEffect(() => {
    if (!deferred) return
    setStep((current) => (current === 'ios' ? current : 'offer'))
  }, [deferred])

  // Installation can also finish in the browser's own window, with the popup
  // still open behind it. Once it has, there is nothing left to offer.
  useEffect(() => {
    window.addEventListener('appinstalled', close)
    return () => window.removeEventListener('appinstalled', close)
  }, [close])

  /** What to say when no install event is coming. */
  const guidance = (): Step =>
    isIosDevice() ? 'ios' : supportsInstallPromptEvent() ? 'browserMenu' : 'unsupported'

  const install = async () => {
    // iOS has no install event and never will, so it is answered at once
    // rather than waiting for something that cannot arrive.
    if (!deferred && isIosDevice()) {
      setStep('ios')
      return
    }

    setAsking(true)

    // Pressing Install is itself an answer to this popup, so it is recorded
    // here rather than when the dialog closes. Chrome closes a page's modal
    // silently while its own installation dialog is up, and an answer that
    // went unrecorded would have the offer coming back later in the visit.
    rememberInstallPromptDismissed()

    // The event may still be on its way: Chromium decides when to offer it,
    // and that can be after the popup opened or after this click. Waiting is
    // what keeps an installable browser out of the instructions below.
    const event = deferred ?? (await waitForInstallPrompt(store, graceMs))

    if (!event) {
      setAsking(false)
      setStep(guidance())
      return
    }

    try {
      // Returns once the browser's own installation dialog is on screen. That
      // dialog is the browser's, and it is now the only thing being asked, so
      // this popup steps out of its way rather than sitting behind it.
      await event.prompt()

      // Spent: the browser allows one use of the event.
      store.clear()
      setAsking(false)
      close()

      // The answer is the browser's to give, and an installation is picked up
      // by `appinstalled` either way. It is not awaited before closing: a
      // dialog dismissed by anything other than its own buttons can leave
      // this promise pending for ever, and with it a button that spins and a
      // popup that will not go away.
      void event.userChoice.then(
        () => undefined,
        () => undefined,
      )
    } catch {
      // The browser refused to show its prompt - an event already used, most
      // often. Fall back to guidance rather than leaving a dead button.
      store.clear()
      setAsking(false)
      setStep(guidance())
    }
  }

  if (!isOpen) return null

  return (
    <Dialog
      isOpen
      onClose={close}
      title={step === 'offer' ? 'Install RecoverEase' : 'How to install RecoverEase'}
      footer={
        <>
          <Button variant="ghost" size="lg" onClick={close}>
            Maybe Later
          </Button>
          {step === 'offer' ? (
            <Button
              size="lg"
              isLoading={isAsking}
              loadingLabel="Waiting for your browser…"
              onClick={install}
            >
              <Download aria-hidden="true" />
              Install RecoverEase
            </Button>
          ) : null}
        </>
      }
    >
      {step === 'offer' ? <Offer /> : null}
      {step === 'ios' ? <AddToHomeScreenSteps /> : null}
      {step === 'browserMenu' ? <InstallFromTheBrowserMenu /> : null}
      {step === 'unsupported' ? <NotAvailableHere /> : null}
    </Dialog>
  )
}

function Offer() {
  return (
    <div className="flex items-start gap-4">
      <span
        aria-hidden="true"
        className="flex size-12 shrink-0 items-center justify-center rounded-[var(--radius-lg)] bg-brand-50 text-brand-800"
      >
        <Smartphone className="size-6" />
      </span>
      <p className="text-base leading-relaxed text-body sm:text-lg">
        Install RecoverEase on your device for easier access and a more
        convenient experience.
      </p>
    </div>
  )
}

/** The numbered steps both sets of by-hand instructions are written in. */
function NumberedSteps({ steps }: { steps: ReactNode[] }) {
  return (
    <ol className="space-y-3">
      {steps.map((content, index) => (
        <li key={index} className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-800 text-base font-semibold text-white"
          >
            {index + 1}
          </span>
          <span className="pt-0.5 text-base leading-relaxed text-body sm:text-lg">
            {content}
          </span>
        </li>
      ))}
    </ol>
  )
}

/** iPhone and iPad, where only the person can add the app, from Safari. */
function AddToHomeScreenSteps() {
  return (
    <div className="space-y-4">
      <p className="text-base leading-relaxed text-body sm:text-lg">
        On iPhone and iPad you add RecoverEase yourself, in three steps:
      </p>

      <NumberedSteps
        steps={[
          <>
            Tap the <strong className="font-semibold text-heading">Share</strong>{' '}
            button
            <Share
              aria-hidden="true"
              className="mx-1 inline size-5 align-text-bottom"
            />
            at the bottom of the screen.
          </>,
          <>
            Tap{' '}
            <strong className="font-semibold text-heading">
              Add to Home Screen
            </strong>
            .
          </>,
          <>
            Tap <strong className="font-semibold text-heading">Add</strong>.
          </>,
        ]}
      />

      {isIosSafari() ? null : (
        <p className="text-base leading-relaxed text-body">
          These steps work in Safari. If you are using another browser, open
          RecoverEase in Safari first.
        </p>
      )}

      <p className="text-sm text-muted">
        RecoverEase then opens from your home screen, like any other app.
      </p>
    </div>
  )
}

/**
 * A browser that can install RecoverEase but has not offered to on this page.
 *
 * Chromium decides when to offer its install event, and it withholds it
 * entirely once the app is installed. Both are cases where the browser's own
 * menu still works, so that is what this says - rather than claiming the
 * browser cannot do something it plainly can.
 */
function InstallFromTheBrowserMenu() {
  return (
    <div className="space-y-4">
      <p className="text-base leading-relaxed text-body sm:text-lg">
        Your browser has not offered to install RecoverEase on this page. You
        can still install it from the browser's own menu:
      </p>

      <NumberedSteps
        steps={[
          <>
            Open the browser menu at the top right of the window.
          </>,
          <>
            Look for{' '}
            <strong className="font-semibold text-heading">
              Install RecoverEase
            </strong>
            . In Chrome it is under "Cast, save and share"; in Microsoft Edge
            it is under "Apps".
          </>,
          <>
            Choose <strong className="font-semibold text-heading">Install</strong>.
          </>,
        ]}
      />

      <p className="text-sm text-muted">
        Already installed RecoverEase? Open it from your list of apps. It does
        not need installing twice.
      </p>
    </div>
  )
}

/** Everything else: no install event, and nothing the person can do by hand. */
function NotAvailableHere() {
  return (
    <div className="space-y-4">
      <p className="text-base leading-relaxed text-body sm:text-lg">
        This browser cannot install RecoverEase. Everything still works here,
        exactly as it does now.
      </p>
      <p className="text-base leading-relaxed text-body sm:text-lg">
        To install it, open RecoverEase in Chrome or Microsoft Edge on a
        computer, or in Chrome on an Android phone.
      </p>
      <p className="text-sm text-muted">
        Already installed RecoverEase? Open it from your home screen or your
        list of apps.
      </p>
    </div>
  )
}
