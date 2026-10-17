import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The platform console's pages, behind the authenticator gate: clinics and
 * their Clinic Admins, platform announcements, and the platform audit log.
 *
 * The data layer is replaced; tests/unit/platform-api.test.ts covers what it
 * sends, and tests/db/super-admin.test.ts what the database allows.
 */

const api = vi.hoisted(() => ({
  fetchClinics: vi.fn(),
  createClinic: vi.fn(),
  setClinicStatus: vi.fn(),
  createClinicAdmin: vi.fn(),
  fetchPlatformAnnouncements: vi.fn(),
  createPlatformAnnouncement: vi.fn(),
  updatePlatformAnnouncement: vi.fn(),
  setPlatformAnnouncementPublished: vi.fn(),
  deletePlatformAnnouncement: vi.fn(),
  fetchPlatformAudit: vi.fn(),
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

const { PlatformClinicsPage } = await import(
  '@/features/platform/pages/platform-clinics-page'
)
const { PlatformAnnouncementsPage } = await import(
  '@/features/platform/pages/platform-announcements-page'
)
const { PlatformAuditPage } = await import('@/features/platform/pages/platform-audit-page')
const { AUDIT_PAGE_SIZE } = await import('@/features/platform/api')

function renderPage(page: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{page}</MemoryRouter>
    </QueryClientProvider>,
  )
}

const HARBOR = {
  clinic_id: 'clinic-1',
  clinic_name: 'Harbor Clinic',
  clinic_status: 'active' as const,
  clinic_timezone: 'Asia/Manila',
  clinic_created_at: '2026-10-01T00:00:00Z',
  clinic_updated_at: '2026-10-01T00:00:00Z',
  clinic_admin_count: 1,
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
  api.fetchClinics.mockResolvedValue([HARBOR])
  api.fetchPlatformAnnouncements.mockResolvedValue([])
  api.fetchPlatformAudit.mockResolvedValue([])
})

function openDialog(): HTMLElement {
  const dialog = document.querySelector('dialog[open]')
  if (!(dialog instanceof HTMLElement)) throw new Error('No dialog is open')
  return dialog
}

describe('clinics', () => {
  it("lists each clinic's status, zone and Clinic Admins", async () => {
    renderPage(<PlatformClinicsPage />)

    expect(await screen.findByRole('heading', { name: 'Harbor Clinic' })).toBeInTheDocument()
    expect(screen.getByText(/Asia\/Manila · 1 Clinic Admin/)).toBeInTheDocument()
    expect(screen.getByText('Active')).toBeInTheDocument()
  })

  it('refuses a time zone that is not one before anything is sent', async () => {
    const user = userEvent.setup()
    renderPage(<PlatformClinicsPage />)

    await user.click(await screen.findByRole('button', { name: 'New clinic' }))
    const dialog = openDialog()
    await user.type(within(dialog).getByLabelText(/Clinic name/), 'Second Clinic')
    await user.type(within(dialog).getByLabelText(/Time zone/), 'Mars/Olympus')
    await user.click(within(dialog).getByRole('button', { name: 'Create clinic' }))

    expect(within(dialog).getByLabelText(/Time zone/)).toHaveAttribute('aria-invalid', 'true')
    expect(within(dialog).getByLabelText(/Time zone/)).toHaveFocus()
    expect(api.createClinic).not.toHaveBeenCalled()
  })

  it('creates a clinic with the canonical zone name', async () => {
    api.createClinic.mockResolvedValue({ ...HARBOR, clinic_id: 'clinic-2', clinic_name: 'Bay Clinic' })
    const user = userEvent.setup()
    renderPage(<PlatformClinicsPage />)

    await user.click(await screen.findByRole('button', { name: 'New clinic' }))
    const dialog = openDialog()
    await user.type(within(dialog).getByLabelText(/Clinic name/), '  Bay Clinic ')
    await user.type(within(dialog).getByLabelText(/Time zone/), 'asia/singapore')
    await user.click(within(dialog).getByRole('button', { name: 'Create clinic' }))

    await waitFor(() =>
      expect(api.createClinic).toHaveBeenCalledWith({
        name: 'Bay Clinic',
        timezone: 'Asia/Singapore',
      }),
    )
  })

  it('shows why a second clinic cannot be created while the single-clinic gate stands', async () => {
    api.createClinic.mockRejectedValue(
      new Error(
        'RecoverEase is set up for one clinic for now, so another clinic cannot be added yet.',
      ),
    )
    const user = userEvent.setup()
    renderPage(<PlatformClinicsPage />)

    await user.click(await screen.findByRole('button', { name: 'New clinic' }))
    const dialog = openDialog()
    await user.type(within(dialog).getByLabelText(/Clinic name/), 'Bay Clinic')
    await user.type(within(dialog).getByLabelText(/Time zone/), 'Asia/Manila')
    await user.click(within(dialog).getByRole('button', { name: 'Create clinic' }))

    expect(
      await within(dialog).findByText(/set up for one clinic for now/),
    ).toBeInTheDocument()
  })

  it('asks before deactivating, and says nothing is deleted', async () => {
    api.setClinicStatus.mockResolvedValue({ ...HARBOR, clinic_status: 'inactive' })
    const user = userEvent.setup()
    renderPage(<PlatformClinicsPage />)

    await user.click(await screen.findByRole('button', { name: 'Deactivate Harbor Clinic' }))
    const dialog = openDialog()
    expect(within(dialog).getByText(/doctors, patients and records stay exactly as they are/)).toBeInTheDocument()
    expect(api.setClinicStatus).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole('button', { name: 'Deactivate' }))
    await waitFor(() =>
      expect(api.setClinicStatus).toHaveBeenCalledWith('clinic-1', 'inactive'),
    )
  })

  it('offers no new Clinic Admin for an inactive clinic', async () => {
    api.fetchClinics.mockResolvedValue([{ ...HARBOR, clinic_status: 'inactive' }])
    renderPage(<PlatformClinicsPage />)

    expect(await screen.findByRole('button', { name: 'Reactivate Harbor Clinic' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Add Clinic Admin/ })).not.toBeInTheDocument()
  })
})

