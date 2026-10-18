import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The clinic's announcement screens with a platform announcement among the
 * clinic's own.
 *
 * A platform announcement is RecoverEase's, written by a Super Admin. The
 * Clinic Admin and the doctors read it but have nothing to press on it - the
 * database would refuse them - and patients see which notices come from
 * RecoverEase. A doctor writes their clinic's announcements and manages only
 * their own (migration 36). The data layer is replaced;
 * tests/unit/announcements-api.test.ts covers what it sends, and
 * tests/db/super-admin.test.ts and tests/db/doctor-announcements.test.ts what
 * the database allows.
 */

const api = vi.hoisted(() => ({
  fetchAnnouncements: vi.fn(),
  createAnnouncement: vi.fn(),
  setAnnouncementPublished: vi.fn(),
  deleteAnnouncement: vi.fn(),
}))

vi.mock('@/features/announcements/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/announcements/api')>()),
  ...api,
}))

const ADMIN_USER = {
  userId: 'admin-user',
  role: 'admin',
  profile: { kind: 'admin', admin: { admin_id: 'admin-1' } },
}

const DOCTOR_USER = {
  userId: 'doctor-user',
  role: 'doctor',
  profile: { kind: 'doctor', doctor: { doc_id: 'doc-1' } },
}

const auth = vi.hoisted(() => ({ user: null as unknown }))

vi.mock('@/features/auth/auth-context', () => ({
  useCurrentUser: () => auth.user,
}))

const { AdminAnnouncementsPage } = await import(
  '@/features/announcements/pages/admin-announcements-page'
)
const { AnnouncementsPage } = await import('@/features/announcements/pages/announcements-page')
const { DoctorAnnouncementsPage } = await import(
  '@/features/announcements/pages/doctor-announcements-page'
)

const CLINIC_PUBLISHED = {
  announcement_id: 'ann-clinic',
  admin_id: 'admin-1',
  doc_id: null,
  super_admin_id: null,
  clinic_id: 'clinic-1',
  announcement_title: 'Clinic hours',
  announcement_content: 'Open 8am to 5pm on weekdays.',
  announcement_published_at: '2026-10-01T00:00:00Z',
  announcement_created_at: '2026-10-01T00:00:00Z',
  doctor: null,
}

const CLINIC_DRAFT = {
  ...CLINIC_PUBLISHED,
  announcement_id: 'ann-draft',
  announcement_title: 'Holiday closure',
  announcement_content: 'Closed on the public holiday.',
  announcement_published_at: null,
}

const PLATFORM = {
  announcement_id: 'ann-platform',
  admin_id: null,
  doc_id: null,
  super_admin_id: 'sa-1',
  clinic_id: null,
  announcement_title: 'Planned maintenance',
  announcement_content: 'RecoverEase will be briefly unavailable on Sunday night.',
  announcement_published_at: '2026-10-02T00:00:00Z',
  announcement_created_at: '2026-10-02T00:00:00Z',
  doctor: null,
}

/** A doctor's own, published, and a draft of theirs: for their patients. */
const DOCTOR_OWN = {
  ...CLINIC_PUBLISHED,
  announcement_id: 'ann-own',
  admin_id: null,
  doc_id: 'doc-1',
  announcement_title: 'Wound care clinic',
  announcement_content: 'Walk-in wound checks on Thursdays.',
  doctor: { doc_first_name: 'Alan', doc_last_name: 'Cruz' },
}

const DOCTOR_OWN_DRAFT = {
  ...DOCTOR_OWN,
  announcement_id: 'ann-own-draft',
  announcement_title: 'Leave next week',
  announcement_content: 'Another doctor covers my patients.',
  announcement_published_at: null,
}

const NOT_CHANGED =
  'This announcement was not changed. It may have been deleted already, or it is not one your clinic can change.'
const NOT_DELETED =
  'This announcement was not deleted. It may have been deleted already, or it is not one your clinic can delete.'

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

/** The notice with this title, as its own article. */
async function notice(title: string): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { name: title })
  const article = heading.closest('article')
  if (!article) throw new Error(`"${title}" is not in an article`)
  return article
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
  auth.user = ADMIN_USER
  api.fetchAnnouncements.mockResolvedValue([PLATFORM, CLINIC_PUBLISHED, CLINIC_DRAFT])
})

