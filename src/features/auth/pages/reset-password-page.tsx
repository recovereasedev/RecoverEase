import { zodResolver } from '@hookform/resolvers/zod'
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useNavigate } from 'react-router-dom'

import { LoadingState } from '@/components/feedback/state-view'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/field'
import { Notice } from '@/components/ui/notice'
import { updatePassword } from '@/features/auth/api'
import { AuthLayout } from '@/features/auth/components/auth-layout'
import { AuthFormAlert } from '@/features/auth/components/form-alert'
import {
  newPasswordSchema,
  type NewPasswordValues,
} from '@/features/auth/schemas'
import { useDocumentTitle } from '@/hooks/use-document-title'
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
  useDocumentTitle('New Password')
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

  // Checking the recovery session. Showing the form here and disabling its
  // button looks like a broken page; saying what is happening does not.
  if (hasSession === null) {
    return (
      <AuthLayout title="Choose a new password">
        <LoadingState label="Checking your reset link…" />
      </AuthLayout>
    )
  }

  if (!hasSession) {
    return (
      <AuthLayout
        title="This link has expired"
        description="Password reset links can only be used once, and expire after an hour."
      >
        <div className="space-y-6">
          <Notice tone="warning" title="Nothing has changed">
            Your current password still works. Request a new link and the next
            one will be valid for an hour.
          </Notice>

          <Button
            size="lg"
            block
            onClick={() => void navigate('/forgot-password')}
          >
            Request a new link
          </Button>
        </div>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout
      title="Choose a new password"
      description="Pick something you have not used elsewhere."
    >
      <form onSubmit={onSubmit} noValidate className="space-y-5">
        {formError ? <AuthFormAlert message={formError} /> : null}

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
          className="mt-6"
          isLoading={isSubmitting}
          loadingLabel="Updating your password…"
        >
          Update password
        </Button>
      </form>
    </AuthLayout>
  )
}
