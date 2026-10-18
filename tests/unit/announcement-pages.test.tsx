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
 * Clinic Admin reads it but has nothing to press on it - the database would
 * refuse them - and patients and doctors see which notices come from
 * RecoverEase. The data layer is replaced; tests/unit/announcements-api.test.ts
 * covers what it sends, and tests/db/super-admin.test.ts what the database
 * allows.
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

vi.mock('@/features/auth/auth-context', () => ({
  useCurrentUser: () => ({
    userId: 'admin-user',
    role: 'admin',
    profile: { kind: 'admin', admin: { admin_id: 'admin-1' } },
  }),
}))

const { AdminAnnouncementsPage } = await import(
  '@/features/announcements/pages/admin-announcements-page'
)
const { AnnouncementsPage } = await import('@/features/announcements/pages/announcements-page')

const CLINIC_PUBLISHED = {
  announcement_id: 'ann-clinic',
  admin_id: 'admin-1',
  super_admin_id: null,
  clinic_id: 'clinic-1',
  announcement_title: 'Clinic hours',
  announcement_content: 'Open 8am to 5pm on weekdays.',
  announcement_published_at: '2026-10-01T00:00:00Z',
  announcement_created_at: '2026-10-01T00:00:00Z',
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
  super_admin_id: 'sa-1',
  clinic_id: null,
  announcement_title: 'Planned maintenance',
  announcement_content: 'RecoverEase will be briefly unavailable on Sunday night.',
  announcement_published_at: '2026-10-02T00:00:00Z',
  announcement_created_at: '2026-10-02T00:00:00Z',
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

  it('says its announcements reach the clinic, and so does its empty state', async () => {
    api.fetchAnnouncements.mockResolvedValue([])
    renderPage(<AdminAnnouncementsPage />)

    expect(
      screen.getByText('Notices for everyone in your clinic, with any notices from RecoverEase.'),
    ).toBeInTheDocument()
    expect(await screen.findByText('Create one to notify everyone in your clinic.')).toBeInTheDocument()
  })
})

describe('the patient’s and doctor’s announcements', () => {
  it('says which notices come from RecoverEase and which from the clinic, with nothing to press', async () => {
    api.fetchAnnouncements.mockResolvedValue([PLATFORM, CLINIC_PUBLISHED])
    renderPage(<AnnouncementsPage />)

    const platform = await notice('Planned maintenance')
    const clinic = await notice('Clinic hours')

    expect(within(platform).getByText(/From RecoverEase/)).toBeInTheDocument()
    expect(within(platform).queryByText(/From your clinic/)).not.toBeInTheDocument()
    expect(within(clinic).getByText(/From your clinic/)).toBeInTheDocument()
    expect(within(clinic).queryByText(/From RecoverEase/)).not.toBeInTheDocument()
    expect(screen.queryAllByRole('button')).toEqual([])
  })

  it('names both sources in its description and its empty state', async () => {
    api.fetchAnnouncements.mockResolvedValue([])
    renderPage(<AnnouncementsPage />)

    expect(screen.getByText('Notices from your clinic and from RecoverEase.')).toBeInTheDocument()
    expect(
      await screen.findByText('Notices from your clinic and from RecoverEase will appear here.'),
    ).toBeInTheDocument()
  })
})
