import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Doctor } from '@/features/patients/api'

/**
 * Module 11.2 "Update Doctor Account": a Clinic Admin corrects a doctor's
 * details from the Doctor accounts page.
 *
 * Who may write a doctor's row, and which of its columns, is decided by the
 * database and covered against it (`tests/db/clinic-admin-updates-doctor.test.ts`).
 * What is covered here is the screen: that the dialog opens on the doctor
 * chosen, sends only what the administrator changed - and never a column this
 * dialog does not own - says what is wrong beside the field it is wrong in,
 * and leaves the page's other actions as they were.
 */

const api = vi.hoisted(() => ({
  fetchAllDoctors: vi.fn(),
  updateDoctor: vi.fn(),
  setDoctorActive: vi.fn(),
}))

vi.mock('@/features/patients/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/patients/api')>()),
  ...api,
}))

vi.mock('@/features/auth/auth-context', () => ({
  useCurrentUser: () => ({ userId: 'u-admin', role: 'admin' }),
}))

const { AdminDoctorsPage } = await import('@/features/patients/pages/admin-doctors-page')

const ALAN: Doctor = {
  doc_id: 'd-alan',
  user_id: 'u-alan',
  clinic_id: 'c-harborview',
  doc_first_name: 'Alan',
  doc_last_name: 'Cruz',
  doc_specialization: 'Orthopaedic rehabilitation',
  doc_license_no: 'LIC-A-001',
  doc_contact_no: '0917 000 1111',
  doc_is_active: true,
  doc_created_at: '2026-01-01T00:00:00Z',
  doc_appointment_reminder_is_enabled: true,
}

/** Deactivated, and with nothing in either optional field. */
const BEA: Doctor = {
  ...ALAN,
  doc_id: 'd-bea',
  user_id: 'u-bea',
  doc_first_name: 'Bea',
  doc_last_name: 'Lim',
  doc_specialization: null,
  doc_license_no: 'LIC-B-002',
  doc_contact_no: null,
  doc_is_active: false,
}

/** The doctor table as the administrator's clinic sees it. */
let rows: Doctor[] = []

/** The columns this dialog may never send, whatever is typed into it. */
const PROTECTED = [
  'doc_id',
  'user_id',
  'clinic_id',
  'doc_created_at',
  'doc_is_active',
  'doc_appointment_reminder_is_enabled',
]

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AdminDoctorsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const dialog = () => screen.getByRole('dialog', { name: 'Edit doctor account' })
const field = (name: RegExp) => within(dialog()).getByRole('textbox', { name })
const firstName = () => field(/^first name/i)
const lastName = () => field(/^last name/i)
const licence = () => field(/^licence number/i)
const specialisation = () => field(/^specialisation/i)
const contact = () => field(/^contact number/i)
const save = () => within(dialog()).getByRole('button', { name: /save changes/i })

/**
 * A row's button, by what it does and whose row it is in: "Edit Dr Alan
 * Cruz". The doctor's name is in a visually hidden span, and jsdom's name
 * computation drops the space in front of it, so that space is optional here.
 * The browser tests match the name as it is really read (e2e/edit-doctor.spec.ts).
 */
const rowButton = (action: string, doctor: string) => ({
  name: new RegExp(`^${action} ?Dr ${doctor}$`),
})

async function openEditFor(name: string) {
  fireEvent.click(await screen.findByRole('button', rowButton('Edit', name)))
}

const type = (input: HTMLElement, value: string) => fireEvent.change(input, { target: { value } })

/** Presses Save and lets the request it starts settle. */
async function pressSave() {
  await act(async () => {
    fireEvent.click(save())
  })
}

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function () {
    this.open = false
  }
})

beforeEach(() => {
  rows = [ALAN, BEA]
  api.fetchAllDoctors.mockReset()
  api.fetchAllDoctors.mockImplementation(async () => rows)
  api.setDoctorActive.mockReset()
  api.setDoctorActive.mockResolvedValue(undefined)
  api.updateDoctor.mockReset()
  // As the database answers: the row, with the changes applied.
  api.updateDoctor.mockImplementation(async (doctorId: string, changes: Partial<Doctor>) => {
    rows = rows.map((row) => (row.doc_id === doctorId ? { ...row, ...changes } : row))
    return rows.find((row) => row.doc_id === doctorId)
  })
})

