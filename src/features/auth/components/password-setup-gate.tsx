import { zodResolver } from '@hookform/resolvers/zod'
import { Eye, EyeOff, KeyRound } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useForm } from 'react-hook-form'
import { useNavigate } from 'react-router-dom'

import { roleHome } from '@/app/routes/guards'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/field'
import { completePasswordSetup } from '@/features/auth/api'
import { useAuth, useCurrentUser } from '@/features/auth/auth-context'
import { AuthFormAlert } from '@/features/auth/components/form-alert'
import { setFlash } from '@/features/auth/flash'
import { newPasswordSchema, type NewPasswordValues } from '@/features/auth/schemas'

/**
 * The forced password change for an account created with a temporary
 * credential.
 *
 * It wraps the application the same way `ConsentGate` does, rather than
 * redirecting to a route of its own. A redirect can be walked around — with
 * the back button, by typing a different path, or by reloading on a deep
 * link — because the destination still exists and still renders. Here there
 * is nothing to walk around to: while `mustChangePassword` is true this is
 * what every protected route renders, so a deep link to `/doctor/patients`
 * and a refresh both land on this screen.
 *
 * The requirement is cleared server-side and re-read through `refresh()`, so
 * it survives a reload and cannot be dismissed from the browser.
 */
export function PasswordSetupGate({ children }: { children: ReactNode }) {
  const user = useCurrentUser()
  const { signOut, refresh } = useAuth()
  const navigate = useNavigate()
  const [formError, setFormError] = useState<string | null>(null)
  // Replaces the form while the session is being rebuilt, so the last thing
  // seen is progress rather than a form that has already done its job.
  const [handingOff, setHandingOff] = useState<string | null>(null)
  const [showPassword, setShowPassword] = useState(false)

  const form = useForm<NewPasswordValues>({
    resolver: zodResolver(newPasswordSchema),
    defaultValues: { password: '', confirmPassword: '' },
  })

  if (!user.mustChangePassword) {
    return <>{children}</>
  }

  const submit = form.handleSubmit(async (values) => {
    setFormError(null)
    try {
      const { signedIn } = await completePasswordSetup(values.password)

      if (!signedIn) {
        // The password did change. Only the session could not be rebuilt, so
        // say that plainly and send them somewhere their new password works,
        // rather than leaving them on a form that would now reject it.
        setHandingOff('Your password is saved. Taking you to sign in…')
        setFlash(
          'Your password is saved. Sign in with your new password to continue.',
        )
        navigate('/sign-in', { replace: true })
        return
      }

      // Re-reads the session so the cleared requirement is what the rest of
      // the application sees. Without this the gate would still be holding a
      // stale `true` and would render over the app it just unlocked.
      setHandingOff('Your password is saved. Signing you in…')
      await refresh()
      navigate(roleHome(user.role), { replace: true })
    } catch (caught) {
      setHandingOff(null)
      setFormError(
        caught instanceof Error
          ? caught.message
          : 'Your password could not be changed. Please try again.',
      )
    }
  })

  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col px-4 pt-8 pb-[max(2rem,env(safe-area-inset-bottom))] sm:px-5 sm:py-10">
      <div className="my-auto w-full rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-surface p-5 sm:rounded-[var(--radius-xl)] sm:p-8">
        <span className="flex size-11 items-center justify-center rounded-full bg-brand-50">
          <KeyRound className="size-5 text-brand-700" aria-hidden="true" />
        </span>

        <h1 className="mt-5 text-headline-lg text-brand-800">
          Choose your password
        </h1>
        <p className="mt-2 text-body">
          You signed in with the temporary password you were given. Choose
          your own now — the temporary one stops working once you do.
        </p>

        {handingOff ? (
          // The password is already saved at this point. Nothing here can be
          // retried or cancelled, so the form is gone rather than merely
          // disabled, and the only thing on screen is what is happening.
          <p
            className="mt-6 text-body text-heading"
            role="status"
            aria-live="polite"
          >
            {handingOff}
          </p>
        ) : (
        <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
          {formError ? <AuthFormAlert message={formError} /> : null}

          <Field
            label="New password"
            required
            error={form.formState.errors.password?.message}
            description="At least 12 characters. A short phrase is easier to remember than a jumble."
          >
            <div className="relative">
              <Input
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                // Never autocapitalised or autocorrected. Once "show password" makes
                // this a text field a phone will silently alter what was typed, and
                // the failure that follows reads as a wrong password.
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoFocus
                className="pr-12"
                {...form.register('password')}
              />
              {/* Typing a password you cannot see, twice, is the step people
                  give up on. A real button so it is reachable by keyboard and
                  announced with its state. */}
              <button
                type="button"
                onClick={() => setShowPassword((current) => !current)}
                aria-pressed={showPassword}
                className="absolute inset-y-0 right-0 flex w-12 items-center justify-center rounded-r-[var(--radius-md)] text-muted transition-colors hover:text-heading"
              >
                {showPassword ? (
                  <EyeOff className="size-5" aria-hidden="true" />
                ) : (
                  <Eye className="size-5" aria-hidden="true" />
                )}
                <span className="sr-only">
                  {showPassword ? 'Hide password' : 'Show password'}
                </span>
              </button>
            </div>
          </Field>

          <Field
            label="Confirm new password"
            required
            error={form.formState.errors.confirmPassword?.message}
            description="Type the same password again so a typo cannot lock you out."
          >
            <Input
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              // Never autocapitalised or autocorrected. Once "show password" makes
              // this a text field a phone will silently alter what was typed, and
              // the failure that follows reads as a wrong password.
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              {...form.register('confirmPassword')}
            />
          </Field>

          {/* `isSubmitting` disables the button, so a second click cannot
              start a second change while the first is in flight. */}
          <Button
            type="submit"
            size="lg"
            block
            isLoading={form.formState.isSubmitting}
            loadingLabel="Saving your password…"
          >
            Save and continue
          </Button>
        </form>
        )}

        {handingOff ? null : (
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
        )}
      </div>
    </main>
  )
}
