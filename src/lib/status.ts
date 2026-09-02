import {
  AlertTriangle,
  Ban,
  CalendarCheck,
  CalendarClock,
  CheckCircle2,
  CircleDashed,
  CircleSlash,
  Clock,
  FileText,
  Flag,
  MinusCircle,
  Pause,
  Pill,
  Target,
  UserCheck,
  UserMinus,
  XCircle,
  type LucideIcon,
} from 'lucide-react'

import type { Enums } from '@/types/database.types'

/**
 * Every status in the system, resolved to a human label, an icon and a tone.
 *
 * The design system's first rule is that colour never carries meaning on its
 * own: roughly one man in twelve has a colour vision deficiency, and a red
 * dot beside a green dot is indistinguishable to them. Pairing each status
 * with an icon and a written label is what makes the interface readable
 * without colour — and it also means the database's enum values never leak
 * into the UI as raw strings like `no_show`.
 *
 * Because these are keyed on the generated enum types, adding a value to a
 * database enum without describing it here is a compile error.
 */
export type StatusTone =
  | 'neutral'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger'

export type StatusDescriptor = {
  label: string
  icon: LucideIcon
  tone: StatusTone
  /** Optional plain-language explanation, used in tooltips and empty states. */
  description?: string
}

export const appointmentStatus: Record<
  Enums<'appointment_status'>,
  StatusDescriptor
> = {
  scheduled: {
    label: 'Scheduled',
    icon: CalendarClock,
    tone: 'info',
    description: 'Booked, awaiting your confirmation.',
  },
  confirmed: {
    label: 'Confirmed',
    icon: CalendarCheck,
    tone: 'success',
    description: 'You have confirmed you will attend.',
  },
  completed: {
    label: 'Completed',
    icon: CheckCircle2,
    tone: 'neutral',
    description: 'This appointment has taken place.',
  },
  cancelled: {
    label: 'Cancelled',
    icon: XCircle,
    tone: 'danger',
    description: 'This appointment will not take place.',
  },
  no_show: {
    label: 'Missed',
    icon: AlertTriangle,
    tone: 'warning',
    description: 'The appointment was not attended.',
  },
}

export const rescheduleRequestStatus: Record<
  Enums<'reschedule_request_status'>,
  StatusDescriptor
> = {
  pending: {
    label: 'Awaiting review',
    icon: Clock,
    tone: 'warning',
    description: 'Your doctor has not responded yet.',
  },
  approved: {
    label: 'Approved',
    icon: CheckCircle2,
    tone: 'success',
    description: 'The appointment has been moved.',
  },
  declined: {
    label: 'Declined',
    icon: XCircle,
    tone: 'danger',
    description: 'The original appointment time still stands.',
  },
}

export const treatmentPlanStatus: Record<
  Enums<'treatment_plan_status'>,
  StatusDescriptor
> = {
  draft: {
    label: 'Draft',
    icon: FileText,
    tone: 'neutral',
    description: 'Not yet shared with the patient.',
  },
  active: {
    label: 'Active',
    icon: Flag,
    tone: 'info',
    description: 'Currently in progress.',
  },
  completed: {
    label: 'Completed',
    icon: CheckCircle2,
    tone: 'success',
    description: 'The programme has finished.',
  },
  cancelled: {
    label: 'Cancelled',
    icon: CircleSlash,
    tone: 'neutral',
    description: 'This plan was stopped before completion.',
  },
}

export const treatmentGoalStatus: Record<
  Enums<'treatment_goal_status'>,
  StatusDescriptor
> = {
  pending: {
    label: 'Not started',
    icon: CircleDashed,
    tone: 'neutral',
  },
  in_progress: {
    label: 'In progress',
    icon: Target,
    tone: 'info',
  },
  achieved: {
    label: 'Achieved',
    icon: CheckCircle2,
    tone: 'success',
  },
  missed: {
    label: 'Not met',
    icon: MinusCircle,
    tone: 'warning',
  },
}

export const medicationLogStatus: Record<
  Enums<'medication_log_status'>,
  StatusDescriptor
> = {
  pending: {
    label: 'Due',
    icon: Pill,
    tone: 'info',
    description: 'Not yet recorded.',
  },
  taken: {
    label: 'Taken',
    icon: CheckCircle2,
    tone: 'success',
    description: 'You recorded this dose.',
  },
  missed: {
    label: 'Missed',
    icon: AlertTriangle,
    tone: 'warning',
    description: 'The time passed without a record.',
  },
  skipped: {
    label: 'Skipped',
    icon: Pause,
    tone: 'neutral',
    description: 'Deliberately not taken.',
  },
}

export const patientStatus: Record<
  Enums<'patient_status'>,
  StatusDescriptor
> = {
  active: { label: 'Active', icon: UserCheck, tone: 'success' },
  inactive: { label: 'Inactive', icon: Pause, tone: 'neutral' },
  discharged: { label: 'Discharged', icon: UserMinus, tone: 'neutral' },
}

export const doctorAccountStatus = {
  active: { label: 'Active', icon: UserCheck, tone: 'success' },
  inactive: { label: 'Deactivated', icon: Ban, tone: 'danger' },
} as const satisfies Record<'active' | 'inactive', StatusDescriptor>

/** Tailwind classes per tone, for badges. The border keeps a badge legible
 *  when printed or viewed in forced-colours mode, where background fills are
 *  dropped and a fill-only badge would vanish. */
export const toneClasses: Record<StatusTone, string> = {
  neutral:
    'bg-neutral-100 text-neutral-700 border-neutral-200',
  info: 'bg-info-50 text-info-700 border-info-200',
  success: 'bg-success-50 text-success-700 border-success-200',
  warning: 'bg-warning-50 text-warning-800 border-warning-200',
  danger: 'bg-danger-50 text-danger-700 border-danger-200',
}
