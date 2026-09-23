import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'

import { FormError } from '@/components/feedback/form-error'
import { SavedNotice } from '@/components/feedback/state-view'

import { PageHeader } from '@/components/layout/page-header'
import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { Field, Input } from '@/components/ui/field'
import { PageSection } from '@/components/ui/section-heading'
import { useAuth, useCurrentUser } from '@/features/auth/auth-context'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { supabase } from '@/lib/supabase/client'
import { fullName } from '@/lib/utils'

/** Module 14.2 "View and Update Admin Profile". */
export function AdminProfilePage() {
  useDocumentTitle('My Profile')
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

      {/* The patient profile's structure: the form is the one card on the
          page, and the account facts beside it sit under a heading with
          space, not in a card of their own. */}
      <div className="grid gap-section lg:grid-cols-3 lg:gap-8">
        <PageSection title="Profile details" className="lg:col-span-2">
          <Card>
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

                {update.isError ? (
                  <FormError
                    error={update.error}
                    title="Your profile was not saved"
                  />
                ) : null}

                <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                  <Button
                    className="max-sm:w-full"
                    type="submit"
                    isLoading={update.isPending}
                    loadingLabel="Saving…"
                  >
                    Save changes
                  </Button>
                  <SavedNotice at={update.submittedAt}>
                    {savedMessage}
                  </SavedNotice>
                </div>
              </form>
            </CardBody>
          </Card>
        </PageSection>

        <PageSection title="Account">
          {/* The label is metadata at 14px; the value is read at the 16px
              body size. */}
          <dl className="space-y-3">
            <div>
              <dt className="text-sm text-muted">Name on record</dt>
              <dd className="font-medium text-heading">
                {fullName(admin.admin_first_name, admin.admin_last_name)}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-muted">Email</dt>
              <dd className="break-words font-medium text-heading">
                {user.email}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-muted">Role</dt>
              <dd className="font-medium text-heading">Administrator</dd>
            </div>
          </dl>

          <p className="mt-5 text-sm text-muted">
            Administrators manage accounts, announcements and system
            configuration. This role has no access to patient health records.
          </p>
        </PageSection>
      </div>
    </>
  )
}
