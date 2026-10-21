import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  Copy,
  KeyRound,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import { flushSync } from 'react-dom'

import { ErrorState, LoadingState } from '@/components/feedback/state-view'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/field'
import { Notice } from '@/components/ui/notice'
import { useAuth } from '@/features/auth/auth-context'
import { useQueryKeys } from '@/features/auth/use-query-keys'
import {
  describeMfaFailure,
  parseAuthenticatorCode,
  readAssurance,
  startEnrolment,
  verifyAuthenticatorCode,
  type PendingAuthenticator,
} from '@/features/platform/mfa'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { copyToClipboard } from '@/lib/clipboard'
import { focusFirstInvalid } from '@/lib/form-focus'

/**
 * The platform console's second step: an authenticator-app code, in every
 * session, before any console screen renders.
 *
 * It wraps the console the way `PasswordSetupGate` wraps a clinic's screens,
 * rather than redirecting to a route of its own, so a deep link to
 * /platform/audit and a reload both land here until a code is entered.
 *
 * This is presentation. The boundary is the database: every Super Admin
 * function checks the session itself (migration 33), so a console that
 * rendered early would get nothing but refusals. The gate's job is to make
 * the required step clear - set up an authenticator, or enter its code - and
 * to fail closed when the answer cannot be read.
 */
export function SuperAdminAssuranceGate({ children }: { children: ReactNode }) {
  const queryKeys = useQueryKeys()
  const queryClient = useQueryClient()
  const queryKey = queryKeys.platform.assurance()

  const assurance = useQuery({
    queryKey,
    queryFn: readAssurance,
    // Read afresh whenever the gate appears, and dropped as soon as it goes:
    // an answer cached from a session that has since signed out must never
    // open the console for the next one.
    staleTime: 0,
    gcTime: 0,
  })

  // Resolves once the new answer is in, so the screen that asked can keep
  // its button busy until the gate replaces it.
  const recheck = () => queryClient.refetchQueries({ queryKey, exact: true })

  if (assurance.isPending) {
    return (
      <div className="flex min-h-dvh items-center justify-center px-5">
        <LoadingState label="Checking your sign-in…" />
      </div>
    )
  }

  if (assurance.isError) {
    return <AssuranceUnavailable error={assurance.error} onRetry={recheck} />
  }

  switch (assurance.data.step) {
    case 'assured':
      return <>{children}</>
    case 'enrol':
      return <SetUpAuthenticator onVerified={recheck} />
    case 'verify':
      return (
        <EnterAuthenticatorCode
          factorId={assurance.data.factorId}
          onVerified={recheck}
        />
      )
    case 'refused':
      return <SessionRefused onRetry={recheck} />
  }
}

// --- Frame -------------------------------------------------------------------

/** The same card the forced password change uses, so the two steps match. */
function GateFrame({
  icon: Icon,
  tone = 'neutral',
  title,
  description,
  children,
  offerSignOut = true,
}: {
  icon: LucideIcon
  tone?: 'neutral' | 'danger'
  title: string
  description: ReactNode
  children: ReactNode
  /** Off where signing out is already the screen's main action. */
  offerSignOut?: boolean
}) {
  const { signOut } = useAuth()

  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col px-4 pt-8 pb-[max(2rem,env(safe-area-inset-bottom))] sm:px-5 sm:py-10">
      <div className="my-auto w-full rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-surface p-5 sm:rounded-[var(--radius-xl)] sm:p-8">
        <span
          className={
            tone === 'danger'
              ? 'flex size-11 items-center justify-center rounded-full bg-danger-50'
              : 'flex size-11 items-center justify-center rounded-full bg-brand-50'
          }
        >
          <Icon
            className={
              tone === 'danger' ? 'size-5 text-danger-700' : 'size-5 text-brand-700'
            }
            aria-hidden="true"
          />
        </span>

        <h1 className="mt-5 text-headline-lg text-heading">{title}</h1>
        <div className="mt-2 space-y-2 text-body">{description}</div>

        {children}

        {offerSignOut ? (
          <p className="mt-6 text-center text-sm text-muted">
            Not your account?{' '}
            <button
              type="button"
              onClick={() => void signOut()}
              className="min-h-11 font-medium text-brand-700 underline underline-offset-2 sm:min-h-0"
            >
              Sign out
            </button>
          </p>
        ) : null}
      </div>
    </main>
  )
}

/**
 * What to do when the authenticator is gone. It names a way out that exists
 * (docs/security.md, "A lost authenticator") and no way round the code,
 * because there is none.
 */
function LostAuthenticatorHelp() {
  return (
    <details className="mt-6 rounded-[var(--radius-md)] border border-[var(--color-border)] px-4 py-3">
      <summary className="min-h-11 cursor-pointer content-center text-sm font-medium text-heading sm:min-h-0">
        Lost your authenticator app?
      </summary>
      <div className="mt-2 space-y-2 text-sm text-body">
        <p>
          There is no way to skip this step: it is what keeps the platform,
          and every clinic on it, safe.
        </p>
        <p>
          Contact the RecoverEase platform owner. Once they have confirmed it
          is you, they remove your old authenticator, and the next time you
          sign in you set up a new one here.
        </p>
      </div>
    </details>
  )
}

