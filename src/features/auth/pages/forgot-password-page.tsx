import { zodResolver } from '@hookform/resolvers/zod'
import { AlertCircle, MailCheck } from 'lucide-react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Link } from 'react-router-dom'

import { Button, buttonVariants } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/field'
import { requestPasswordReset } from '@/features/auth/api'
import { AuthLayout } from '@/features/auth/components/auth-layout'
import {
  forgotPasswordSchema,
  type ForgotPasswordValues,
} from '@/features/auth/schemas'

export function ForgotPasswordPage() {
  const [isSent, setSent] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ForgotPasswordValues>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: '' },
  })

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null)
    try {
      await requestPasswordReset(values.email)
      setSent(true)
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : ''
      setFormError(
        message.includes('rate limit') || message.includes('too many')
          ? 'Too many reset requests. Please wait a few minutes and try again.'
          : 'We could not send the reset email. Please try again shortly.',
      )
    }
  })

  if (isSent) {
    return (
      <AuthLayout title="Check your email">
        <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-surface p-5">
          <span className="mb-3 flex size-11 items-center justify-center rounded-full bg-success-50">
            <MailCheck className="size-5 text-success-700" aria-hidden="true" />
          </span>
          <p className="text-body">
            If an account exists for that address, we have sent it a link to
            set a new password. The link expires in one hour.
          </p>
          <p className="mt-3 text-sm text-muted">
            Nothing arrived? Check your spam folder, and confirm you used the
            address your care team registered.
          </p>
        </div>

        <Link
          to="/sign-in"
          className={buttonVariants({ variant: 'secondary', block: true })}
        >
          Back to sign in
        </Link>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout
      title="Reset your password"
      description="Enter your email address and we will send you a link to set a new one."
    >
      <form onSubmit={onSubmit} noValidate className="space-y-5">
        {formError ? (
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

        <Button
          type="submit"
          size="lg"
          block
          isLoading={isSubmitting}
          loadingLabel="Sending reset link…"
        >
          Send reset link
        </Button>

        <Link
          to="/sign-in"
          className={buttonVariants({ variant: 'ghost', block: true })}
        >
          Back to sign in
        </Link>
      </form>
    </AuthLayout>
  )
}
