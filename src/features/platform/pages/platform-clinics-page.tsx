import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2, Plus, UserPlus } from 'lucide-react'
import { useRef, useState, type MouseEvent } from 'react'
import { flushSync } from 'react-dom'

import { FormError } from '@/components/feedback/form-error'
import { EmptyState, StateView } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import { Field, Input } from '@/components/ui/field'
import { AddClinicAdminDialog } from '@/features/platform/components/add-clinic-admin-dialog'
import { GuidanceAssistantSwitch } from '@/features/platform/components/guidance-assistant-switch'
import {
  createClinic,
  fetchClinics,
  setClinicStatus,
  type PlatformClinic,
} from '@/features/platform/api'
import { parseTimezone } from '@/features/system-settings/api'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { useFocusRecovery } from '@/hooks/use-focus-recovery'
import { formatDate } from '@/lib/format'
import { focusFirstInvalid } from '@/lib/form-focus'
import { queryKeys } from '@/lib/query-keys'

function adminCount(count: number): string {
  if (count === 0) return 'No Clinic Admin yet'
  return count === 1 ? '1 Clinic Admin' : `${count} Clinic Admins`
}

/**
 * The platform's clinics: their status, time zone and how many Clinic Admins
 * each has. Nothing about anyone's patients - the database function that
 * lists them returns no such column.
 *
 * No clinic is ever deleted. Deactivating one keeps every person and record
 * it has and only stops new Clinic Admins being added, so it is reversible,
 * and it still asks first because every clinic's staff notice it.
 */
