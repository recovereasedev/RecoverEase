import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bot } from 'lucide-react'
import { useState } from 'react'

import { FormError } from '@/components/feedback/form-error'
import { ErrorState } from '@/components/feedback/state-view'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import {
  fetchGuidanceAssistantSwitch,
  setGuidanceAssistantSwitch,
} from '@/features/platform/api'
import { formatDateTime } from '@/lib/format'
import { queryKeys } from '@/lib/query-keys'

/**
 * The adviser's "AI Chatbot On/Off" for the whole platform (migration 38):
 * the Super Admin turns the guidance assistant off for every clinic at once -
 * for maintenance, an incident or a provider outage - and on again.
 *
 * Turning it off asks first, because it reaches every clinic's patients;
 * turning it on does not. Either way the database checks the Super Admin's
 * session, and audits the change as a platform entry. Each clinic's own
 * switch is its Clinic Admin's, and is not shown here.
 */
export function GuidanceAssistantSwitch() {
  const queryClient = useQueryClient()
  const [confirmingOff, setConfirmingOff] = useState(false)

  const switchQuery = useQuery({
    queryKey: queryKeys.platform.guidanceAssistant(),
    queryFn: fetchGuidanceAssistantSwitch,
  })

  const change = useMutation({
    mutationFn: setGuidanceAssistantSwitch,
    onSuccess: () => {
      setConfirmingOff(false)
      void queryClient.invalidateQueries({ queryKey: queryKeys.platform.guidanceAssistant() })
      void queryClient.invalidateQueries({ queryKey: queryKeys.platform.audit() })
    },
  })

  if (switchQuery.isError) {
    return (
      <Card>
        <CardBody>
          <ErrorState error={switchQuery.error} onRetry={() => void switchQuery.refetch()} />
        </CardBody>
      </Card>
    )
  }

  const state = switchQuery.data
  const enabled = state?.enabled ?? true

  return (
    <>
      <Card>
        <CardBody className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 gap-3">
            <Bot className="mt-0.5 size-5 shrink-0 text-muted" aria-hidden="true" />
            <div className="min-w-0">
              <h2 className="flex flex-wrap items-center gap-2 font-semibold text-heading">
                Guidance assistant
                {state ? (
                  <Badge tone={enabled ? 'success' : 'warning'}>
                    {enabled ? 'On for every clinic' : 'Off for every clinic'}
                  </Badge>
                ) : null}
              </h2>
              <p className="mt-0.5 text-sm text-muted">
                {state
                  ? state.updatedAt
                    ? `Changed ${formatDateTime(state.updatedAt)}. Each clinic can also turn it off for itself.`
                    : 'Never changed. Each clinic can also turn it off for itself.'
                  : 'Loading…'}
              </p>
            </div>
          </div>
          {state ? (
            enabled ? (
              <Button
                variant="outline"
                className="max-sm:w-full"
                onClick={() => {
                  change.reset()
                  setConfirmingOff(true)
                }}
              >
                Turn off for every clinic
              </Button>
            ) : (
              <Button
                className="max-sm:w-full"
                isLoading={change.isPending}
                loadingLabel="Turning on…"
                onClick={() => change.mutate(true)}
              >
                Turn on for every clinic
              </Button>
            )
          ) : null}
        </CardBody>
        {change.isError && !confirmingOff ? (
          <CardBody className="pt-0">
            <FormError error={change.error} title="The guidance assistant was not turned on" />
          </CardBody>
        ) : null}
      </Card>

      <Dialog
        isOpen={confirmingOff}
        onClose={() => setConfirmingOff(false)}
        title="Turn the guidance assistant off for every clinic?"
        description="You can turn it on again at any time."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmingOff(false)}>
              Keep it on
            </Button>
            <Button
              variant="danger"
              isLoading={change.isPending}
              loadingLabel="Turning off…"
              onClick={() => change.mutate(false)}
            >
              Turn off for every clinic
            </Button>
          </>
        }
      >
        <p className="text-body">
          No patient in any clinic gets an answer from the guidance assistant
          until it is on again. Their conversations stay, and their care teams
          still see them.
        </p>
        {change.isError ? (
          <div className="mt-4">
            <FormError error={change.error} title="The guidance assistant was not turned off" />
          </div>
        ) : null}
      </Dialog>
    </>
  )
}
