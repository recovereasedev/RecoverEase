import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'

import { ErrorState } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Field, Input } from '@/components/ui/field'
import { useAuth, useCurrentUser } from '@/features/auth/auth-context'
import { supabase } from '@/lib/supabase/client'
import { fullName } from '@/lib/utils'

/** Module 14.2 "View and Update Admin Profile". */
export function AdminProfilePage() {
  const user = useCurrentUser()
  const { refresh } = useAuth()
  const admin = user.profile.kind === 'admin' ? user.profile.admin : null

  const [firstName, setFirstName] = useState(admin?.admin_first_name ?? '')
  const [lastName, setLastName] = useState(admin?.admin_last_name ?? '')
  const [savedMessage, setSavedMessage] = useState<string | null>(null)

  const update = useMutation({
    mutationFn: async () => {
      if (!admin) return
      const { error } = await supabase
        .from('admin')
        .update({
          admin_first_name: firstName.trim(),
          admin_last_name: lastName.trim(),
        })
        .eq('admin_id', admin.admin_id)

      if (error) throw error
    },
    onSuccess: () => {
      setSavedMessage('Your profile has been updated.')
      void refresh()
    },
  })

  if (!admin) return null

  return (
    <>
      <PageHeader title="My profile" description="Your administrator account." />

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Profile details" />
          <CardBody>
            <form
              onSubmit={(event) => {
                event.preventDefault()
                setSavedMessage(null)
                update.mutate()
              }}
              className="space-y-5"
            >
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="First name" required>
                  <Input
                    value={firstName}
                    onChange={(event) => setFirstName(event.target.value)}
                    autoComplete="given-name"
                  />
                </Field>
                <Field label="Last name" required>
                  <Input
                    value={lastName}
                    onChange={(event) => setLastName(event.target.value)}
                    autoComplete="family-name"
                  />
                </Field>
              </div>

              {update.isError ? <ErrorState error={update.error} /> : null}

              <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                <Button
                  className="max-sm:w-full"
                  type="submit"
                  isLoading={update.isPending}
                  loadingLabel="Saving…"
                >
                  Save changes
                </Button>
                {savedMessage ? (
                  <p
                    role="status"
                    className="text-sm font-medium text-success-700"
                  >
                    {savedMessage}
                  </p>
                ) : null}
              </div>
            </form>
          </CardBody>
        </Card>

        <Card className="h-fit">
          <CardHeader title="Account" as="h3" />
          <CardBody>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-muted">Name on record</dt>
                <dd className="font-medium text-heading">
                  {fullName(admin.admin_first_name, admin.admin_last_name)}
                </dd>
              </div>
              <div>
                <dt className="text-muted">Email</dt>
                <dd className="break-words font-medium text-heading">
                  {user.email}
                </dd>
              </div>
              <div>
                <dt className="text-muted">Role</dt>
                <dd className="font-medium text-heading">Administrator</dd>
              </div>
            </dl>

            <p className="mt-4 border-t border-[var(--color-border)] pt-4 text-sm text-muted">
              Administrators manage accounts, announcements and system
              configuration. This role has no access to patient health records.
            </p>
          </CardBody>
        </Card>
      </div>
    </>
  )
}