describe('adding a Clinic Admin', () => {
  async function fillAndSubmit() {
    const user = userEvent.setup()
    renderPage(<PlatformClinicsPage />)
    await user.click(
      await screen.findByRole('button', { name: 'Add Clinic Admin to Harbor Clinic' }),
    )
    const dialog = openDialog()
    await user.type(within(dialog).getByLabelText(/First name/), 'Ana')
    await user.type(within(dialog).getByLabelText(/Last name/), 'Cruz')
    await user.type(within(dialog).getByLabelText(/Email/), 'Ana@Harbor.test')
    await user.click(within(dialog).getByRole('button', { name: 'Add Clinic Admin' }))
    return dialog
  }

  it('says the setup email went, and shows no password', async () => {
    api.createClinicAdmin.mockResolvedValue({
      userId: 'u-2',
      profileId: 'admin-2',
      clinicId: 'clinic-1',
      setupEmailSent: true,
    })

    const dialog = await fillAndSubmit()

    expect(await within(dialog).findByText('Clinic Admin added')).toBeInTheDocument()
    expect(dialog).toHaveTextContent(
      'Ana Cruz can now administer Harbor Clinic. We have emailed ana@harbor.test a link to choose their password.',
    )
    expect(dialog).not.toHaveTextContent(/temporary password/i)
    expect(within(dialog).queryByRole('button', { name: /copy/i })).not.toBeInTheDocument()
    expect(api.createClinicAdmin).toHaveBeenCalledWith({
      clinicId: 'clinic-1',
      firstName: 'Ana',
      lastName: 'Cruz',
      email: 'ana@harbor.test',
    })
  })

  it('names the way to send the email again when it did not go', async () => {
    api.createClinicAdmin.mockResolvedValue({
      userId: 'u-2',
      profileId: 'admin-2',
      clinicId: 'clinic-1',
      setupEmailSent: false,
    })

    const dialog = await fillAndSubmit()

    expect(
      await within(dialog).findByText('Clinic Admin added, but the email did not go'),
    ).toBeInTheDocument()
    expect(dialog).toHaveTextContent(/Forgot password.*ana@harbor\.test/)
  })

  it('says what is missing, beside its field, before anything is sent', async () => {
    const user = userEvent.setup()
    renderPage(<PlatformClinicsPage />)
    await user.click(
      await screen.findByRole('button', { name: 'Add Clinic Admin to Harbor Clinic' }),
    )
    const dialog = openDialog()
    await user.type(within(dialog).getByLabelText(/Email/), 'not-an-address')
    await user.click(within(dialog).getByRole('button', { name: 'Add Clinic Admin' }))

    expect(within(dialog).getByText('Enter their first name.')).toBeInTheDocument()
    expect(within(dialog).getByText('Enter their last name.')).toBeInTheDocument()
    expect(
      within(dialog).getByText('Enter an email address, such as name@example.com.'),
    ).toBeInTheDocument()
    expect(within(dialog).getByLabelText(/First name/)).toHaveFocus()
    expect(api.createClinicAdmin).not.toHaveBeenCalled()
  })
})

