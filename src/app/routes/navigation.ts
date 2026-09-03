import {
  Activity,
  Bell,
  CalendarDays,
  ClipboardList,
  FileBarChart,
  LayoutDashboard,
  Megaphone,
  MessageCircle,
  Pill,
  ScrollText,
  Settings,
  Stethoscope,
  User,
  Users,
  type LucideIcon,
} from 'lucide-react'

import type { UserRole } from '@/features/auth/types'

export type NavItem = {
  label: string
  to: string
  icon: LucideIcon
  /**
   * Used by the phone's bottom bar, where a fifth of a 375px screen is not
   * enough for "Treatment plan". Only set it where the full label would be
   * truncated; a shortened label that still fits is just a worse label.
   */
  shortLabel?: string
  /** Matches nested routes, e.g. /doctor/patients/:id under "Patients". */
  matchPrefix?: boolean
}

export type NavSection = {
  /** Omitted for the first group, which needs no heading. */
  heading?: string
  items: NavItem[]
}

/**
 * Navigation is built per role from the module specification, so a user only
 * sees sections that exist for them.
 *
 * This is a usability decision, not a security one. Hiding a link does not
 * protect anything — a patient who types /admin/audit still gets zero rows,
 * because the audit_log policy admits administrators only. See
 * supabase/migrations for the actual boundary.
 */
const PATIENT_NAV: NavSection[] = [
  {
    items: [
      { label: 'Dashboard', to: '/patient', icon: LayoutDashboard },
      { label: 'My recovery', to: '/patient/recovery', icon: Activity },
      {
        label: 'Treatment plan',
        shortLabel: 'Treatment',
        to: '/patient/treatment',
        icon: ClipboardList,
        matchPrefix: true,
      },
      { label: 'Medications', to: '/patient/medications', icon: Pill },
      {
        label: 'Appointments',
        to: '/patient/appointments',
        icon: CalendarDays,
      },
    ],
  },
  {
    heading: 'Support',
    items: [
      { label: 'Guidance chat', to: '/patient/chat', icon: MessageCircle },
      { label: 'Notifications', to: '/patient/notifications', icon: Bell },
      {
        label: 'Announcements',
        to: '/patient/announcements',
        icon: Megaphone,
      },
      { label: 'My profile', to: '/patient/profile', icon: User },
    ],
  },
]

const DOCTOR_NAV: NavSection[] = [
  {
    items: [
      { label: 'Dashboard', to: '/doctor', icon: LayoutDashboard },
      {
        label: 'Patients',
        to: '/doctor/patients',
        icon: Users,
        matchPrefix: true,
      },
      {
        label: 'Appointments',
        to: '/doctor/appointments',
        icon: CalendarDays,
      },
      { label: 'Reports', to: '/doctor/reports', icon: FileBarChart },
    ],
  },
  {
    heading: 'Account',
    items: [
      { label: 'Notifications', to: '/doctor/notifications', icon: Bell },
      { label: 'My profile', to: '/doctor/profile', icon: User },
    ],
  },
]

const ADMIN_NAV: NavSection[] = [
  {
    items: [
      { label: 'Dashboard', to: '/admin', icon: LayoutDashboard },
      {
        label: 'Doctor accounts',
        shortLabel: 'Doctors',
        to: '/admin/doctors',
        icon: Stethoscope,
        matchPrefix: true,
      },
      { label: 'Announcements', to: '/admin/announcements', icon: Megaphone },
      { label: 'Reports', to: '/admin/reports', icon: FileBarChart },
    ],
  },
  {
    heading: 'System',
    items: [
      { label: 'Audit log', to: '/admin/audit', icon: ScrollText },
      { label: 'Settings', to: '/admin/settings', icon: Settings },
      { label: 'My profile', to: '/admin/profile', icon: User },
    ],
  },
]

const NAV_BY_ROLE: Record<UserRole, NavSection[]> = {
  patient: PATIENT_NAV,
  doctor: DOCTOR_NAV,
  admin: ADMIN_NAV,
}

export function navigationFor(role: UserRole): NavSection[] {
  return NAV_BY_ROLE[role]
}

/**
 * The handful of destinations that fit in a phone's bottom bar.
 *
 * Mobile navigation is not a shrunken sidebar. Five items is the practical
 * ceiling before targets get too narrow to hit reliably, so each role gets
 * its most-used destinations and the rest live behind the menu.
 */
export function primaryMobileNavFor(role: UserRole): NavItem[] {
  return NAV_BY_ROLE[role][0]?.items.slice(0, 5) ?? []
}