// --- The code ------------------------------------------------------------------

/**
 * Six digits from the authenticator app. Checked when submitted, so the
 * button is never greyed out waiting for a complete code; a wrong one is
 * said beside the field, which is emptied and focused for the next try.
 */
function AuthenticatorCodeForm({
  factorId,
  submitLabel,
  autoFocus = false,
  onVerified,
}: {
  factorId: string
  submitLabel: string
  autoFocus?: boolean
  onVerified: () => Promise<unknown>
}) {
  const [code, setCode] = useState('')
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const [isChecking, setChecking] = useState(false)
  // One code, one check: a second press while the first is in flight would
  // spend a second attempt against the rate limit for nothing.
  const inFlight = useRef(false)
  const form = useRef<HTMLFormElement>(null)

  const fail = (message: string) => {
    flushSync(() => setProblem(message))
    focusFirstInvalid(form.current)
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (inFlight.current) return

    const parsed = parseAuthenticatorCode(code)
    if (!parsed.ok) {
      fail(parsed.message)
      return
    }

    inFlight.current = true
    setChecking(true)
    setProblem(undefined)
    try {
      try {
        await verifyAuthenticatorCode(factorId, parsed.code)
      } catch (caught) {
        // A used code cannot be entered again, so the field is emptied for
        // the next one rather than left holding the one that failed.
        flushSync(() => setCode(''))
        fail(describeMfaFailure(caught))
        return
      }
      // The code was accepted. The gate now reads the session again and
      // replaces this screen; until it does, the button stays busy.
      await onVerified()
    } finally {
      inFlight.current = false
      setChecking(false)
    }
  }

  return (
    <form
      ref={form}
      onSubmit={(event) => void submit(event)}
      className="mt-6 space-y-4"
      noValidate
    >
      <Field
        label="6-digit code"
        required
        error={problem}
        description="Shown in your authenticator app under RecoverEase. It changes every 30 seconds."
      >
        <Input
          value={code}
          onChange={(event) => {
            setCode(event.target.value)
            setProblem(undefined)
          }}
          inputMode="numeric"
          autoComplete="one-time-code"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoFocus={autoFocus}
          className="font-mono tracking-widest"
        />
      </Field>

      <Button
        type="submit"
        size="lg"
        block
        isLoading={isChecking}
        loadingLabel="Checking your code…"
      >
        {submitLabel}
      </Button>
    </form>
  )
}

// --- Setting one up ------------------------------------------------------------

function SetUpAuthenticator({
  onVerified,
}: {
  onVerified: () => Promise<unknown>
}) {
  useDocumentTitle('Set Up Authenticator')
  // Held in this component's state only: never in a query cache, storage or
  // a log, and gone when the screen is.
  const [pending, setPending] = useState<PendingAuthenticator | null>(null)
  const [isStarting, setStarting] = useState(false)
  const [startProblem, setStartProblem] = useState<string | null>(null)
  const starting = useRef(false)

  const start = async () => {
    if (starting.current) return
    starting.current = true
    setStarting(true)
    setStartProblem(null)
    try {
      setPending(await startEnrolment())
    } catch (caught) {
      setStartProblem(describeMfaFailure(caught))
    } finally {
      starting.current = false
      setStarting(false)
    }
  }

  return (
    <GateFrame
      icon={Smartphone}
      title="Set up your authenticator app"
      description={
        <>
          <p>
            Platform administration needs a second step every time you sign
            in: a 6-digit code from an authenticator app on your phone, such
            as Google Authenticator, Microsoft Authenticator or 1Password.
          </p>
          <p>
            Keep the app once it is set up. If you lose it, the platform owner
            has to confirm who you are before you can set up a new one.
          </p>
        </>
      }
    >
      {startProblem ? (
        <div className="mt-6">
          <Notice tone="danger" live="assertive">
            {startProblem}
          </Notice>
        </div>
      ) : null}

      {pending ? (
        <>
          <ol className="mt-6 space-y-6">
            <li>
              <h2 className="text-base font-semibold text-heading">
                1. Scan this QR code with your authenticator app
              </h2>
              {/* White behind the code whatever the theme: a scanner needs
                  dark modules on a light ground. */}
              <img
                src={pending.qrCode}
                alt="QR code for adding RecoverEase to your authenticator app"
                width={176}
                height={176}
                className="mt-3 size-44 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-white p-2"
              />
              <SetupKey value={pending.setupKey} />
            </li>
            <li>
              <h2 className="text-base font-semibold text-heading">
                2. Enter the code it shows
              </h2>
              <AuthenticatorCodeForm
                factorId={pending.factorId}
                submitLabel="Verify and continue"
                onVerified={onVerified}
              />
            </li>
          </ol>

          <div className="mt-4">
            <Button
              variant="ghost"
              block
              isLoading={isStarting}
              loadingLabel="Making a new QR code…"
              onClick={() => void start()}
            >
              Start again with a new QR code
            </Button>
          </div>
        </>
      ) : (
        <div className="mt-6">
          <Button
            size="lg"
            block
            isLoading={isStarting}
            loadingLabel="Setting up…"
            onClick={() => void start()}
          >
            <KeyRound aria-hidden="true" />
            Set up authenticator app
          </Button>
        </div>
      )}
    </GateFrame>
  )
}

