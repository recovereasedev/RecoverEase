import { Download, Share, Smartphone, X } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'

import { Button } from '@/components/ui/button'
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
 * How long the slot takes to close over the space the answered offer left.
 * Matches `--duration-base`, the transition in `index.css`.
 */
const CLOSES_AFTER_MS = 180

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
  const [isClosing, setClosing] = useState(false)
  const [step, setStep] = useState<Step>('offer')
  const [isAsking, setAsking] = useState(false)
  const hasAppeared = useRef(false)
  const slotRef = useRef<HTMLDivElement>(null)

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

  /**
   * Answering takes the card away at once - there is no ghost of an offer
   * that has already been answered, and nothing stays on screen after it has
   * left the accessibility tree. What is animated is the space it was given:
   * the slot holds its height for a moment and closes, so the page settles
   * back rather than jumping up under the pointer that just answered.
   */
  const close = useCallback(() => {
    rememberInstallPromptDismissed()
    const slot = slotRef.current
    if (slot) slot.style.height = `${slot.offsetHeight}px`
    setClosing(true)
  }, [])

  useEffect(() => {
    if (!isClosing) return
    const wantsLessMotion =
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    let frame: number | undefined
    if (!wantsLessMotion) {
      // The height was frozen in `close`, on the render that still had the
      // card in it. Reading it back here forces that value to be computed
      // before the next one is written, which is what gives the transition
      // two ends to run between.
      frame = requestAnimationFrame(() => {
        const slot = slotRef.current
        if (!slot) return
        void slot.offsetHeight
        slot.style.height = '0px'
      })
    }
    const timer = setTimeout(
      () => {
        setOpen(false)
        setClosing(false)
      },
      wantsLessMotion ? 0 : CLOSES_AFTER_MS,
    )
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      clearTimeout(timer)
    }
  }, [isClosing])

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

  // An event can arrive after the popup has already fallen back to saying how
  // to install by hand - Chromium decides when to offer one. When it does,
  // the offer comes back: the browser can install after all, and instructions
  // are the wrong thing to be reading. Derived rather than stored, so a late
  // event does not have to travel through another render to be acted on. iOS
  // keeps its steps, which are the only way in there.
  const shown: Step = deferred && step !== 'ios' ? 'offer' : step

  if (!isOpen) return null

  return (
    <InstallPopup
      onClose={close}
      isClosing={isClosing}
      slotRef={slotRef}
      title={shown === 'offer' ? 'Install RecoverEase' : 'How to install RecoverEase'}
      actions={
        <>
          <Button variant="ghost" onClick={close}>
            Maybe Later
          </Button>
          {shown === 'offer' ? (
            <Button
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
      {shown === 'offer' ? <Offer /> : null}
      {shown === 'ios' ? <AddToHomeScreenSteps /> : null}
      {shown === 'browserMenu' ? <InstallFromTheBrowserMenu /> : null}
      {shown === 'unsupported' ? <NotAvailableHere /> : null}
    </InstallPopup>
  )
}

/**
 * Where the offer goes: a slot opened at the top of the page's own content,
 * rather than a card laid over it.
 *
 * Every overlay version of this had the same fault, wherever it was put. A
 * modal in the middle covered the hero; moved to the top it still sat on the
 * headline, and on a phone - where the headline starts directly under the
 * header - it covered it completely. There is no free space at the top of a
 * page that is already using it.
 *
 * So the offer takes space instead of borrowing it: it is inserted as the
 * first thing inside `<main>`, below the page's own header, and the content
 * starts below it. Nothing is covered at any width, on any route, at any
 * scroll position - and because it is part of the page rather than fixed to
 * the window, scrolling leaves it behind like any other block.
 */
function useInstallSlot(): HTMLElement {
  // Made once, on the first render, and filled by the portal below. The
  // effect only decides where in the page it belongs; until it runs the node
  // is not in the document, so nothing is shown in the wrong place.
  const [node] = useState(() => document.createElement('div'))

  useEffect(() => {
    const attach = () => {
      // The page's own content column. Where a page has no `main` - only the
      // routes with one offer it - the end of the document will do.
      const main = document.querySelector('main')
      if (main) main.prepend(node)
      else document.body.append(node)

      // The slot takes the background of whatever it sits on top of. The
      // landing page's hero is a white section on a tinted canvas, and an
      // unpainted slot drew a band across the page between the two. Where
      // the neighbour has no background of its own - the sign-in column -
      // nothing is set, because the page's own background is already right.
      const under = node.nextElementSibling
      const background = under ? getComputedStyle(under).backgroundColor : ''
      const isTransparent =
        !background || background === 'transparent' || /,\s*0\)$/.test(background)
      document.documentElement.style.setProperty(
        '--install-slot-surface',
        isTransparent ? 'transparent' : background,
      )
    }
    attach()

    // Moving between the public pages replaces `main`, and the slot goes with
    // it. Put it back, rather than losing an offer nobody has answered.
    const observer = new MutationObserver(() => {
      if (!node.isConnected) attach()
    })
    observer.observe(document.body, { childList: true, subtree: true })

    return () => {
      observer.disconnect()
      node.remove()
      document.documentElement.style.removeProperty('--install-slot-surface')
    }
  }, [node])

  return node
}

/**
 * The offer itself: a compact card at the top of the page, centred in the
 * content it introduces.
 *
 * What it keeps from the modal it replaces: a labelled `dialog` role, Escape,
 * a close button, 44px targets and readable text. What it drops: the
 * backdrop, the focus trap and the page being unusable until the browser
 * question is answered. It does not take focus - nobody asked for it - and
 * sitting first inside `main` puts it early in the tab order anyway, right
 * after the page's own navigation.
 */
function InstallPopup({
  title,
  actions,
  onClose,
  isClosing,
  slotRef,
  children,
}: {
  title: string
  actions: ReactNode
  onClose: () => void
  /** Answered: the card is gone, and its space is closing. */
  isClosing: boolean
  slotRef: RefObject<HTMLDivElement | null>
  children: ReactNode
}) {
  const titleId = useId()
  const bodyId = useId()
  const host = useInstallSlot()

  // Escape answers it, as it would a dialog. Bound to the window rather than
  // to the card, because focus is left where the reader had it.
  useEffect(() => {
    if (isClosing) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, isClosing])

  return createPortal(
    // The slot: opens to the card's height on arrival, closes over the space
    // once it is answered (see `index.css`).
    <div className="install-slot">
      <div ref={slotRef} className="install-slot-space">
        <div className="px-4 pb-2 pt-5 sm:pt-6">
          {isClosing ? null : (
            <div
              role="dialog"
              aria-labelledby={titleId}
              aria-describedby={bodyId}
              // 420px: compact enough to read as an offer rather than a page
              // of its own, wide enough that the sentence holds two lines.
              className="install-popup mx-auto w-full max-w-[26.25rem] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-surface shadow-[var(--shadow-md)]"
            >
              <div className="flex items-start justify-between gap-3 px-4 pt-3 sm:px-5">
                <h2 id={titleId} className="pt-2 text-headline-md text-heading">
                  {title}
                </h2>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onClose}
                  aria-label="Close"
                >
                  <X aria-hidden="true" />
                </Button>
              </div>

              <div id={bodyId} className="px-4 pb-4 pt-2 sm:px-5 sm:pb-5">
                {children}

                {/* The primary action last in reading order, and first on a
                    phone, where the pair stacks rather than crowding a 256px
                    line. */}
                <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:gap-3 [&>*]:w-full sm:[&>*]:w-auto">
                  {actions}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    host,
  )
}

function Offer() {
  return (
    <div className="flex items-start gap-3">
      {/* The glyph says which kind of offer this is; it does not need a tile
          of its own to do that. */}
      <Smartphone
        className="mt-0.5 size-5 shrink-0 text-role"
        aria-hidden="true"
      />
      <p className="text-base leading-relaxed text-body">
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
          <span className="pt-0.5 text-base leading-relaxed text-body">
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
      <p className="text-base leading-relaxed text-body">
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
      <p className="text-base leading-relaxed text-body">
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
      <p className="text-base leading-relaxed text-body">
        This browser cannot install RecoverEase. Everything still works here,
        exactly as it does now.
      </p>
      <p className="text-base leading-relaxed text-body">
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
