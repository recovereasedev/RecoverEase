import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { ErrorState, LoadingState } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { useCurrentUser } from '@/features/auth/auth-context'
import { useQueryKeys } from '@/features/auth/use-query-keys'
import {
  fetchClinicSettings,
  fetchSystemSettings,
  saveClinicTimezone,
  saveSystemSetting,
  SETTING_DEFINITIONS,
  TIMEZONE_DEFINITION,
} from '@/features/system-settings/api'
import { SettingForm } from '@/features/system-settings/components/setting-form'
import { useDocumentTitle } from '@/hooks/use-document-title'

/**
 * Modules 14.1 "Configure System Settings" and 8.7 "Configure Chatbot System
 * Prompt / Response Guidelines".
 *
 * Only the settings the application actually reads are offered, each with an
 * explanation of what changing it does. A free-form key/value editor would
 * let an administrator create settings nothing consumes, and mistype the ones
 * that matter.
 *
 * Every one is the administrator's own clinic's (migration 31): the time zone
 * belongs to the clinic itself, the others are stored settings of the clinic.
 */
export function SystemSettingsPage() {
  const queryKeys = useQueryKeys()
  useDocumentTitle('System Settings')
  const user = useCurrentUser()
  const adminId = user.profile.kind === 'admin' ? user.profile.admin.admin_id : ''
  const queryClient = useQueryClient()
  const [savedKey, setSavedKey] = useState<string | null>(null)

  const settingsQuery = useQuery({
    queryKey: queryKeys.admin.settings(),
    queryFn: fetchSystemSettings,
  })

  const clinicQuery = useQuery({
    queryKey: queryKeys.admin.clinic(),
    queryFn: fetchClinicSettings,
  })

  const save = useMutation({
    mutationFn: (input: { key: string; value: string }) =>
      input.key === TIMEZONE_DEFINITION.key
        ? saveClinicTimezone(input.value)
        : saveSystemSetting({
            adminId,
            clinicId: clinicQuery.data?.clinic_id ?? '',
            ...input,
          }),
    onSuccess: (_result, variables) => {
      setSavedKey(variables.key)
      void queryClient.invalidateQueries({
        queryKey: queryKeys.admin.settings(),
      })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.admin.clinic(),
      })
    },
  })

  if (settingsQuery.isPending || clinicQuery.isPending) {
    return (
      <>
        <PageHeader title="System settings" />
        <LoadingState label="Loading settings…" />
      </>
    )
  }

  if (settingsQuery.isError || clinicQuery.isError) {
    return (
      <>
        <PageHeader title="System settings" />
        <ErrorState
          error={settingsQuery.error ?? clinicQuery.error}
          onRetry={() => {
            void settingsQuery.refetch()
            void clinicQuery.refetch()
          }}
        />
      </>
    )
  }

  const stored = settingsQuery.data ?? []
  const clinic = clinicQuery.data

  const forms = [
    {
      definition: TIMEZONE_DEFINITION,
      savedValue: clinic.clinic_timezone,
      updatedAt: clinic.clinic_updated_at,
    },
    ...SETTING_DEFINITIONS.map((definition) => {
      const record = stored.find(
        (setting) => setting.system_setting_key === definition.key,
      )
      return {
        definition,
        savedValue: record?.system_setting_value ?? '',
        updatedAt: record?.system_setting_updated_at ?? null,
      }
    }),
  ]

  return (
    <>
      <PageHeader
        title="System settings"
        description="Configuration for your clinic: how RecoverEase behaves for its staff and patients."
      />

      <div className="space-y-5">
        {forms.map(({ definition, savedValue, updatedAt }) => (
          <SettingForm
            // Remounts with the saved value as its initial state whenever
            // the stored value changes, rather than syncing via an effect.
            key={`${definition.key}:${updatedAt ?? 'unset'}`}
            definition={definition}
            savedValue={savedValue}
            updatedAt={updatedAt}
            isSaving={
              save.isPending && save.variables?.key === definition.key
            }
            error={
              save.isError && save.variables?.key === definition.key
                ? save.error
                : null
            }
            wasJustSaved={savedKey === definition.key}
            onSave={(value) => {
              setSavedKey(null)
              save.mutate({ key: definition.key, value })
            }}
          />
        ))}
      </div>
    </>
  )
}
