import { zodResolver } from '@hookform/resolvers/zod'
import { Eye, EyeOff } from 'lucide-react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Link } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/field'
import { signInWithPassword } from '@/features/auth/api'
import { AuthLayout } from '@/features/auth/components/auth-layout'
import { AuthFormAlert } from '@/features/auth/components/form-alert'
import { signInSchema, type SignInValues } from '@/features/auth/schemas'
import { useDocumentTitle } from '@/hooks/use-document-title'

/**
 * Turns Supabase auth errors into something a person can act on, without
 * revealing whether an email address exists.
 *
 * "Invalid login credentials" covers both a wrong password and an unknown
 * account, and keeping that ambiguity is deliberate: a message that
 * distinguishes them lets an attacker enumerate which patients and clinicians
 * are registered.
 */
function describeSignInError(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : ''

  if (message.includes('invalid login credentials')) {
    return 'That email address and password do not match an account. Check both and try again.'
  }
  if (message.includes('email not confirmed')) {
    return 'This account has not been confirmed yet. Check your email for the confirmation link.'
  }
  if (message.includes('too many requests') || message.includes('rate limit')) {
    return 'Too many attempts. Wait a minute before trying again.'
  }
  if (message.includes('failed to fetch') || message.includes('network')) {
    return 'We could not reach RecoverEase. Check your internet connection and try again.'
  }

  return 'We could not sign you in. Please try again, or contact your care team if the problem continues.'
}

export function SignInPage() {
  useDocumentTitle('Sign In')
  const [formError, setFormError] = useState<string | null>(null)
  const [showPassword, setShowPassword] = useState(false)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignInValues>({
    resolver: zodResolver(signInSchema),
    defaultValues: { email: '', password: '' },
  })

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null)
    try {
      await signInWithPassword(values.email, values.password)
      // No navigation here. AuthProvider observes the session change and the
      // route guard redirects, so there is exactly one place that decides
      // where a signed-in user lands.
    } catch (error) {
      setFormError(describeSignInError(error))
    }
  })

  return (
    <AuthLayout
      title="Sign in to RecoverEase"
      description="Use the email address your care team registered for you."
      footer={
        // Deliberately not a card. Nesting a bordered panel inside the form
        // card at `sm` and above would be two boxes deep for one sentence,
        // and on a phone it is bulk between the button and the bottom of the
        // screen. The fact still matters, so it stays — quietly.
        <p className="text-center text-sm leading-relaxed text-muted">
          <span className="font-semibold text-heading">
            Do not have an account?
          </span>{' '}
          RecoverEase accounts are created by your care team, so there is no
          public sign-up. Ask your doctor or clinic administrator to set one up
          for you.
        </p>
      }
    >
      <form onSubmit={onSubmit} noValidate className="space-y-5">
        {formError ? <AuthFormAlert message={formError} /> : null}

        <Field label="Email address" error={errors.email?.message} required>
          <Input
            type="email"
            inputMode="email"
            autoComplete="username"
            autoFocus
            placeholder="name@clinic.com"
            {...register('email')}
          />
        </Field>

        <Field label="Password" error={errors.password?.message} required>
          <div className="relative">
            <Input
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              className="pr-12"
              {...register('password')}
            />
            <button
              type="button"
              onClick={() => setShowPassword((current) => !current)}
              // A real button rather than an icon, so it is reachable by
              // keyboard and announced with its current state. 44x44 at the
              // input's own height, so it is tappable without magnifying.
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

        <Button
          type="submit"
          size="lg"
          block
          className="mt-6"
          isLoading={isSubmitting}
          loadingLabel="Signing you in…"
        >
          Sign in
        </Button>

        {/* Below the button, not beside the password label.
            On the label row it saves a row of vertical space, but it also
            lands between the email and password fields in the tab order, so a
            keyboard user filling the form in tabs onto a link that navigates
            away mid-entry. Putting it after the submit button keeps the
            sequence email, password, reveal, Sign in - the order the form is
            actually completed in - and leaves the primary action with nothing
            competing above it. */}
        <div className="flex justify-center">
          <Link
            to="/forgot-password"
            className="inline-flex min-h-11 items-center rounded-[var(--radius-sm)] px-2 text-sm font-medium text-brand-700 hover:underline"
          >
            Forgot your password?
          </Link>
        </div>
      </form>
    </AuthLayout>
  )
}
