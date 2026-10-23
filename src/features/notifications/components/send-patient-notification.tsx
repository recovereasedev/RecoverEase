import { useState } from 'react'

import { ErrorState, InlineEmpty, LoadingState } from '@/components/feedback/state-view'
import { Card, CardBody, CardHeader } from '@/components/ui/card'
import { Combobox, Field } from '@/components/ui/field'
import { NotifyPatientForm } from '@/features/notifications/components/notify-patient'
import { useMyPatients } from '@/features/patients/hooks'
import { fullName } from '@/lib/utils'

/**
 * Module 7.1 from the doctor's Notifications page: choose one of your
 * patients, then write to them - the same message form as on their record.
 *
 * The list is `useMyPatients`, which Row Level Security answers with this
 * doctor's own patients and nobody else's, so the picker cannot offer anyone
 * the database would refuse; the insert is checked again by
 * `notification_insert_doctor_to_patient` regardless.
 *
 * The message box belongs to the patient chosen. Choosing someone else starts
 * an empty one, so words written for one patient can never be sent to
 * another by changing the name above them.
 */
export function SendPatientNotification() {
  const patients = useMyPatients()
  const [patientId, setPatientId] = useState('')
  const chosen = patients.data?.find((patient) => patient.pat_id === patientId)

  return (
    <Card>
      <CardHeader
        title="Send a notification"
        description="To one of your patients. They read it in their notifications; it is not a clinical note."
      />
      <CardBody className="space-y-5">
        {patients.isPending ? (
          <LoadingState label="Loading your patients…" />
        ) : patients.error ? (
          <ErrorState error={patients.error} onRetry={() => void patients.refetch()} />
        ) : patients.data.length === 0 ? (
          <InlineEmpty className="px-0 py-0">
            You have no patients to notify yet.
          </InlineEmpty>
        ) : (
          <>
            <Field label="Patient" description="Only your own patients are listed.">
              <Combobox
                options={patients.data.map((patient) => ({
                  value: patient.pat_id,
                  label: fullName(patient.pat_first_name, patient.pat_last_name),
                }))}
                value={patientId}
                onChange={setPatientId}
                placeholder="Choose a patient…"
              />
            </Field>

            {chosen ? (
              <NotifyPatientForm
                key={chosen.pat_id}
                patientUserId={chosen.user_id}
                patientName={fullName(chosen.pat_first_name, chosen.pat_last_name)}
              />
            ) : (
              <p className="text-sm text-muted">Choose a patient to write to them.</p>
            )}
          </>
        )}
      </CardBody>
    </Card>
  )
}
