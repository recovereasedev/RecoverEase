import { zodResolver } from '@hookform/resolvers/zod'
import { AlertCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useNavigate } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/field'
import { updatePassword } from '@/features/auth/api'
import { AuthLayout } from '@/features/auth/components/auth-layout'
import {
  newPasswordSchema,
  type NewPasswordValues,
} from '@/features/auth/schemas'
import { supabase } from '@/lib/supabase/client'

/**
 * Reached from the emailed reset link.
 *
 * Supabase exchanges the link's token for a recovery session before this
 * component renders (`detectSessionInUrl`). If no session is present the link
 * has expired or was already used, and the page says so rather than
 * presenting a form that cannot possibly work.
 */
export function ResetPasswordPage() {
  const navigate = useNavigate()
  const [hasSession, setHasSession] = useState<boolean | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    let isCurrent = true

    void supabase.auth.getSession().then(({ data }) => {
      if (isCurrent) setHasSession(Boolean(data.session))
    })

    return () => {
      isCurrent = false
    }
  }, [])

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<NewPasswordValues>({
    resolver: zodResolver(newPasswordSchema),
    defaultValues: { password: '', confirmPassword: '' },
  })

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null)
    try {
      await updatePassword(values.password)
      // The recovery session is not a normal sign-in. Ending it means the new
      // password is actually used, rather than the user continuing on a
      // session granted by an email link.
      await supabase.auth.signOut()
      void navigate('/sign-in', { replace: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      setFormError(
        message.toLowerCase().includes('same as the old')
          ? 'Choose a password you have not used here before.'
          : 'We could not update your password. The reset link may have expired — request a new one.',
      )
    }
  })

  if (hasSession === false) {
    return (
      <AuthLayout
        title="This link has expired"
        description="Password reset links can only be used once, and expire after an hour."
      >
        <Button size="lg" block onClick={() => void navigate('/forgot-password')}>
          Request a new link
        </Button>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout
      title="Choose a new password"
      description="Pick something you have not used elsewhere."
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

        <Field
          label="New password"
          description="At least 12 characters. A short phrase is easier to remember and harder to guess than a scrambled word."
          error={errors.password?.message}
          required
        >
          <Input
            type="password"
            autoComplete="new-password"
            autoFocus
            {...register('password')}
          />
        </Field>

        <Field
          label="Confirm new password"
          error={errors.confirmPassword?.message}
          required
        >
          <Input
            type="password"
            autoComplete="new-password"
            {...register('confirmPassword')}
          />
        </Field>

        <Button
          type="submit"
          size="lg"
          block
          isLoading={isSubmitting}
          loadingLabel="Updating your password…"
          disabled={hasSession === null}
        >
          Update password
        </Button>
      </form>
    </AuthLayout>
  )
}
