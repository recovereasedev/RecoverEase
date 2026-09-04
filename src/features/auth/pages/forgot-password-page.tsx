import { zodResolver } from '@hookform/resolvers/zod'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Link } from 'react-router-dom'

import { Button, buttonVariants } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/field'
import { Notice } from '@/components/ui/notice'
import { requestPasswordReset } from '@/features/auth/api'
import { AuthLayout } from '@/features/auth/components/auth-layout'
import { AuthFormAlert } from '@/features/auth/components/form-alert'
import {
  forgotPasswordSchema,
  type ForgotPasswordValues,
} from '@/features/auth/schemas'
import { useDocumentTitle } from '@/hooks/use-document-title'

export function ForgotPasswordPage() {
  useDocumentTitle('Reset Password')
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
      // The limit counts every message the clinic's mail service sends, not
      // just this person's — a single request can meet it because an account
      // was invited minutes earlier. Saying "too many requests" to someone who
      // pressed the button once reads as an accusation and points them at the
      // wrong remedy, so name the real one.
      setFormError(
        message.includes('rate limit') || message.includes('too many')
          ? 'Reset emails are temporarily unavailable — the clinic mail service has reached its limit for now. Wait a few minutes and try again, or ask your administrator to reset your password for you.'
          : 'We could not send the reset email. Please try again shortly, or ask your administrator to reset your password for you.',
      )
    }
  })

  if (isSent) {
    return (
      <AuthLayout title="Check your email">
        {/* The whole screen changed, so the heading already announces the
            outcome; the notice does not need to announce it a second time. */}
        <div className="space-y-6">
          <Notice tone="success" title="Reset link sent">
            If an account exists for that address, we have sent it a link to
            set a new password. The link expires in one hour.
          </Notice>

          <p className="text-sm leading-relaxed text-muted">
            Nothing arrived? Check your spam folder, and confirm you used the
            address your care team registered.
          </p>

          <Link
            to="/sign-in"
            className={buttonVariants({
              variant: 'secondary',
              size: 'lg',
              block: true,
            })}
          >
            Back to sign in
          </Link>
        </div>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout
      title="Reset your password"
      description="Enter your email address and we will send you a link to set a new one."
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

        <div className="space-y-3 pt-1">
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
            className={buttonVariants({
              variant: 'ghost',
              size: 'lg',
              block: true,
            })}
          >
            Back to sign in
          </Link>
        </div>
      </form>
    </AuthLayout>
  )
}