export function PlatformClinicsPage() {
  useDocumentTitle('Clinics')
  const queryClient = useQueryClient()
  const focusRecovery = useFocusRecovery()

  const clinicsQuery = useQuery({
    queryKey: queryKeys.platform.clinics(),
    queryFn: fetchClinics,
  })

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.platform.clinics() })

  // --- New clinic ------------------------------------------------------------
  const [isCreating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [timezone, setTimezone] = useState('')
  const [problems, setProblems] = useState<{
    name?: string | undefined
    timezone?: string | undefined
  }>({})

  const create = useMutation({
    mutationFn: (input: { name: string; timezone: string }) =>
      createClinic(input),
    onSuccess: () => {
      setCreating(false)
      setName('')
      setTimezone('')
      void invalidate()
    },
  })

  // One press, one clinic: the composer's button is not busy until React
  // draws it, and a second press in the same task would send again.
  const creating = useRef(false)

  const openComposer = () => {
    setProblems({})
    create.reset()
    setCreating(true)
  }

  const submitClinic = (event: MouseEvent<HTMLButtonElement>) => {
    if (creating.current) return
    const wanted = name.trim()
    const zone = parseTimezone(timezone)
    const next: typeof problems = {}
    if (!wanted) next.name = "Enter the clinic's name."
    else if (wanted.length > 120) {
      next.name = 'A clinic name can be at most 120 characters.'
    }
    if (!zone.ok) next.timezone = zone.message
    flushSync(() => setProblems(next))
    if (next.name || !zone.ok) {
      focusFirstInvalid(event.currentTarget.closest('dialog'))
      return
    }
    creating.current = true
    create.mutate(
      { name: wanted, timezone: zone.value },
      {
        onSettled: () => {
          creating.current = false
        },
      },
    )
  }

  // --- Status ----------------------------------------------------------------
  const [pendingDeactivate, setPendingDeactivate] =
    useState<PlatformClinic | null>(null)

  const changeStatus = useMutation({
    mutationFn: (input: { clinicId: string; status: 'active' | 'inactive' }) =>
      setClinicStatus(input.clinicId, input.status),
    onSuccess: () => {
      setPendingDeactivate(null)
      void invalidate()
    },
  })

  // --- Clinic Admins -----------------------------------------------------------
  const [adminFor, setAdminFor] = useState<PlatformClinic | null>(null)

  return (
    <>
      <div ref={focusRecovery}>
        <PageHeader
          title="Clinics"
          description="Every clinic on RecoverEase, its status and who administers it."
          actions={
            <Button className="max-sm:w-full" onClick={openComposer}>
              <Plus aria-hidden="true" />
              New clinic
            </Button>
          }
        />

        {/* The platform's half of the adviser's AI Chatbot On/Off. */}
        <div className="mb-6">
          <GuidanceAssistantSwitch />
        </div>

        <StateView
          isPending={clinicsQuery.isPending}
          error={clinicsQuery.error}
          data={clinicsQuery.data}
          onRetry={() => void clinicsQuery.refetch()}
          empty={
            <Card>
              <EmptyState
                icon={Building2}
                title="No clinics yet"
                description="Create the first clinic to start adding its Clinic Admin."
              />
            </Card>
          }
        >
          {(clinics) => (
            <Card className="overflow-hidden">
              <ul className="divide-y divide-[var(--color-border)]">
                {clinics.map((clinic) => {
                  const isActive = clinic.clinic_status === 'active'
                  const isChanging =
                    changeStatus.isPending &&
                    changeStatus.variables?.clinicId === clinic.clinic_id

                  return (
                    <li key={clinic.clinic_id}>
                      <article className="px-4 py-5 sm:px-5">
                        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
                          <div className="min-w-0">
                            <h2 className="text-balance text-base font-semibold text-heading">
                              {clinic.clinic_name}
                            </h2>
                            <p className="mt-0.5 text-sm text-muted">
                              {clinic.clinic_timezone} ·{' '}
                              {adminCount(clinic.clinic_admin_count)} · Added{' '}
                              {formatDate(clinic.clinic_created_at)}
                            </p>
                          </div>
                          <Badge
                            tone={isActive ? 'success' : 'neutral'}
                            className="ms-auto shrink-0"
                          >
                            {isActive ? 'Active' : 'Inactive'}
                          </Badge>
                        </div>

                        <div className="mt-4 flex flex-wrap gap-2">
                          {isActive ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              // Named with the clinic, so a list of these is
                              // not a list of identical buttons. The visible
                              // words come first (WCAG 2.5.3).
                              aria-label={`Add Clinic Admin to ${clinic.clinic_name}`}
                              onClick={() => setAdminFor(clinic)}
                            >
                              <UserPlus aria-hidden="true" />
                              Add Clinic Admin
                            </Button>
                          ) : null}

                          {isActive ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={`Deactivate ${clinic.clinic_name}`}
                              onClick={() => {
                                changeStatus.reset()
                                setPendingDeactivate(clinic)
                              }}
                            >
                              Deactivate
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="secondary"
                              isLoading={isChanging}
                              loadingLabel="Reactivating…"
                              aria-label={`Reactivate ${clinic.clinic_name}`}
                              onClick={() =>
                                changeStatus.mutate({
                                  clinicId: clinic.clinic_id,
                                  status: 'active',
                                })
                              }
                            >
                              Reactivate
                            </Button>
                          )}
                        </div>

                        {changeStatus.isError &&
                        changeStatus.variables?.clinicId === clinic.clinic_id &&
                        pendingDeactivate === null ? (
                          <div className="mt-3">
                            <FormError
                              error={changeStatus.error}
                              title="The clinic's status did not change"
                            />
                          </div>
                        ) : null}
                      </article>
                    </li>
                  )
                })}
              </ul>
            </Card>
          )}
        </StateView>
      </div>

      {/* --- New clinic ------------------------------------------------------- */}
      <Dialog
        isOpen={isCreating}
        onClose={() => setCreating(false)}
        title="New clinic"
        description="It starts active, with RecoverEase's default settings and none of another clinic's."
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button
              onClick={submitClinic}
              isLoading={create.isPending}
              loadingLabel="Creating the clinic…"
            >
              Create clinic
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Clinic name" required error={problems.name}>
            <Input
              value={name}
              autoComplete="off"
              onChange={(event) => {
                setName(event.target.value)
                setProblems((current) => ({ ...current, name: undefined }))
              }}
            />
          </Field>

          <Field
            label="Time zone"
            required
            error={problems.timezone}
            description="The zone the clinic's medication times, reminders and dates are in, such as Asia/Manila."
          >
            <Input
              value={timezone}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              onChange={(event) => {
                setTimezone(event.target.value)
                setProblems((current) => ({ ...current, timezone: undefined }))
              }}
            />
          </Field>

          {create.isError ? (
            <FormError error={create.error} title="The clinic was not created" />
          ) : null}
        </div>
      </Dialog>

      {/* --- Deactivate ------------------------------------------------------- */}
      <Dialog
        isOpen={pendingDeactivate !== null}
        onClose={() => setPendingDeactivate(null)}
        title={
          pendingDeactivate
            ? `Deactivate ${pendingDeactivate.clinic_name}?`
            : 'Deactivate this clinic?'
        }
        description="You can reactivate it at any time."
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDeactivate(null)}>
              Keep it active
            </Button>
            <Button
              variant="danger"
              isLoading={changeStatus.isPending}
              loadingLabel="Deactivating…"
              onClick={() =>
                pendingDeactivate &&
                changeStatus.mutate({
                  clinicId: pendingDeactivate.clinic_id,
                  status: 'inactive',
                })
              }
            >
              Deactivate
            </Button>
          </>
        }
      >
        <p className="text-body">
          Its doctors, patients and records stay exactly as they are. While it
          is inactive it cannot take a new Clinic Admin.
        </p>
        {changeStatus.isError ? (
          <div className="mt-4">
            <FormError
              error={changeStatus.error}
              title="The clinic was not deactivated"
            />
          </div>
        ) : null}
      </Dialog>

      <AddClinicAdminDialog clinic={adminFor} onClose={() => setAdminFor(null)} />
    </>
  )
}
