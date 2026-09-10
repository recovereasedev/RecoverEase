import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { useDocumentTitle } from '@/hooks/use-document-title'

/**
 * F-02 — every signed-in page names itself in the browser tab.
 *
 * `useDocumentTitle` already existed and worked; it had four callers, all on
 * the unauthenticated screens. Every one of the 22 pages behind the sign-in
 * showed the same "RecoverEase", so a screen reader announced the same title
 * on every navigation, browser history was 22 identical entries, and a
 * clinician with several tabs open could not tell them apart. That is WCAG
 * 2.4.2 "Page Titled" (Level A).
 *
 * These test two different things, deliberately:
 *
 *  - the hook's runtime contract, exercised against the real `document.title`;
 *  - that every registered route actually calls it, read from the source.
 *
 * The second is a coverage audit rather than 22 render tests. Rendering each
 * page would mean mocking each page's data layer, and the assertion would
 * then be about the mocks. Reading the source answers the question the
 * finding actually asked — is any route still nameless — and it cannot drift
 * as pages gain dependencies.
 */

// Vitest runs from the repository root, so the source tree is found there.
const PAGES_ROOT = resolve(process.cwd(), 'src/features')

/** Every route in `router.tsx`, and the page component it renders. */
const ROUTES: { path: string; page: string; file: string; title: string | null }[] = [
  // Public. The landing page deliberately keeps the base title: it is the
  // application's own home page, which is what "RecoverEase" names.
  { path: '/', page: 'LandingPage', file: 'marketing/pages/landing-page.tsx', title: null },
  { path: '/sign-in', page: 'SignInPage', file: 'auth/pages/sign-in-page.tsx', title: 'Sign In' },
  { path: '/forgot-password', page: 'ForgotPasswordPage', file: 'auth/pages/forgot-password-page.tsx', title: 'Reset Password' },
  { path: '/reset-password', page: 'ResetPasswordPage', file: 'auth/pages/reset-password-page.tsx', title: 'New Password' },

  // Patient.
  { path: '/patient', page: 'PatientDashboard', file: 'dashboard/pages/patient-dashboard.tsx', title: 'Dashboard' },
  { path: '/patient/recovery', page: 'RecoveryPage', file: 'recovery-logs/pages/recovery-page.tsx', title: 'My Recovery' },
  { path: '/patient/treatment', page: 'PatientTreatmentPage', file: 'treatment-plans/pages/patient-treatment-page.tsx', title: 'Treatment Plan' },
  { path: '/patient/medications', page: 'PatientMedicationsPage', file: 'medications/pages/patient-medications-page.tsx', title: 'Medications' },
  { path: '/patient/appointments', page: 'PatientAppointmentsPage', file: 'appointments/pages/patient-appointments-page.tsx', title: 'Appointments' },
  { path: '/patient/chat', page: 'PatientChatPage', file: 'chat/pages/patient-chat-page.tsx', title: 'Guidance Chat' },
  { path: '/patient/notifications', page: 'NotificationsPage', file: 'notifications/pages/notifications-page.tsx', title: 'Notifications' },
  { path: '/patient/announcements', page: 'AnnouncementsPage', file: 'announcements/pages/announcements-page.tsx', title: 'Announcements' },
  { path: '/patient/profile', page: 'PatientProfilePage', file: 'patients/pages/patient-profile-page.tsx', title: 'My Profile' },

  // Doctor.
  { path: '/doctor', page: 'DoctorDashboard', file: 'dashboard/pages/doctor-dashboard.tsx', title: 'Dashboard' },
  { path: '/doctor/patients', page: 'DoctorPatientsPage', file: 'patients/pages/doctor-patients-page.tsx', title: 'Patients' },
  { path: '/doctor/patients/:patientId', page: 'DoctorPatientDetailPage', file: 'patients/pages/doctor-patient-detail-page.tsx', title: 'Patient Record' },
  { path: '/doctor/appointments', page: 'DoctorAppointmentsPage', file: 'appointments/pages/doctor-appointments-page.tsx', title: 'Appointments' },
  { path: '/doctor/reports', page: 'DoctorReportsPage', file: 'reports/pages/doctor-reports-page.tsx', title: 'Reports' },
  { path: '/doctor/notifications', page: 'NotificationsPage', file: 'notifications/pages/notifications-page.tsx', title: 'Notifications' },
  { path: '/doctor/profile', page: 'DoctorProfilePage', file: 'patients/pages/doctor-profile-page.tsx', title: 'My Profile' },

  // Administrator.
  { path: '/admin', page: 'AdminDashboard', file: 'dashboard/pages/admin-dashboard.tsx', title: 'Dashboard' },
  { path: '/admin/doctors', page: 'AdminDoctorsPage', file: 'patients/pages/admin-doctors-page.tsx', title: 'Doctor Accounts' },
  { path: '/admin/announcements', page: 'AdminAnnouncementsPage', file: 'announcements/pages/admin-announcements-page.tsx', title: 'Announcements' },
  { path: '/admin/audit', page: 'AuditLogPage', file: 'audit-logs/pages/audit-log-page.tsx', title: 'Audit Log' },
  { path: '/admin/reports', page: 'AdminReportsPage', file: 'reports/pages/admin-reports-page.tsx', title: 'Reports' },
  { path: '/admin/notifications', page: 'NotificationsPage', file: 'notifications/pages/notifications-page.tsx', title: 'Notifications' },
  { path: '/admin/settings', page: 'SystemSettingsPage', file: 'system-settings/pages/system-settings-page.tsx', title: 'System Settings' },
  { path: '/admin/profile', page: 'AdminProfilePage', file: 'system-settings/pages/admin-profile-page.tsx', title: 'My Profile' },
]

