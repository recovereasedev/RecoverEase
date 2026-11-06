import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Phase 2 of the platform console: the clinic list's search and status
 * filter, a clinic's details page with its Clinic Admins, and the edit
 * dialog, which renames a clinic and shows its time zone read-only.
 *
 * The data layer is replaced; tests/db/super-admin-clinic-details.test.ts
 * covers what the database allows and stores.
 */

const api = vi.hoisted(() => ({
  fetchClinics: vi.fn(),
  fetchClinicAdmins: vi.fn(),
  renameClinic: vi.fn(),
  createClinic: vi.fn(),
  setClinicStatus: vi.fn(),
  createClinicAdmin: vi.fn(),
  fetchGuidanceAssistantSwitch: vi.fn(),
  setGuidanceAssistantSwitch: vi.fn(),
}))

vi.mock('@/features/platform/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/platform/api')>()),
  ...api,
}))

vi.mock('@/features/auth/auth-context', () => ({
  useCurrentUser: () => ({
    userId: 'super-user',
    role: 'super_admin',
    profile: { kind: 'super_admin', superAdmin: { super_admin_id: 'sa-1' } },
  }),
}))

const { PlatformClinicsPage, filterClinics } = await import(
  '@/features/platform/pages/platform-clinics-page'
)
const { PlatformClinicDetailsPage } = await import(
  '@/features/platform/pages/platform-clinic-details-page'
)
const { validateClinicName } = await import('@/features/platform/components/edit-clinic-dialog')

const HARBOR = {
  clinic_id: 'clinic-1',
  clinic_name: 'Harbor Clinic',
  clinic_status: 'active' as const,
  clinic_timezone: 'Asia/Manila',
  clinic_created_at: '2026-10-01T00:00:00Z',
  clinic_updated_at: '2026-10-02T00:00:00Z',
  clinic_admin_count: 1,
}
const ALDER = {
  ...HARBOR,
  clinic_id: 'clinic-2',
  clinic_name: 'Alder Wellness',
  clinic_status: 'inactive' as const,
  clinic_timezone: 'Asia/Singapore',
}

