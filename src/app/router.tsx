import { Suspense, type ReactNode } from 'react'
import { createBrowserRouter, Navigate, type RouteObject } from 'react-router-dom'

import {
  NotFoundScreen,
  RedirectIfSignedIn,
  RequireAuth,
  RequireRole,
} from '@/app/routes/guards'
import * as Page from '@/app/routes/lazy-pages'
import { LoadingState } from '@/components/feedback/state-view'
import { AppShell } from '@/components/layout/app-shell'
import { ConsentGate } from '@/features/auth/components/consent-gate'

function LazyBoundary({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<LoadingState label="Loading page…" />}>
      {children}
    </Suspense>
  )
}

/**
 * Wraps a role's routes in the shell, the auth guard and the role guard.
 *
 * Patients additionally pass through the consent gate (module 1.5). It sits
 * inside the auth guard and outside the shell, so a patient who has not yet
 * accepted the privacy notice cannot reach any clinical screen — including by
 * typing a deep link, since the gate wraps every child route rather than
 * being a redirect from the dashboard.
 */
function protectedSection(
  role: 'patient' | 'doctor' | 'admin',
  children: RouteObject[],
): RouteObject {
  const shell =
    role === 'patient' ? (
      <ConsentGate>
        <AppShell />
      </ConsentGate>
    ) : (
      <AppShell />
    )

  return {
    path: role,
    element: (
      <RequireAuth>
        <RequireRole allow={[role]}>{shell}</RequireRole>
      </RequireAuth>
    ),
    children: children.map((route) => ({
      ...route,
      element: <LazyBoundary>{route.element}</LazyBoundary>,
    })),
  }
}

export const router = createBrowserRouter([
  {
    path: '/',
    element: (
      <RedirectIfSignedIn>
        <LazyBoundary>
          <Page.LandingPage />
        </LazyBoundary>
      </RedirectIfSignedIn>
    ),
  },
  {
    path: '/sign-in',
    element: (
      <RedirectIfSignedIn>
        <LazyBoundary>
          <Page.SignInPage />
        </LazyBoundary>
      </RedirectIfSignedIn>
    ),
  },
  {
    path: '/forgot-password',
    element: (
      <LazyBoundary>
        <Page.ForgotPasswordPage />
      </LazyBoundary>
    ),
  },
  {
    // Not wrapped in RedirectIfSignedIn: arriving here always carries a
    // recovery session, so redirecting "signed-in" users away would make the
    // reset link impossible to use.
    path: '/reset-password',
    element: (
      <LazyBoundary>
        <Page.ResetPasswordPage />
      </LazyBoundary>
    ),
  },

  protectedSection('patient', [
    { index: true, element: <Page.PatientDashboard /> },
    { path: 'recovery', element: <Page.RecoveryPage /> },
    { path: 'treatment', element: <Page.PatientTreatmentPage /> },
    { path: 'medications', element: <Page.PatientMedicationsPage /> },
    { path: 'appointments', element: <Page.PatientAppointmentsPage /> },
    { path: 'chat', element: <Page.PatientChatPage /> },
    { path: 'notifications', element: <Page.NotificationsPage /> },
    { path: 'announcements', element: <Page.AnnouncementsPage /> },
    { path: 'profile', element: <Page.PatientProfilePage /> },
  ]),

  protectedSection('doctor', [
    { index: true, element: <Page.DoctorDashboard /> },
    { path: 'patients', element: <Page.DoctorPatientsPage /> },
    { path: 'patients/:patientId', element: <Page.DoctorPatientDetailPage /> },
    { path: 'appointments', element: <Page.DoctorAppointmentsPage /> },
    { path: 'reports', element: <Page.DoctorReportsPage /> },
    { path: 'notifications', element: <Page.NotificationsPage /> },
    { path: 'profile', element: <Page.DoctorProfilePage /> },
  ]),

  protectedSection('admin', [
    { index: true, element: <Page.AdminDashboard /> },
    { path: 'doctors', element: <Page.AdminDoctorsPage /> },
    { path: 'announcements', element: <Page.AdminAnnouncementsPage /> },
    { path: 'audit', element: <Page.AuditLogPage /> },
    { path: 'reports', element: <Page.AdminReportsPage /> },
    { path: 'notifications', element: <Page.NotificationsPage /> },
    { path: 'settings', element: <Page.SystemSettingsPage /> },
    { path: 'profile', element: <Page.AdminProfilePage /> },
  ]),

  // Ambiguous entry point: send people to the root, which routes them on.
  { path: '/app', element: <Navigate to="/" replace /> },
  { path: '*', element: <NotFoundScreen /> },
])