describe('platform announcements', () => {
  const DRAFT = {
    announcement_id: 'ann-1',
    announcement_title: 'Maintenance',
    announcement_content: 'Sunday night.',
    announcement_published_at: null,
    announcement_created_at: '2026-10-10T00:00:00Z',
  }

  it('edits one in place, by its id', async () => {
    api.fetchPlatformAnnouncements.mockResolvedValue([DRAFT])
    api.updatePlatformAnnouncement.mockResolvedValue(undefined)
    const user = userEvent.setup()
    renderPage(<PlatformAnnouncementsPage />)

    await user.click(await screen.findByRole('button', { name: 'Edit: Maintenance' }))
    const dialog = openDialog()
    const message = within(dialog).getByLabelText(/Message/)
    expect(message).toHaveValue('Sunday night.')
    await user.clear(message)
    await user.type(message, 'Saturday night.')
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() =>
      expect(api.updatePlatformAnnouncement).toHaveBeenCalledWith({
        announcementId: 'ann-1',
        title: 'Maintenance',
        content: 'Saturday night.',
      }),
    )
    expect(api.createPlatformAnnouncement).not.toHaveBeenCalled()
  })

  it('publishes a draft, and deletes only after asking', async () => {
    api.fetchPlatformAnnouncements.mockResolvedValue([DRAFT])
    api.setPlatformAnnouncementPublished.mockResolvedValue(undefined)
    api.deletePlatformAnnouncement.mockResolvedValue(undefined)
    const user = userEvent.setup()
    renderPage(<PlatformAnnouncementsPage />)

    await user.click(await screen.findByRole('button', { name: 'Publish now: Maintenance' }))
    await waitFor(() =>
      expect(api.setPlatformAnnouncementPublished).toHaveBeenCalledWith('ann-1', true),
    )

    await user.click(screen.getByRole('button', { name: 'Delete: Maintenance' }))
    expect(api.deletePlatformAnnouncement).not.toHaveBeenCalled()
    await user.click(within(openDialog()).getByRole('button', { name: 'Delete permanently' }))
    await waitFor(() => expect(api.deletePlatformAnnouncement).toHaveBeenCalledWith('ann-1'))
  })
})

describe('the platform audit log', () => {
  function entry(index: number) {
    return {
      audit_log_id: `entry-${String(index).padStart(3, '0')}`,
      audit_log_timestamp: new Date(Date.UTC(2026, 9, 10, 0, 0, 0) - index * 60_000).toISOString(),
      audit_log_action: index === 0 ? 'update' : 'insert',
      audit_log_entity: 'clinic',
      audit_log_entity_id: 'clinic-1',
      clinic_id: 'clinic-1',
      actor_user_id: index === 0 ? 'super-user' : 'a1b2c3d4-0000-4000-8000-000000000000',
      audit_log_details: index === 0 ? { changed_columns: ['clinic_status'] } : null,
    }
  }

  it("shows what changed by field name, the clinic's name, and who", async () => {
    api.fetchPlatformAudit.mockResolvedValue([entry(0), entry(1)])
    renderPage(<PlatformAuditPage />)

    const table = await screen.findByRole('table', {
      name: 'Platform audit entries, most recent first',
    })
    const [, first, second] = within(table).getAllByRole('row')
    expect(first).toHaveTextContent('Changed')
    expect(first).toHaveTextContent('Harbor Clinic')
    expect(first).toHaveTextContent('You')
    expect(first).toHaveTextContent('status')
    expect(second).toHaveTextContent('a1b2c3d4')
    expect(screen.getByText(/That is every entry/)).toBeInTheDocument()
  })

  it('loads older entries after the last one shown', async () => {
    const firstPage = Array.from({ length: AUDIT_PAGE_SIZE }, (_, index) => entry(index))
    api.fetchPlatformAudit
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([entry(AUDIT_PAGE_SIZE)])
    const user = userEvent.setup()
    renderPage(<PlatformAuditPage />)

    await user.click(await screen.findByRole('button', { name: 'Load older entries' }))

    await waitFor(() => expect(api.fetchPlatformAudit).toHaveBeenCalledTimes(2))
    const last = firstPage[firstPage.length - 1]!
    expect(api.fetchPlatformAudit).toHaveBeenLastCalledWith({
      timestamp: last.audit_log_timestamp,
      id: last.audit_log_id,
    })
    expect(await screen.findByText(`Showing ${AUDIT_PAGE_SIZE + 1} entries. That is every entry.`)).toBeInTheDocument()
  })
})
