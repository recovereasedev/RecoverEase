import { expect, IDS, test, type SupabaseStub } from './support/fixtures'

/**
 * Decision D8 in the browser: a Clinic Admin hands a deactivated doctor's
 * patients to an active doctor in the same clinic.
 *
 * The stub answers as the database would after its own checks; what is
 * proven here is the screen's side - that it asks for a count and shows
 * nothing more, sends exactly what was confirmed, and keeps keyboard focus
 * where a keyboard user needs it.
 */

function doctor(id: string, userId: string, first: string, last: string, active: boolean) {
  return {
    doc_id: id,
    user_id: userId,
    clinic_id: 'clinic-harborview',
    doc_first_name: first,
    doc_last_name: last,
    doc_specialization: 'Orthopaedic rehabilitation',
    doc_license_no: `LIC-${first.toUpperCase()}`,
    doc_contact_no: null,
    doc_is_active: active,
    doc_created_at: '2026-01-01T00:00:00Z',
  }
}

const withDeactivatedDoctor = {
  doctor: [
    doctor(IDS.doctorA, IDS.doctorAUser, 'Alan', 'Cruz', true),
    doctor(IDS.doctorB, IDS.doctorBUser, 'Bea', 'Lim', false),
  ],
}

/** Dr Bea Lim holds two patients, and moving them moves two. */
function twoPatientsToMove(stub: SupabaseStub) {
  stub.setRpcResult('admin_doctor_patient_count', 2)
  stub.setRpcResult('admin_reassign_doctor_patients', 2)
}

test.describe('reassigning a deactivated doctor’s patients', () => {
  test('counts them, moves them to the chosen doctor, and never names a patient', async ({
    page,
    signInAs,
  }) => {
    twoPatientsToMove(await signInAs('admin', withDeactivatedDoctor))
    await page.goto('/admin/doctors')

    // Offered for the deactivated doctor only.
    await expect(page.getByRole('button', { name: /reassign patients of dr alan cruz/i })).toHaveCount(0)
    const opener = page.getByRole('button', { name: /reassign patients of dr bea lim/i })
    await opener.click()

    const dialog = page.getByRole('dialog', { name: 'Reassign patients' })
    await expect(dialog.getByText('Dr Bea Lim has 2 patients.')).toBeVisible()

    // Checked on submit: the problem beside its field, and focus taken there.
    const move = dialog.getByRole('button', { name: 'Move 2 patients' })
    await move.click()
    await expect(dialog.getByText('Choose the doctor who will take over these patients.')).toBeVisible()
    const newDoctor = dialog.getByRole('combobox', { name: /new doctor/i })
    await expect(newDoctor).toBeFocused()

    await newDoctor.selectOption({ label: 'Dr Alan Cruz' })
    const sent = page.waitForRequest((request) =>
      request.url().includes('/rest/v1/rpc/admin_reassign_doctor_patients'),
    )
    await move.click()

    // Exactly the move that was confirmed, with the count that was shown.
    expect((await sent).postDataJSON()).toEqual({
      from_doc_id: IDS.doctorB,
      to_doc_id: IDS.doctorA,
      expected_count: 2,
    })

    const done = page
      .getByRole('dialog', { name: 'Patients reassigned' })
      .getByRole('button', { name: 'Done' })
    await expect(page.getByText('2 patients moved to Dr Alan Cruz')).toBeVisible()
    await expect(done).toBeFocused()

    // A count and two doctors' names. No patient is named anywhere.
    for (const name of ['Alice', 'Bob', 'Carol', 'Santos']) {
      await expect(page.getByText(name)).toHaveCount(0)
    }

    await done.click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(opener).toBeFocused()
  })

  test('opens and closes from the keyboard, handing focus back to the button', async ({
    page,
    signInAs,
  }) => {
    twoPatientsToMove(await signInAs('admin', withDeactivatedDoctor))
    await page.goto('/admin/doctors')

    const opener = page.getByRole('button', { name: /reassign patients of dr bea lim/i })
    await opener.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog', { name: 'Reassign patients' })).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(opener).toBeFocused()
  })
})