describe('editing a doctor account', () => {
  it('offers Edit for every doctor, deactivated ones included, each named for its doctor', async () => {
    renderPage()

    expect(await screen.findByRole('button', rowButton('Edit', 'Alan Cruz'))).toBeVisible()
    expect(screen.getByRole('button', rowButton('Edit', 'Bea Lim'))).toBeVisible()
    expect(screen.queryByRole('dialog', { name: 'Edit doctor account' })).not.toBeInTheDocument()
  })

  it('opens on the doctor chosen, with what is on record already filled in', async () => {
    renderPage()
    await openEditFor('Alan Cruz')

    expect(dialog()).toHaveAccessibleDescription(/Dr Alan Cruz/)
    expect(firstName()).toHaveValue('Alan')
    expect(lastName()).toHaveValue('Cruz')
    expect(licence()).toHaveValue('LIC-A-001')
    expect(specialisation()).toHaveValue('Orthopaedic rehabilitation')
    expect(contact()).toHaveValue('0917 000 1111')
    for (const required of [firstName(), lastName(), licence()]) {
      expect(required).toHaveAccessibleName(/\(required\)/)
    }
  })

  it('shows an empty field where nothing is recorded', async () => {
    renderPage()
    await openEditFor('Bea Lim')

    expect(firstName()).toHaveValue('Bea')
    expect(licence()).toHaveValue('LIC-B-002')
    expect(specialisation()).toHaveValue('')
    expect(contact()).toHaveValue('')
  })

  it('saves only what was changed, trimmed, then closes, says so and shows it in the list', async () => {
    renderPage()
    await openEditFor('Alan Cruz')

    type(lastName(), '  Cruz-Santos ')
    type(contact(), ' 0917 222 3333  ')
    await pressSave()

    expect(api.updateDoctor).toHaveBeenCalledTimes(1)
    expect(api.updateDoctor).toHaveBeenCalledWith('d-alan', {
      doc_last_name: 'Cruz-Santos',
      doc_contact_no: '0917 222 3333',
    })

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Edit doctor account' })).not.toBeInTheDocument(),
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      'The details for Dr Alan Cruz-Santos were updated.',
    )
    // The list is read again, so the row shows what was saved.
    expect(
      await screen.findByRole('button', rowButton('Edit', 'Alan Cruz-Santos')),
    ).toBeVisible()
    expect(screen.queryByRole('button', rowButton('Edit', 'Alan Cruz'))).not.toBeInTheDocument()
    expect(api.fetchAllDoctors).toHaveBeenCalledTimes(2)
  })

  it('can change all five details at once, and never sends anything else', async () => {
    renderPage()
    await openEditFor('Alan Cruz')

    type(firstName(), 'Alonzo')
    type(lastName(), 'Reyes')
    type(licence(), 'LIC-A-900')
    type(specialisation(), 'Sports rehabilitation')
    type(contact(), '+63 917 555 0142')
    await pressSave()

    const [doctorId, changes] = api.updateDoctor.mock.calls[0]!
    expect(doctorId).toBe('d-alan')
    expect(changes).toEqual({
      doc_first_name: 'Alonzo',
      doc_last_name: 'Reyes',
      doc_license_no: 'LIC-A-900',
      doc_specialization: 'Sports rehabilitation',
      doc_contact_no: '+63 917 555 0142',
    })
    for (const column of PROTECTED) expect(changes).not.toHaveProperty(column)
  })

  it('stores an optional field that was emptied as nothing, not as an empty string', async () => {
    renderPage()
    await openEditFor('Alan Cruz')

    type(specialisation(), '   ')
    type(contact(), '')
    await pressSave()

    expect(api.updateDoctor).toHaveBeenCalledWith('d-alan', {
      doc_specialization: null,
      doc_contact_no: null,
    })
  })

  it('sends nothing, and claims nothing, when Save is pressed with nothing changed', async () => {
    renderPage()
    await openEditFor('Alan Cruz')

    // Spaces around a value that is otherwise the same are not a change.
    type(firstName(), ' Alan ')
    await pressSave()

    expect(api.updateDoctor).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: 'Edit doctor account' })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('says which required details are missing beside each field, takes focus to the first, and sends nothing', async () => {
    renderPage()
    await openEditFor('Alan Cruz')

    type(firstName(), '')
    type(lastName(), '   ')
    type(licence(), '')
    await pressSave()

    expect(within(dialog()).getByText('Enter their first name.')).toBeVisible()
    expect(within(dialog()).getByText('Enter their last name.')).toBeVisible()
    expect(within(dialog()).getByText('Enter their licence number.')).toBeVisible()
    for (const input of [firstName(), lastName(), licence()]) {
      expect(input).toHaveAttribute('aria-invalid', 'true')
    }
    expect(firstName()).toHaveFocus()
    expect(api.updateDoctor).not.toHaveBeenCalled()

    // A message goes once its field is being corrected; the others stay.
    type(firstName(), 'Alan')
    expect(within(dialog()).queryByText('Enter their first name.')).not.toBeInTheDocument()
    expect(within(dialog()).getByText('Enter their last name.')).toBeVisible()
  })

  it('says a licence number is another doctor’s beside that field, and keeps what was typed', async () => {
    api.updateDoctor.mockRejectedValue({
      code: '23505',
      message: 'duplicate key value violates unique constraint "doctor_license_no_key"',
      details: 'Key (doc_license_no)=(LIC-B-002) already exists.',
    })
    renderPage()
    await openEditFor('Alan Cruz')

    type(licence(), 'LIC-B-002')
    type(contact(), '0917 222 3333')
    await pressSave()

    expect(
      await within(dialog()).findByText('Another doctor already has this licence number.'),
    ).toBeVisible()
    expect(licence()).toHaveAttribute('aria-invalid', 'true')
    expect(licence()).toHaveFocus()
    expect(licence()).toHaveValue('LIC-B-002')
    expect(contact()).toHaveValue('0917 222 3333')
    // Said once, beside the field, and never in the database's words.
    expect(within(dialog()).getAllByRole('alert')).toHaveLength(1)
    expect(within(dialog()).queryByText('The doctor’s details were not saved')).not.toBeInTheDocument()
    expect(dialog()).not.toHaveTextContent(/duplicate key|constraint|doctor_license_no_key/)
    expect(screen.getByRole('status')).toBeEmptyDOMElement()

    // Corrected, it saves.
    api.updateDoctor.mockResolvedValue({ ...ALAN, doc_license_no: 'LIC-A-777' })
    type(licence(), 'LIC-A-777')
    expect(
      within(dialog()).queryByText('Another doctor already has this licence number.'),
    ).not.toBeInTheDocument()
    await pressSave()
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Edit doctor account' })).not.toBeInTheDocument(),
    )
  })

  it('says when the save failed, keeps the dialog and what was typed, and saves on a second try', async () => {
    api.updateDoctor.mockRejectedValueOnce(new Error('Failed to fetch'))
    renderPage()
    await openEditFor('Alan Cruz')

    type(specialisation(), 'Sports rehabilitation')
    await pressSave()

    const alert = await within(dialog()).findByRole('alert')
    expect(alert).toHaveTextContent('No connection')
    expect(alert).toHaveTextContent('Nothing has been saved.')
    expect(specialisation()).toHaveValue('Sports rehabilitation')
    expect(screen.getByRole('status')).toBeEmptyDOMElement()

    await pressSave()
    expect(api.updateDoctor).toHaveBeenCalledTimes(2)
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Edit doctor account' })).not.toBeInTheDocument(),
    )
    expect(screen.getByRole('status')).toHaveTextContent('The details for Dr Alan Cruz were updated.')
  })

  it('says so plainly when the database refuses the change', async () => {
    api.updateDoctor.mockRejectedValue({
      code: '42501',
      message: 'new row violates row-level security policy for table "doctor"',
    })
    renderPage()
    await openEditFor('Alan Cruz')

    type(specialisation(), 'Sports rehabilitation')
    await pressSave()

    const alert = await within(dialog()).findByRole('alert')
    expect(alert).toHaveTextContent('You do not have access to this')
    expect(alert).not.toHaveTextContent(/row-level security/)
  })

  it('says nothing was saved when the doctor is not one this administrator can change', async () => {
    // What PostgREST answers when the update matched no row the caller may
    // write: another clinic's doctor, or an administrator whose access went.
    api.updateDoctor.mockRejectedValue({
      code: 'PGRST116',
      message: 'Cannot coerce the result to a single JSON object',
      details: 'The result contains 0 rows',
    })
    renderPage()
    await openEditFor('Alan Cruz')

    type(specialisation(), 'Sports rehabilitation')
    await pressSave()

    const alert = await within(dialog()).findByRole('alert')
    expect(alert).toHaveTextContent('The doctor’s details were not saved')
    expect(alert).toHaveTextContent(
      'This account can no longer be changed from your clinic. Nothing was saved.',
    )
    expect(alert).not.toHaveTextContent(/coerce|JSON/)
  })

  it('sends one request however many times Save is pressed while it is saving', async () => {
    let finish: (doctor: Doctor) => void = () => {}
    api.updateDoctor.mockImplementation(
      () => new Promise<Doctor>((resolve) => (finish = resolve)),
    )
    renderPage()
    await openEditFor('Alan Cruz')

    type(contact(), '0917 222 3333')
    await pressSave()

    await waitFor(() => expect(save()).toHaveAttribute('aria-busy', 'true'))
    expect(save()).toHaveAttribute('aria-disabled', 'true')
    expect(save()).toHaveTextContent('Saving…')
    await pressSave()
    await act(async () => {
      fireEvent.submit(dialog().querySelector('form')!)
    })
    expect(api.updateDoctor).toHaveBeenCalledTimes(1)

    await act(async () => {
      finish({ ...ALAN, doc_contact_no: '0917 222 3333' })
    })
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Edit doctor account' })).not.toBeInTheDocument(),
    )
  })

  it('saves nothing on Cancel, and starts from what is on record when opened again', async () => {
    renderPage()
    await openEditFor('Alan Cruz')

    type(firstName(), 'Alonzo')
    type(licence(), '')
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('dialog', { name: 'Edit doctor account' })).not.toBeInTheDocument()
    expect(api.updateDoctor).not.toHaveBeenCalled()
    expect(screen.getByRole('status')).toBeEmptyDOMElement()

    await openEditFor('Alan Cruz')
    expect(firstName()).toHaveValue('Alan')
    expect(licence()).toHaveValue('LIC-A-001')
  })

  it('carries nothing from one doctor’s dialog into the next', async () => {
    api.updateDoctor.mockRejectedValueOnce(new Error('Failed to fetch'))
    renderPage()
    await openEditFor('Alan Cruz')
    type(firstName(), '')
    type(contact(), '0917 222 3333')
    await pressSave()
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Close dialog' }))

    await openEditFor('Bea Lim')
    expect(dialog()).toHaveAccessibleDescription(/Dr Bea Lim/)
    expect(firstName()).toHaveValue('Bea')
    expect(contact()).toHaveValue('')
    expect(firstName()).not.toHaveAttribute('aria-invalid')
    expect(within(dialog()).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('clears the last confirmation when another edit is started', async () => {
    renderPage()
    await openEditFor('Alan Cruz')
    type(contact(), '0917 222 3333')
    await pressSave()
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('The details for Dr Alan Cruz were updated.'),
    )

    await openEditFor('Bea Lim')
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })
})

