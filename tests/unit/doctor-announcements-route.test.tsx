import { isValidElement, type ReactElement } from 'react'
import type { RouteObject } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import { router } from '@/app/router'
import * as Page from '@/app/routes/lazy-pages'
import { navigationFor, primaryMobileNavFor } from '@/app/routes/navigation'

/**
 * Where a doctor finds their announcements (migration 36): a route of their
 * own, behind the doctor's role guard, and an item in their navigation - on
 * the phone's bar too, within its five.
 */

type Props = { children?: unknown; allow?: readonly string[] }

function section(path: string): RouteObject {
  const found = router.routes.find((route) => route.path === path)
  if (!found) throw new Error(`No ${path} section`)
  return found
}

/** The page a section's child route renders, inside its LazyBoundary. */
function pageOf(route: RouteObject | undefined): unknown {
  const boundary = route?.element
  return isValidElement(boundary) ? (boundary as ReactElement<Props>).props.children : undefined
}

/** The roles a section's RequireRole admits. */
function rolesOf(route: RouteObject): readonly string[] | undefined {
  const requireAuth = route.element as ReactElement<Props>
  const requireRole = requireAuth.props.children as ReactElement<Props>
  return requireRole.props.allow
}

describe('the doctor’s announcements route', () => {
  it('renders the doctor’s announcements page, for doctors only', () => {
    const doctor = section('/doctor')
    const announcements = doctor.children?.find((route) => route.path === 'announcements')
    const page = pageOf(announcements)

    expect(isValidElement(page) && page.type).toBe(Page.DoctorAnnouncementsPage)
    expect(rolesOf(doctor)).toEqual(['doctor'])
  })

  it('leaves the patient’s and the Clinic Admin’s announcement pages as they were', () => {
    const patient = pageOf(section('/patient').children?.find((route) => route.path === 'announcements'))
    const admin = pageOf(section('/admin').children?.find((route) => route.path === 'announcements'))

    expect(isValidElement(patient) && patient.type).toBe(Page.AnnouncementsPage)
    expect(isValidElement(admin) && admin.type).toBe(Page.AdminAnnouncementsPage)
  })
})

describe('the doctor’s navigation', () => {
  it('lists Announcements, short-labelled for the phone’s bar', () => {
    const items = navigationFor('doctor').flatMap((group) => group.items)

    expect(items.filter((item) => item.to === '/doctor/announcements')).toEqual([
      expect.objectContaining({ label: 'Announcements', shortLabel: 'Notices' }),
    ])
  })

  it('keeps the phone’s bar within five, with Announcements on it', () => {
    const bar = primaryMobileNavFor('doctor')

    expect(bar).toHaveLength(5)
    expect(bar.map((item) => item.shortLabel ?? item.label)).toEqual([
      'Dashboard',
      'Patients',
      'Schedule',
      'Reports',
      'Notices',
    ])
  })
})
