import { lazy } from 'react'

/**
 * Every route component, loaded on demand.
 *
 * Two reasons this is a separate module rather than sitting in `router.tsx`:
 *
 *  - A visitor who lands on the marketing page should not download the sign-in
 *    form, and with it Zod and React Hook Form. Those are only needed once
 *    somebody actually goes to sign in.
 *  - Splitting on the role boundary means a patient never downloads the
 *    administrator's audit-log screen, and vice versa.
 *
 * Keeping these out of `router.tsx` also keeps that file free of mixed
 * component/non-component exports, which is what React Fast Refresh needs to
 * stay reliable in development.
 */

// --- Public ----------------------------------------------------------------
export const LandingPage = lazy(() =>
  import('@/features/marketing/pages/landing-page').then((m) => ({
    default: m.LandingPage,
  })),
)
export const SignInPage = lazy(() =>
  import('@/features/auth/pages/sign-in-page').then((m) => ({
    default: m.SignInPage,
  })),
)
export const ForgotPasswordPage = lazy(() =>
  import('@/features/auth/pages/forgot-password-page').then((m) => ({
    default: m.ForgotPasswordPage,
  })),
)
export const ResetPasswordPage = lazy(() =>
  import('@/features/auth/pages/reset-password-page').then((m) => ({
    default: m.ResetPasswordPage,
  })),
)

// --- Patient ---------------------------------------------------------------
export const PatientDashboard = lazy(() =>
  import('@/features/dashboard/pages/patient-dashboard').then((m) => ({
    default: m.PatientDashboard,
  })),
)
export const RecoveryPage = lazy(() =>
  import('@/features/recovery-logs/pages/recovery-page').then((m) => ({
    default: m.RecoveryPage,
  })),
)
export const PatientTreatmentPage = lazy(() =>
  import('@/features/treatment-plans/pages/patient-treatment-page').then((m) => ({
    default: m.PatientTreatmentPage,
  })),
)
export const PatientMedicationsPage = lazy(() =>
  import('@/features/medications/pages/patient-medications-page').then((m) => ({
    default: m.PatientMedicationsPage,
  })),
)
export const PatientAppointmentsPage = lazy(() =>
  import('@/features/appointments/pages/patient-appointments-page').then((m) => ({
    default: m.PatientAppointmentsPage,
  })),
)
export const PatientChatPage = lazy(() =>
  import('@/features/chat/pages/patient-chat-page').then((m) => ({
    default: m.PatientChatPage,
  })),
)
export const PatientProfilePage = lazy(() =>
  import('@/features/patients/pages/patient-profile-page').then((m) => ({
    default: m.PatientProfilePage,
  })),
)

// --- Shared across roles ---------------------------------------------------
export const NotificationsPage = lazy(() =>
  import('@/features/notifications/pages/notifications-page').then((m) => ({
    default: m.NotificationsPage,
  })),
)
export const AnnouncementsPage = lazy(() =>
  import('@/features/announcements/pages/announcements-page').then((m) => ({
    default: m.AnnouncementsPage,
  })),
)

// --- Doctor ----------------------------------------------------------------
export const DoctorDashboard = lazy(() =>
  import('@/features/dashboard/pages/doctor-dashboard').then((m) => ({
    default: m.DoctorDashboard,
  })),
)
export const DoctorPatientsPage = lazy(() =>
  import('@/features/patients/pages/doctor-patients-page').then((m) => ({
    default: m.DoctorPatientsPage,
  })),
)
export const DoctorPatientDetailPage = lazy(() =>
  import('@/features/patients/pages/doctor-patient-detail-page').then((m) => ({
    default: m.DoctorPatientDetailPage,
  })),
)
export const DoctorAppointmentsPage = lazy(() =>
  import('@/features/appointments/pages/doctor-appointments-page').then((m) => ({
    default: m.DoctorAppointmentsPage,
  })),
)
export const DoctorReportsPage = lazy(() =>
  import('@/features/reports/pages/doctor-reports-page').then((m) => ({
    default: m.DoctorReportsPage,
  })),
)
export const DoctorProfilePage = lazy(() =>
  import('@/features/patients/pages/doctor-profile-page').then((m) => ({
    default: m.DoctorProfilePage,
  })),
)

// --- Administrator ---------------------------------------------------------
export const AdminDashboard = lazy(() =>
  import('@/features/dashboard/pages/admin-dashboard').then((m) => ({
    default: m.AdminDashboard,
  })),
)
export const AdminDoctorsPage = lazy(() =>
  import('@/features/patients/pages/admin-doctors-page').then((m) => ({
    default: m.AdminDoctorsPage,
  })),
)
export const AdminAnnouncementsPage = lazy(() =>
  import('@/features/announcements/pages/admin-announcements-page').then((m) => ({
    default: m.AdminAnnouncementsPage,
  })),
)
export const AuditLogPage = lazy(() =>
  import('@/features/audit-logs/pages/audit-log-page').then((m) => ({
    default: m.AuditLogPage,
  })),
)
export const AdminReportsPage = lazy(() =>
  import('@/features/reports/pages/admin-reports-page').then((m) => ({
    default: m.AdminReportsPage,
  })),
)
export const SystemSettingsPage = lazy(() =>
  import('@/features/system-settings/pages/system-settings-page').then((m) => ({
    default: m.SystemSettingsPage,
  })),
)
export const AdminProfilePage = lazy(() =>
  import('@/features/system-settings/pages/admin-profile-page').then((m) => ({
    default: m.AdminProfilePage,
  })),
)
