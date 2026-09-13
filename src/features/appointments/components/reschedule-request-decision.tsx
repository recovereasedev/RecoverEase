import { FormError } from '@/components/feedback/form-error'
import { StatusBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { RescheduleRequestWithAppointment } from '@/features/appointments/api'
import { closedAppointmentPhrase } from '@/features/appointments/appointment-rules'
import type { useDecideRescheduleRequest } from '@/features/appointments/hooks'
import { appointmentStatus } from '@/lib/status'

/**
 * The clinician's decision on one pending reschedule request (modules 6.3 and
 * 6.4), shared by the appointments page and the dashboard.
 *
 * NA-03: a request can outlive its appointment — the patient can cancel while
 * it is still pending. The database refuses to move a closed appointment
 * (migration 17), so "Approve and move" is not offered on one: the request is
 * shown as closed, and declining it, which the database still allows, clears
 * it from the list.
 *
 * NA-02: a decision the server refuses says why, beside the request it was
 * about, and the request stays to be decided again.
 */
export function RescheduleRequestDecision({
  request,
  decide,
}: {
  request: RescheduleRequestWithAppointment
  decide: ReturnType<typeof useDecideRescheduleRequest>
}) {
  const status = request.appointment?.appointment_status
  const closed = status ? closedAppointmentPhrase(status) : null
  const isThis = decide.variables?.requestId === request.reschedule_request_id
  const deciding = decide.isPending && isThis ? decide.variables?.decision : undefined

  const choose = (decision: 'approved' | 'declined') =>
    decide.mutate({ requestId: request.reschedule_request_id, decision })

  return (
    <div className="space-y-3">
      {closed && status ? (
        <div className="flex flex-col gap-2 rounded-[var(--radius-md)] bg-surface-sunken px-3 py-2 sm:flex-row sm:items-center">
          <StatusBadge status={appointmentStatus[status]} className="self-start sm:self-auto" />
          <p className="text-sm leading-relaxed text-body">
            This appointment {closed}, so it can no longer be moved. Decline the
            request to clear it.
          </p>
        </div>
      ) : null}

      {decide.isError && isThis ? (
        <FormError
          error={decide.error}
          title={
            decide.variables?.decision === 'approved'
              ? 'The request was not approved'
              : 'The request was not declined'
          }
        />
      ) : null}

      {/* Two decisions, side by side on a phone rather than stacked: they are
          alternatives to each other, and stacking reads as a sequence. */}
      <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
        {closed ? null : (
          <Button
            size="sm"
            isLoading={deciding === 'approved'}
            onClick={() => choose('approved')}
          >
            Approve and move
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          isLoading={deciding === 'declined'}
          onClick={() => choose('declined')}
        >
          Decline
        </Button>
      </div>
    </div>
  )
}