/** The 404 screen lives with the route guards, not under `features/`. */
const NOT_FOUND_SOURCE = resolve(process.cwd(), 'src/app/routes/guards.tsx')

function sourceOf(file: string): string {
  return readFileSync(`${PAGES_ROOT}/${file}`, 'utf8')
}

/** The literal a page passes to the hook, or null when it does not call it. */
function declaredTitle(file: string): string | null {
  const match = sourceOf(file).match(/useDocumentTitle\('([^']*)'\)/)
  return match ? (match[1] as string) : null
}

const authenticated = ROUTES.filter((route) => route.path.match(/^\/(patient|doctor|admin)/))

afterEach(() => {
  document.title = 'RecoverEase'
})

describe('the document title hook', () => {
  it('names the tab while a page is mounted', () => {
    function Page() {
      useDocumentTitle('Appointments')
      return null
    }
    render(<Page />)

    expect(document.title).toBe('RecoverEase | Appointments')
  })

  it('gives the base title back when the page unmounts', () => {
    function Page() {
      useDocumentTitle('Patient Record')
      return null
    }
    const { unmount } = render(<Page />)
    expect(document.title).toBe('RecoverEase | Patient Record')

    unmount()

    // A page that names nothing must not inherit the last page's name.
    expect(document.title).toBe('RecoverEase')
  })

  it('changes the title when navigation swaps the page', () => {
    // The stuck-title case: the second page's title has to win, not the
    // first one's cleanup.
    function Harness() {
      const [page, setPage] = useState<'patients' | 'reports'>('patients')
      return (
        <>
          <button onClick={() => setPage('reports')}>go</button>
          {page === 'patients' ? <Patients /> : <Reports />}
        </>
      )
    }
    function Patients() {
      useDocumentTitle('Patients')
      return null
    }
    function Reports() {
      useDocumentTitle('Reports')
      return null
    }

    const { getByText } = render(<Harness />)
    expect(document.title).toBe('RecoverEase | Patients')

    // Through fireEvent, so React commits the swap and both effects run
    // before the assertion — no waiting, no timers.
    fireEvent.click(getByText('go'))

    expect(document.title).toBe('RecoverEase | Reports')
  })

  it('follows a title that changes while the page stays mounted', () => {
    function Page({ title }: { title: string }) {
      useDocumentTitle(title)
      return null
    }
    const { rerender } = render(<Page title="Dashboard" />)
    expect(document.title).toBe('RecoverEase | Dashboard')

    rerender(<Page title="Notifications" />)

    expect(document.title).toBe('RecoverEase | Notifications')
  })

  it('leaves one title behind, not a stack of them', () => {
    // Two pages mounted and unmounted in turn must not compound: the tab is
    // named once, and ends where it started.
    function Page({ title }: { title: string }) {
      useDocumentTitle(title)
      return null
    }
    const first = render(<Page title="Medications" />)
    first.unmount()
    const second = render(<Page title="Audit Log" />)
    expect(document.title).toBe('RecoverEase | Audit Log')
    second.unmount()

    expect(document.title).toBe('RecoverEase')
    expect(document.title).not.toContain('|')
  })
})

