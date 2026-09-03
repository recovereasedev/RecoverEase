import { ShieldCheck } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { ErrorState } from '@/components/feedback/state-view'
import { Button } from '@/components/ui/button'
import { recordPrivacyConsent } from '@/features/auth/api'
import { useAuth, useCurrentUser } from '@/features/auth/auth-context'

/**
 * Module 1.5 "Capture Data Privacy Consent".
 *
 * Shown once, on a patient's first sign-in, before any clinical screen is
 * reachable. `pat_consent_at` stays NULL until they accept, so this cannot be
 * skipped by navigating straight to a deep link.
 *
 * There is deliberately no "decline" button that silently continues: consent
 * to record health information is either given or the account is not used.
 * Signing out is the honest alternative and it is offered.
 */
export function ConsentGate({ children }: { children: ReactNode }) {
  const user = useCurrentUser()
  const { signOut, refresh } = useAuth()
  const [isSaving, setSaving] = useState(false)
  const [error, setError] = useState<unknown>(null)

  if (user.profile.kind !== 'patient') {
    return <>{children}</>
  }

  const patient = user.profile.patient
  if (patient.pat_consent_at) {
    return <>{children}</>
  }

  const accept = async () => {
    setSaving(true)
    setError(null)
    try {
      await recordPrivacyConsent(patient.pat_id)
      await refresh()
    } catch (caught) {
      setError(caught)
      setSaving(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col px-4 pt-8 pb-[max(2rem,env(safe-area-inset-bottom))] sm:px-5 sm:py-10">
      {/* `my-auto` rather than `items-center`: this is a long read, and a
          centred flex item taller than its container overflows past the top
          where no scrollbar reaches. On a phone this text is always taller
          than the viewport. */}
      <div className="my-auto w-full rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-surface p-5 sm:rounded-[var(--radius-xl)] sm:p-8">
        <span className="flex size-11 items-center justify-center rounded-full bg-accent-50">
          <ShieldCheck className="size-5 text-accent-700" aria-hidden="true" />
        </span>

        <h1 className="mt-5 text-headline-lg text-brand-800">
          Before you continue
        </h1>
        <p className="mt-2 text-body">
          RecoverEase stores health information about you so your care team can
          support your recovery. Please read this and confirm you agree.
        </p>

        <div className="mt-6 space-y-4 rounded-[var(--radius-md)] bg-surface-sunken p-4 text-sm leading-relaxed text-body sm:p-5">
          <div>
            <h2 className="font-semibold text-heading">What we record</h2>
            <p className="mt-1">
              Your contact details, treatment plans and goals, prescriptions
              and medication schedules, the doses you mark as taken, your daily
              recovery entries, your appointments, and any conversations you
              have with the guidance assistant.
            </p>
          </div>

          <div>
            <h2 className="font-semibold text-heading">Who can see it</h2>
            <p className="mt-1">
              You, and the doctor assigned to your care. No other patient and
              no other clinician can see your records. System administrators
              manage accounts and settings — they cannot read your health
              information.
            </p>
          </div>

          <div>
            <h2 className="font-semibold text-heading">Why we record it</h2>
            <p className="mt-1">
              So your care team can follow your recovery between appointments,
              and so you have one place that shows what your treatment asks of
              you.
            </p>
          </div>

          <div>
            <h2 className="font-semibold text-heading">
              What this system is not
            </h2>
            <p className="mt-1">
              RecoverEase does not diagnose conditions and does not give
              medical advice. If you are unwell or worried, contact your doctor
              or emergency services directly.
            </p>
          </div>
        </div>

        {error ? (
          <div className="mt-6">
            <ErrorState error={error} onRetry={() => void accept()} />
          </div>
        ) : null}

        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <Button
            size="lg"
            onClick={() => void accept()}
            isLoading={isSaving}
            loadingLabel="Saving your consent…"
          >
            I understand and agree
          </Button>
          <Button size="lg" variant="ghost" onClick={() => void signOut()}>
            Not now, sign me out
          </Button>
        </div>
      </div>
    </main>
  )
}