/**
 * The secret behind the QR code, for an app that cannot scan or a person
 * who cannot see the code. Grouped in fours to be typed accurately; copied
 * without the spaces.
 */
function SetupKey({ value }: { value: string }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>(
    'idle',
  )
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const copy = async () => {
    const outcome = await copyToClipboard(value)
    setCopyState(outcome)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(
      () => setCopyState('idle'),
      outcome === 'copied' ? 2000 : 8000,
    )
  }

  const grouped = value.match(/.{1,4}/g)?.join(' ') ?? value

  return (
    <div className="mt-4 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-surface-sunken p-4">
      <p className="text-sm text-body">
        Cannot scan it? Add an account by hand in your authenticator app, and
        enter this setup key:
      </p>
      <div className="mt-2 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
        <p className="w-full min-w-0 flex-1 select-all font-mono text-base font-semibold tracking-wide break-words text-heading">
          {grouped}
        </p>
        <button
          type="button"
          onClick={() => void copy()}
          className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-surface px-3 text-sm font-medium text-heading transition-colors hover:bg-surface-sunken"
        >
          {copyState === 'copied' ? (
            <Check className="size-4" aria-hidden="true" />
          ) : copyState === 'failed' ? (
            <TriangleAlert className="size-4" aria-hidden="true" />
          ) : (
            <Copy className="size-4" aria-hidden="true" />
          )}
          {copyState === 'copied' ? 'Copied' : 'Copy setup key'}
        </button>
      </div>
      <p
        className={
          copyState === 'failed'
            ? 'mt-2 text-sm font-medium text-danger-700'
            : 'mt-2 text-sm text-muted'
        }
        role="status"
        aria-live="polite"
      >
        {copyState === 'failed'
          ? 'Copy failed - select the key above and copy it by hand.'
          : copyState === 'copied'
            ? 'Copied to the clipboard.'
            : 'Choose a time-based key if the app asks.'}
      </p>
    </div>
  )
}

// --- Every later sign-in ---------------------------------------------------------

function EnterAuthenticatorCode({
  factorId,
  onVerified,
}: {
  factorId: string
  onVerified: () => Promise<unknown>
}) {
  useDocumentTitle('Verify Your Sign-In')

  return (
    <GateFrame
      icon={ShieldCheck}
      title="Enter your authenticator code"
      description={
        <p>
          Open your authenticator app and enter the 6-digit code it shows for
          RecoverEase. The platform console asks for one every time you sign
          in.
        </p>
      }
    >
      <AuthenticatorCodeForm
        factorId={factorId}
        submitLabel="Verify"
        autoFocus
        onVerified={onVerified}
      />
      <LostAuthenticatorHelp />
    </GateFrame>
  )
}

// --- Failing closed ----------------------------------------------------------------

function SessionRefused({ onRetry }: { onRetry: () => Promise<unknown> }) {
  useDocumentTitle('Verify Your Sign-In')
  const { signOut } = useAuth()
  const [isChecking, setChecking] = useState(false)

  return (
    <GateFrame
      icon={ShieldAlert}
      tone="danger"
      offerSignOut={false}
      title="This session cannot open the platform console"
      description={
        <p>
          RecoverEase could not confirm that this session was verified with
          your authenticator app. It may have been signed out somewhere else.
          Sign out, then sign in again and enter a new code.
        </p>
      }
    >
      <div className="mt-6 space-y-3">
        <Button size="lg" block onClick={() => void signOut()}>
          Sign out
        </Button>
        <Button
          variant="outline"
          size="lg"
          block
          isLoading={isChecking}
          loadingLabel="Checking again…"
          onClick={() => {
            setChecking(true)
            void onRetry().finally(() => setChecking(false))
          }}
        >
          Check again
        </Button>
      </div>
    </GateFrame>
  )
}

function AssuranceUnavailable({
  error,
  onRetry,
}: {
  error: unknown
  onRetry: () => Promise<unknown>
}) {
  const { signOut } = useAuth()

  // Nothing of the console renders when the answer cannot be read: not
  // knowing is treated as no.
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-5">
      <ErrorState error={error} titleAs="h1" onRetry={() => void onRetry()} />
      <Button variant="ghost" onClick={() => void signOut()}>
        Sign out
      </Button>
    </main>
  )
}
