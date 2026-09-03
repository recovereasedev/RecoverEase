import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { ErrorState, LoadingState } from '@/components/feedback/state-view'
import { PageHeader } from '@/components/layout/page-header'
import { useCurrentUser } from '@/features/auth/auth-context'
import {
  fetchSystemSettings,
  saveSystemSetting,
  SETTING_DEFINITIONS,
} from '@/features/system-settings/api'
import { SettingForm } from '@/features/system-settings/components/setting-form'
import { queryKeys } from '@/lib/query-keys'

/**
 * Modules 14.1 "Configure System Settings" and 8.7 "Configure Chatbot System
 * Prompt / Response Guidelines".
 *
 * Only the settings the application actually reads are offered, each with an
 * explanation of what changing it does. A free-form key/value editor would
 * let an administrator create settings nothing consumes, and mistype the ones
 * that matter.
 */
export function SystemSettingsPage() {
  const user = useCurrentUser()
  const adminId = user.profile.kind === 'admin' ? user.profile.admin.admin_id : ''
  const queryClient = useQueryClient()
  const [savedKey, setSavedKey] = useState<string | null>(null)

  const settingsQuery = useQuery({
    queryKey: queryKeys.admin.settings(),
    queryFn: fetchSystemSettings,
  })

  const save = useMutation({
    mutationFn: (input: { key: string; value: string }) =>
      saveSystemSetting({ adminId, ...input }),
    onSuccess: (_result, variables) => {
      setSavedKey(variables.key)
      void queryClient.invalidateQueries({
        queryKey: queryKeys.admin.settings(),
      })
    },
  })

  if (settingsQuery.isPending) {
    return (
      <>
        <PageHeader title="System settings" />
        <LoadingState label="Loading settings…" />
      </>
    )
  }

  if (settingsQuery.isError) {
    return (
      <>
        <PageHeader title="System settings" />
        <ErrorState
          error={settingsQuery.error}
          onRetry={() => void settingsQuery.refetch()}
        />
      </>
    )
  }

  const stored = settingsQuery.data ?? []

  return (
    <>
      <PageHeader
        eyebrow="Configuration"
        title="System settings"
        description="Configuration that affects how RecoverEase behaves for everyone."
      />

      <div className="space-y-5">
        {SETTING_DEFINITIONS.map((definition) => {
          const record = stored.find(
            (setting) => setting.system_setting_key === definition.key,
          )

          return (
            <SettingForm
              // Remounts with the saved value as its initial state whenever
              // the stored record changes, rather than syncing via an effect.
              key={`${definition.key}:${record?.system_setting_updated_at ?? 'unset'}`}
              definition={definition}
              record={record}
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
          )
        })}
      </div>
    </>
  )
}