function renderAt(path: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/platform/clinics" element={<PlatformClinicsPage />} />
          <Route path="/platform/clinics/:clinicId" element={<PlatformClinicDetailsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function openDialog(): HTMLElement {
  const dialog = document.querySelector('dialog[open]')
  if (!(dialog instanceof HTMLElement)) throw new Error('No dialog is open')
  return dialog
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
  vi.resetAllMocks()
  api.fetchClinics.mockResolvedValue([ALDER, HARBOR])
  api.fetchGuidanceAssistantSwitch.mockResolvedValue({ enabled: true, updatedAt: null })
  api.fetchClinicAdmins.mockResolvedValue([
    {
      firstName: 'Ada',
      lastName: 'Reyes',
      createdAt: '2026-10-01T00:00:00Z',
      hasSignedIn: true,
      lastSignedInAt: '2026-10-03T01:00:00Z',
    },
    {
      firstName: 'Ben',
      lastName: 'Santos',
      createdAt: '2026-10-04T00:00:00Z',
      hasSignedIn: false,
      lastSignedInAt: null,
    },
  ])
})

describe('filterClinics', () => {
  const clinics = [ALDER, HARBOR]

  it('matches every word of the search in the name, in any case, and the status', () => {
    expect(filterClinics(clinics, '', 'all')).toEqual(clinics)
    expect(filterClinics(clinics, '  HARBOR  ', 'all')).toEqual([HARBOR])
    expect(filterClinics(clinics, 'wellness alder', 'all')).toEqual([ALDER])
    expect(filterClinics(clinics, '', 'active')).toEqual([HARBOR])
    expect(filterClinics(clinics, '', 'inactive')).toEqual([ALDER])
    expect(filterClinics(clinics, 'harbor', 'inactive')).toEqual([])
  })
})

describe('validateClinicName', () => {
  it('trims the name and accepts one of 120 characters', () => {
    expect(validateClinicName('  Harbor  ')).toEqual({ ok: true, value: 'Harbor' })
    expect(validateClinicName('x'.repeat(120)).ok).toBe(true)
  })

  it('refuses an empty or too long name', () => {
    expect(validateClinicName('   ')).toEqual({ ok: false, problem: "Enter the clinic's name." })
    expect(validateClinicName('x'.repeat(121))).toEqual({
      ok: false,
      problem: 'A clinic name can be at most 120 characters.',
    })
  })
})

describe('the clinic list', () => {
  it('searches by name and filters by status, with a way to clear both', async () => {
    const user = userEvent.setup()
    renderAt('/platform/clinics')

    expect(await screen.findByRole('heading', { level: 2, name: 'Harbor Clinic' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Alder Wellness' })).toBeInTheDocument()

    await user.type(screen.getByLabelText('Search clinics'), 'harb')
    expect(screen.queryByRole('heading', { level: 2, name: 'Alder Wellness' })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('1 of 2 clinics shown')

    await user.selectOptions(screen.getByLabelText('Status'), 'inactive')
    expect(screen.getByText('No matching clinics')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(screen.getByRole('heading', { level: 2, name: 'Alder Wellness' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Harbor Clinic' })).toBeInTheDocument()
  })

  it('links each clinic to its details page', async () => {
    renderAt('/platform/clinics')
    expect(await screen.findByRole('link', { name: 'View details of Harbor Clinic' })).toHaveAttribute(
      'href',
      '/platform/clinics/clinic-1',
    )
  })

  it('still says there are no clinics yet when there are none', async () => {
    api.fetchClinics.mockResolvedValue([])
    renderAt('/platform/clinics')
    expect(await screen.findByText('No clinics yet')).toBeInTheDocument()
    expect(screen.queryByLabelText('Search clinics')).not.toBeInTheDocument()
  })
})

describe('a clinic’s details', () => {
  it('shows the clinic and its Clinic Admins, asked for by its id, with no claim about setup', async () => {
    renderAt('/platform/clinics/clinic-1')

    expect(await screen.findByRole('heading', { level: 1, name: 'Harbor Clinic' })).toBeInTheDocument()
    const facts = screen.getAllByRole('definition').map((node) => node.textContent)
    expect(facts.slice(0, 3)).toEqual(['Harbor Clinic', 'Active', 'Asia/Manila'])

    const admins = await screen.findByRole('list', { name: 'Clinic Admins of Harbor Clinic' })
    const rows = within(admins).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('Ada Reyes')
    expect(rows[0]).toHaveTextContent('Has signed in')
    expect(rows[1]).toHaveTextContent('Ben Santos')
    expect(rows[1]).toHaveTextContent('Not signed in yet')
    expect(screen.queryByText(/setup complete/i)).not.toBeInTheDocument()
    expect(api.fetchClinicAdmins).toHaveBeenCalledWith('clinic-1')
  })

  it('says a clinic that is not on the platform could not be found', async () => {
    renderAt('/platform/clinics/clinic-404')
    expect(await screen.findByRole('heading', { level: 1, name: 'Clinic not found' })).toBeInTheDocument()
    expect(api.fetchClinicAdmins).not.toHaveBeenCalled()
  })

  it('offers to try again when the clinic could not be loaded', async () => {
    api.fetchClinics.mockRejectedValueOnce(new Error('offline')).mockResolvedValue([HARBOR])
    const user = userEvent.setup()
    renderAt('/platform/clinics/clinic-1')
    await user.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Harbor Clinic' })).toBeInTheDocument()
  })

  it('says when a clinic has no Clinic Admin yet', async () => {
    api.fetchClinicAdmins.mockResolvedValue([])
    renderAt('/platform/clinics/clinic-1')
    expect(await screen.findByText('No Clinic Admin yet')).toBeInTheDocument()
  })
})

describe('editing a clinic', () => {
  it('checks the form before sending, then saves a new name at once', async () => {
    api.renameClinic.mockResolvedValue({ ...HARBOR, clinic_name: 'Harbor Recovery' })
    const user = userEvent.setup()
    renderAt('/platform/clinics/clinic-1')
    await user.click(await screen.findByRole('button', { name: 'Edit clinic' }))

    const dialog = openDialog()
    const name = within(dialog).getByLabelText(/Clinic name/)
    await user.clear(name)
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }))
    expect(within(dialog).getByText("Enter the clinic's name.")).toBeInTheDocument()
    expect(api.renameClinic).not.toHaveBeenCalled()

    await user.type(name, '  Harbor Recovery ')
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(api.renameClinic).toHaveBeenCalledWith({ clinicId: 'clinic-1', name: 'Harbor Recovery' }),
    )
    expect(await screen.findByText('The clinic’s details were saved.')).toBeInTheDocument()
    // Read again from the database after the save.
    await waitFor(() => expect(api.fetchClinics.mock.calls.length).toBeGreaterThan(1))
  })

  it('shows the time zone read-only, with no way to change it', async () => {
    const user = userEvent.setup()
    renderAt('/platform/clinics/clinic-1')
    await user.click(await screen.findByRole('button', { name: 'Edit clinic' }))

    const dialog = openDialog()
    expect(dialog).toHaveTextContent('Asia/Manila')
    expect(dialog).toHaveTextContent('Read-only here')
    // One field only, the name: no time zone input, list or picker.
    expect(within(dialog).queryByLabelText(/Time zone/)).not.toBeInTheDocument()
    expect(within(dialog).getAllByRole('textbox')).toHaveLength(1)
    expect(within(dialog).queryByRole('combobox')).not.toBeInTheDocument()
    expect(dialog.querySelector('datalist')).toBeNull()
    expect(screen.queryByText("Change the clinic's time zone?")).not.toBeInTheDocument()
  })

  it('keeps the dialog open and says why when the database refuses the change', async () => {
    api.renameClinic.mockRejectedValue(new Error('A clinic with that name already exists.'))
    const user = userEvent.setup()
    renderAt('/platform/clinics/clinic-1')
    await user.click(await screen.findByRole('button', { name: 'Edit clinic' }))

    const name = within(openDialog()).getByLabelText(/Clinic name/)
    await user.clear(name)
    await user.type(name, 'Alder Wellness')
    await user.click(within(openDialog()).getByRole('button', { name: 'Save changes' }))

    expect(await within(openDialog()).findByText('A clinic with that name already exists.')).toBeInTheDocument()
    expect(within(openDialog()).getByText('The clinic was not changed')).toBeInTheDocument()
    expect(screen.queryByText('The clinic’s details were saved.')).not.toBeInTheDocument()
  })

  it('sends nothing when nothing changed', async () => {
    const user = userEvent.setup()
    renderAt('/platform/clinics/clinic-1')
    await user.click(await screen.findByRole('button', { name: 'Edit clinic' }))
    await user.click(within(openDialog()).getByRole('button', { name: 'Save changes' }))
    expect(within(openDialog()).getByText('Nothing has changed, so there is nothing to save.')).toBeInTheDocument()
    expect(api.renameClinic).not.toHaveBeenCalled()
  })
})
