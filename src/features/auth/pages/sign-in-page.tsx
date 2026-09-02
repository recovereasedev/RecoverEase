import { zodResolver } from '@hookform/resolvers/zod'
import { AlertCircle, Eye, EyeOff } from 'lucide-react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Link } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/field'
import { signInWithPassword } from '@/features/auth/api'
import { AuthLayout } from '@/features/auth/components/auth-layout'
import { signInSchema, type SignInValues } from '@/features/auth/schemas'

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
        <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-surface p-4">
          <h2 className="text-sm font-semibold text-heading">
            Do not have an account?
          </h2>
          <p className="mt-1 text-sm text-muted">
            RecoverEase accounts are created by your care team, so there is no
            public sign-up. Ask your doctor or clinic administrator to set one
            up for you.
          </p>
        </div>
      }
    >
      <form onSubmit={onSubmit} noValidate className="space-y-5">
        {formError ? (
          // role="alert" announces the failure immediately. Placing it above
          // the fields means it is read before the inputs are revisited.
          <div
            role="alert"
            className="flex items-start gap-2.5 rounded-[var(--radius-md)] border border-danger-200 bg-danger-50 p-3 text-sm text-danger-800"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <p>{formError}</p>
          </div>
        ) : null}

        <Field label="Email address" error={errors.email?.message} required>
          <Input
            type="email"
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
              // keyboard and announced with its current state.
              aria-pressed={showPassword}
              className="absolute inset-y-0 right-0 flex w-12 items-center justify-center rounded-r-[var(--radius-md)] text-muted hover:text-heading"
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

        <div className="flex justify-end">
          <Link
            to="/forgot-password"
            className="rounded-[var(--radius-sm)] text-sm font-medium text-brand-700 hover:underline"
          >
            Forgot your password?
          </Link>
        </div>

        <Button
          type="submit"
          size="lg"
          block
          isLoading={isSubmitting}
          loadingLabel="Signing you in…"
        >
          Sign in
        </Button>
      </form>
    </AuthLayout>
  )
}