describe('every route names itself', () => {
  it.each(authenticated.map((route) => [route.path, route.file, route.title]))(
    '%s is titled',
    (_path, file, title) => {
      expect(declaredTitle(file as string)).toBe(title)
    },
  )

  it('leaves no signed-in route on the generic fallback', () => {
    // The finding itself, as an assertion: 22 pages showed "RecoverEase".
    const nameless = authenticated.filter((route) => declaredTitle(route.file) === null)

    expect(nameless.map((route) => route.path)).toEqual([])
  })

  it('keeps the titles the auth screens already had', () => {
    expect(declaredTitle('auth/pages/sign-in-page.tsx')).toBe('Sign In')
    expect(declaredTitle('auth/pages/forgot-password-page.tsx')).toBe('Reset Password')
    expect(declaredTitle('auth/pages/reset-password-page.tsx')).toBe('New Password')
    expect(readFileSync(NOT_FOUND_SOURCE, 'utf8')).toContain(
      "useDocumentTitle('Page Not Found')",
    )
  })

  it('leaves the landing page on the base title, deliberately', () => {
    // "RecoverEase" is the correct name for the application's own home page,
    // and the hook documents that as the default it restores to.
    expect(declaredTitle('marketing/pages/landing-page.tsx')).toBeNull()
  })

  it('covers every page component the router can render', () => {
    // Guards against a route being added later with no title: the inventory
    // above must account for every lazily loaded page.
    const lazyPages = resolve(process.cwd(), 'src/app/routes/lazy-pages.ts')
    const exported = [...readFileSync(lazyPages, 'utf8').matchAll(/export const (\w+)/g)]
      .map((match) => match[1] as string)
      .sort()
    const covered = [...new Set(ROUTES.map((route) => route.page))].sort()

    expect(covered).toEqual(exported)
  })
})

describe('titles are safe to show in a tab and in history', () => {
  it('says "Patient Record" rather than naming the patient', () => {
    // A browser tab, and every entry in browser history, is visible to
    // anyone glancing at the screen — including other patients in a clinic
    // room. The record's own heading names them; the tab does not need to.
    const source = sourceOf('patients/pages/doctor-patient-detail-page.tsx')

    expect(declaredTitle('patients/pages/doctor-patient-detail-page.tsx')).toBe(
      'Patient Record',
    )
    expect(source).not.toMatch(/useDocumentTitle\(`/)
    expect(source).not.toMatch(/useDocumentTitle\([^')]*fullName/)
  })

  it('passes a plain literal on every page, never interpolated data', () => {
    // No template literal anywhere means no name, email, id or clinical
    // value can reach the tab by accident.
    for (const route of ROUTES) {
      const source = sourceOf(route.file)
      expect(
        source.match(/useDocumentTitle\([^)]*\)/g) ?? [],
        `${route.path} interpolates into its title`,
      ).toEqual(route.title === null ? [] : [`useDocumentTitle('${route.title}')`])
    }
  })

  it('contains nothing that looks like an identifier or a secret', () => {
    // A value, not a word. "Reset Password" is the name of a page and stays;
    // what must never appear is an address, a token, or any part of a record
    // id or clinical figure.
    const forbidden = /@|token|jwt|secret|bearer|[0-9a-f]{8}-[0-9a-f]{4}|\d{3,}/i

    for (const route of ROUTES) {
      if (route.title === null) continue
      expect(route.title, `${route.path} title`).not.toMatch(forbidden)
    }
  })

  it('keeps credential wording off the signed-in pages', () => {
    // The auth screens are named for the credential task they perform, which
    // is correct there. No page behind the sign-in should be.
    for (const route of authenticated) {
      expect(route.title, `${route.path} title`).not.toMatch(/password|sign in/i)
    }
  })
})
