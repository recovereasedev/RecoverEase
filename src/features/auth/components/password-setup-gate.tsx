import { zodResolver } from '@hookform/resolvers/zod'
import { KeyRound } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useForm } from 'react-hook-form'

import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/field'
import { completePasswordSetup } from '@/features/auth/api'
import { useAuth, useCurrentUser } from '@/features/auth/auth-context'
import { AuthFormAlert } from '@/features/auth/components/form-alert'
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
  const [formError, setFormError] = useState<string | null>(null)

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
      await completePasswordSetup(values.password)
      // Re-reads the session so the cleared requirement is what the rest of
      // the application sees. Without this the gate would still be holding a
      // stale `true` and would render over the app it just unlocked.
      await refresh()
    } catch (caught) {
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

        <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
          {formError ? <AuthFormAlert message={formError} /> : null}

          <Field
            label="New password"
            required
            error={form.formState.errors.password?.message}
            description="At least 12 characters. A short phrase is easier to remember than a jumble."
          >
            <Input
              type="password"
              autoComplete="new-password"
              autoFocus
              {...form.register('password')}
            />
          </Field>

          <Field
            label="Confirm new password"
            required
            error={form.formState.errors.confirmPassword?.message}
          >
            <Input
              type="password"
              autoComplete="new-password"
              {...form.register('confirmPassword')}
            />
          </Field>

          {/* `isSubmitting` disables the button, so a second click cannot
              start a second change while the first is in flight. */}
          <Button
            type="submit"
            block
            isLoading={form.formState.isSubmitting}
            loadingLabel="Saving your password…"
          >
            Save and continue
          </Button>
        </form>

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
      </div>
    </main>
  )
}
