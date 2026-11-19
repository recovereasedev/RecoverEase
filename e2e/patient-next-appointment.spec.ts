import { expect, IDS, test } from './support/fixtures'

/**
 * The patient's "Next appointment", in the browser.
 *
 * A cancelled future appointment used to be put forward as the visit to
 * attend, under "Confirm that you will attend, or ask for a different time."
 * It is now passed over, as the dashboard already did, and stays listed with
 * its status. Synthetic data only: Supabase is stubbed.
 */

function iso(days: number, hour = 10): string {
  const when = new Date()
  when.setDate(when.getDate() + days)
  when.setHours(hour, 0, 0, 0)
  return when.toISOString()
}

function appointment(id: string, when: string, status: string) {
  return {
    appointment_id: id,
    pat_id: IDS.alicePat,
    doc_id: IDS.doctorA,
    appointment_date: when,
    appointment_status: status,
    appointment_created_at: '2026-09-01T00:00:00Z',
    appointment_reminder_sent_at: null,
  }
}

const INSTRUCTION = 'Confirm that you will attend, or ask for a different time.'

test.describe('the patient’s next appointment', () => {
  test('a cancelled future appointment is not put forward to attend', async ({
    page,
    signInAs,
  }) => {
    await signInAs('patient', {
      appointment: [appointment(IDS.appointmentA, iso(4), 'cancelled')],
    })

    await page.goto('/patient/appointments')
    await expect(page.getByText('No upcoming appointments')).toBeVisible()
    await expect(page.getByRole('region', { name: 'Next appointment' })).toHaveCount(0)
    await expect(page.getByText(INSTRUCTION)).toHaveCount(0)
    // Still listed, with its status.
    await expect(page.getByText('Cancelled', { exact: true })).toBeVisible()
  })

  test('an earlier cancelled appointment does not hide a later one', async ({
    page,
    signInAs,
  }) => {
    await signInAs('patient', {
      appointment: [
        appointment(IDS.appointmentA, iso(2), 'cancelled'),
        appointment('x1a22222-2222-4222-8222-222222222222', iso(8), 'scheduled'),
      ],
    })

    await page.goto('/patient/appointments')
    const next = page.getByRole('region', { name: 'Next appointment' })
    await expect(next).toBeVisible()
    await expect(next.getByText(INSTRUCTION)).toBeVisible()
    await expect(next.getByRole('button', { name: /confirm/i })).toBeVisible()
    await expect(next.getByText('Cancelled', { exact: true })).toHaveCount(0)
    await expect(
      page.getByRole('region', { name: 'Later' }).getByText('Cancelled', { exact: true }),
    ).toBeVisible()
  })
})