describe('the Clinic Admin’s announcements', () => {
  it('shows RecoverEase’s announcement as RecoverEase’s, with nothing to press', async () => {
    renderPage(<AdminAnnouncementsPage />)
    const platform = await notice('Planned maintenance')

    expect(within(platform).getByText('From RecoverEase')).toBeInTheDocument()
    expect(within(platform).getByText(/only RecoverEase can change or remove/i)).toBeInTheDocument()
    expect(within(platform).queryAllByRole('button')).toEqual([])
    expect(within(platform).queryByText('Published')).not.toBeInTheDocument()
  })

  it('keeps Publish, Unpublish and Delete on the clinic’s own announcements', async () => {
    renderPage(<AdminAnnouncementsPage />)
    const published = await notice('Clinic hours')
    const draft = await notice('Holiday closure')

    expect(within(published).getByRole('button', { name: 'Unpublish' })).toBeInTheDocument()
    expect(within(published).getByRole('button', { name: /^Delete/ })).toBeInTheDocument()
    expect(within(published).getByText('Published')).toBeInTheDocument()
    expect(within(draft).getByRole('button', { name: 'Publish now' })).toBeInTheDocument()
    expect(within(draft).getByText('Draft')).toBeInTheDocument()
    for (const own of [published, draft]) {
      expect(within(own).queryByText('From RecoverEase')).not.toBeInTheDocument()
    }
  })

  it('still publishes the clinic’s own announcement', async () => {
    api.setAnnouncementPublished.mockResolvedValue(undefined)
    renderPage(<AdminAnnouncementsPage />)
    const draft = await notice('Holiday closure')

    await userEvent.click(within(draft).getByRole('button', { name: 'Publish now' }))

    await waitFor(() => expect(api.setAnnouncementPublished).toHaveBeenCalledTimes(1))
    expect(api.setAnnouncementPublished.mock.calls[0]?.slice(0, 2)).toEqual(['ann-draft', true])
    await waitFor(() => expect(api.fetchAnnouncements).toHaveBeenCalledTimes(2))
    expect(screen.queryByText(/was not published/)).not.toBeInTheDocument()
  })

  it('says so, beside the announcement, when unpublishing changed nothing', async () => {
    api.setAnnouncementPublished.mockRejectedValue(new Error(NOT_CHANGED))
    renderPage(<AdminAnnouncementsPage />)
    const published = await notice('Clinic hours')

    await userEvent.click(within(published).getByRole('button', { name: 'Unpublish' }))

    expect(await within(published).findByText('The announcement was not unpublished')).toBeInTheDocument()
    expect(within(published).getByText(NOT_CHANGED)).toBeInTheDocument()
    expect(within(published).getByText('Published')).toBeInTheDocument()
  })

  it('says so when a delete removed nothing, and leaves the announcement listed', async () => {
    api.deleteAnnouncement.mockRejectedValue(new Error(NOT_DELETED))
    renderPage(<AdminAnnouncementsPage />)
    const published = await notice('Clinic hours')

    await userEvent.click(within(published).getByRole('button', { name: /^Delete/ }))
    await userEvent.click(within(openDialog()).getByRole('button', { name: 'Delete permanently' }))

    expect(await within(openDialog()).findByText('The announcement was not deleted')).toBeInTheDocument()
    expect(within(openDialog()).getByText(NOT_DELETED)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Clinic hours' })).toBeInTheDocument()
  })

  it('manages a doctor’s announcement of the clinic like its own, naming the doctor and whom it reaches', async () => {
    api.fetchAnnouncements.mockResolvedValue([DOCTOR_OWN])
    renderPage(<AdminAnnouncementsPage />)
    const doctors = await notice('Wound care clinic')

    expect(within(doctors).getByText('By Dr Alan Cruz, for their patients')).toBeInTheDocument()
    expect(within(doctors).getByRole('button', { name: 'Unpublish' })).toBeInTheDocument()
    expect(within(doctors).getByRole('button', { name: /^Delete/ })).toBeInTheDocument()
    expect(within(doctors).queryByText('From your clinic')).not.toBeInTheDocument()
  })

  it('still says a doctor wrote it when the name cannot be read', async () => {
    api.fetchAnnouncements.mockResolvedValue([{ ...DOCTOR_OWN, doctor: null }])
    renderPage(<AdminAnnouncementsPage />)

    expect(
      within(await notice('Wound care clinic')).getByText('By A doctor, for their patients'),
    ).toBeInTheDocument()
  })

  it('names no author on its own or RecoverEase’s', async () => {
    renderPage(<AdminAnnouncementsPage />)

    for (const title of ['Clinic hours', 'Planned maintenance']) {
      expect(within(await notice(title)).queryByText(/for their patients/)).not.toBeInTheDocument()
    }
  })

  it('writes a new announcement as the Clinic Admin', async () => {
    api.fetchAnnouncements.mockResolvedValue([])
    api.createAnnouncement.mockResolvedValue({ ...CLINIC_PUBLISHED, announcement_id: 'ann-new' })
    renderPage(<AdminAnnouncementsPage />)

    await userEvent.click(await screen.findByRole('button', { name: 'New announcement' }))
    await userEvent.type(within(openDialog()).getByLabelText(/Title/), 'Clinic closed Friday')
    await userEvent.type(within(openDialog()).getByLabelText(/Message/), 'For the holiday.')
    await userEvent.click(within(openDialog()).getByRole('button', { name: 'Save as draft' }))

    await waitFor(() => expect(api.createAnnouncement).toHaveBeenCalledTimes(1))
    expect(api.createAnnouncement.mock.calls[0]?.[0]).toEqual({
      author: { adminId: 'admin-1' },
      title: 'Clinic closed Friday',
      content: 'For the holiday.',
      publishNow: false,
    })
  })

  it('says whom its announcements reach, and so does its empty state', async () => {
    api.fetchAnnouncements.mockResolvedValue([])
    renderPage(<AdminAnnouncementsPage />)

    expect(
      screen.getByText(
        "Notices for everyone in your clinic, your doctors' notices for their patients, and any notices from RecoverEase.",
      ),
    ).toBeInTheDocument()
    expect(await screen.findByText('Create one to notify everyone in your clinic.')).toBeInTheDocument()
  })
})

describe('a doctor’s announcements', () => {
  beforeEach(() => {
    auth.user = DOCTOR_USER
    // What the database gives a doctor: RecoverEase's, their Clinic Admin's
    // and their own - never a colleague's.
    api.fetchAnnouncements.mockResolvedValue([PLATFORM, CLINIC_PUBLISHED, DOCTOR_OWN, DOCTOR_OWN_DRAFT])
  })

  it('shows RecoverEase’s announcement as RecoverEase’s, with nothing to press', async () => {
    renderPage(<DoctorAnnouncementsPage />)
    const platform = await notice('Planned maintenance')

    expect(within(platform).getByText('From RecoverEase')).toBeInTheDocument()
    expect(within(platform).getByText(/only RecoverEase can change or remove/i)).toBeInTheDocument()
    expect(within(platform).queryAllByRole('button')).toEqual([])
  })

  it('shows the Clinic Admin’s as the clinic’s, with nothing to press', async () => {
    renderPage(<DoctorAnnouncementsPage />)
    const clinic = await notice('Clinic hours')

    expect(within(clinic).getByText('From your clinic')).toBeInTheDocument()
    expect(within(clinic).getByText('Only your Clinic Admin can change or remove this notice.')).toBeInTheDocument()
    expect(within(clinic).queryAllByRole('button')).toEqual([])
  })

  it('marks their own as for their patients, and lets them publish, unpublish and delete only those', async () => {
    api.setAnnouncementPublished.mockResolvedValue(undefined)
    renderPage(<DoctorAnnouncementsPage />)
    const own = await notice('Wound care clinic')
    const draft = await notice('Leave next week')

    for (const mine of [own, draft]) expect(within(mine).getByText('For your patients')).toBeInTheDocument()
    expect(within(await notice('Clinic hours')).queryByText('For your patients')).not.toBeInTheDocument()
    expect(within(own).getByText('Published')).toBeInTheDocument()
    expect(within(own).getByRole('button', { name: 'Unpublish' })).toBeInTheDocument()
    expect(within(own).getByRole('button', { name: /^Delete/ })).toBeInTheDocument()
    expect(within(draft).getByText('Draft')).toBeInTheDocument()

    await userEvent.click(within(draft).getByRole('button', { name: 'Publish now' }))
    await waitFor(() => expect(api.setAnnouncementPublished).toHaveBeenCalledTimes(1))
    expect(api.setAnnouncementPublished.mock.calls[0]?.slice(0, 2)).toEqual(['ann-own-draft', true])
  })

  it('writes a new announcement as the doctor, saying it reaches their patients only', async () => {
    api.createAnnouncement.mockResolvedValue({ ...DOCTOR_OWN, announcement_id: 'ann-new' })
    renderPage(<DoctorAnnouncementsPage />)

    await userEvent.click(await screen.findByRole('button', { name: 'New announcement' }))
    expect(within(openDialog()).getByText(/It reaches your patients only\./)).toBeInTheDocument()
    expect(within(openDialog()).getByText(/nothing about one patient's care/)).toBeInTheDocument()
    await userEvent.type(within(openDialog()).getByLabelText(/Title/), 'Flu shots')
    await userEvent.type(within(openDialog()).getByLabelText(/Message/), 'Available from Monday.')
    await userEvent.click(within(openDialog()).getByRole('button', { name: 'Publish now' }))

    await waitFor(() => expect(api.createAnnouncement).toHaveBeenCalledTimes(1))
    expect(api.createAnnouncement.mock.calls[0]?.[0]).toEqual({
      author: { doctorId: 'doc-1' },
      title: 'Flu shots',
      content: 'Available from Monday.',
      publishNow: true,
    })
  })

  it('speaks of their patients, not the clinic, and so does its empty state', async () => {
    api.fetchAnnouncements.mockResolvedValue([])
    renderPage(<DoctorAnnouncementsPage />)

    expect(
      screen.getByText(
        "Your notices for your patients, with your Clinic Admin's and RecoverEase's. You can change the ones you wrote.",
      ),
    ).toBeInTheDocument()
    expect(await screen.findByText('Create one to notify your patients.')).toBeInTheDocument()
    expect(screen.queryByText(/everyone in your clinic/)).not.toBeInTheDocument()
  })
})

describe('the patient’s announcements', () => {
  it('says which notices come from RecoverEase, the clinic and their doctor, with nothing to press', async () => {
    api.fetchAnnouncements.mockResolvedValue([PLATFORM, CLINIC_PUBLISHED, DOCTOR_OWN])
    renderPage(<AnnouncementsPage />)

    const platform = await notice('Planned maintenance')
    const clinic = await notice('Clinic hours')
    const doctors = await notice('Wound care clinic')

    expect(within(platform).getByText(/From RecoverEase/)).toBeInTheDocument()
    expect(within(clinic).getByText(/From your clinic/)).toBeInTheDocument()
    expect(within(doctors).getByText(/From your doctor/)).toBeInTheDocument()
    expect(within(platform).queryByText(/From your (clinic|doctor)/)).not.toBeInTheDocument()
    expect(within(clinic).queryByText(/From (RecoverEase|your doctor)/)).not.toBeInTheDocument()
    expect(within(doctors).queryByText(/From (RecoverEase|your clinic)/)).not.toBeInTheDocument()
    // A patient is shown neither the doctor's name nor anything to press.
    expect(within(doctors).queryByText(/Cruz/)).not.toBeInTheDocument()
    expect(screen.queryAllByRole('button')).toEqual([])
  })

  it('names all three sources in its description and its empty state', async () => {
    api.fetchAnnouncements.mockResolvedValue([])
    renderPage(<AnnouncementsPage />)

    expect(screen.getByText('Notices from your clinic, your doctor and RecoverEase.')).toBeInTheDocument()
    expect(
      await screen.findByText('Notices from your clinic, your doctor and RecoverEase will appear here.'),
    ).toBeInTheDocument()
  })
})