describe('the other actions on a doctor account', () => {
  it('still deactivates and reactivates from the list, on their own', async () => {
    renderPage()

    fireEvent.click(await screen.findByRole('button', rowButton('Deactivate', 'Alan Cruz')))
    await waitFor(() => expect(api.setDoctorActive).toHaveBeenCalledWith('d-alan', false))

    fireEvent.click(screen.getByRole('button', rowButton('Reactivate', 'Bea Lim')))
    await waitFor(() => expect(api.setDoctorActive).toHaveBeenCalledWith('d-bea', true))
    expect(api.updateDoctor).not.toHaveBeenCalled()
  })

  it('still opens the password reset and the reassignment for the doctor chosen', async () => {
    renderPage()

    // Offered for the deactivated doctor only, as before.
    expect(
      await screen.findByRole('button', rowButton('Reassign patients ?of', 'Bea Lim')),
    ).toBeVisible()
    expect(
      screen.queryByRole('button', rowButton('Reassign patients ?of', 'Alan Cruz')),
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', rowButton('Reset password ?for', 'Alan Cruz')))
    expect(screen.getByRole('dialog', { name: /reset/i })).toHaveTextContent('Dr Alan Cruz')
    expect(screen.queryByRole('dialog', { name: 'Edit doctor account' })).not.toBeInTheDocument()
  })

  it('offers neither a status switch nor a password in the edit dialog', async () => {
    renderPage()
    await openEditFor('Alan Cruz')

    expect(within(dialog()).getAllByRole('textbox')).toHaveLength(5)
    expect(within(dialog()).queryByRole('checkbox')).not.toBeInTheDocument()
    expect(within(dialog()).queryByRole('combobox')).not.toBeInTheDocument()
    expect(within(dialog()).queryByLabelText(/password|email|status/i)).not.toBeInTheDocument()
  })
})
