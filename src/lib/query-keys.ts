/**
 * Every TanStack Query key in the application, in one place.
 *
 * Keys defined ad hoc at each call site are how cache invalidation quietly
 * stops working: one file writes `['patients']`, another writes
 * `['patient', 'list']`, and invalidating after a mutation misses half the
 * screens showing that data. Declaring them centrally makes the hierarchy
 * visible and lets a mutation invalidate a whole branch at once.
 */
export const queryKeys = {
  patients: {
    all: ['patients'] as const,
    list: () => [...queryKeys.patients.all, 'list'] as const,
    detail: (patientId: string) =>
      [...queryKeys.patients.all, 'detail', patientId] as const,
  },

  doctors: {
    all: ['doctors'] as const,
    list: () => [...queryKeys.doctors.all, 'list'] as const,
    mine: () => [...queryKeys.doctors.all, 'mine'] as const,
  },

  appointments: {
    all: ['appointments'] as const,
    forPatient: (patientId: string) =>
      [...queryKeys.appointments.all, 'patient', patientId] as const,
    forDoctor: () => [...queryKeys.appointments.all, 'doctor'] as const,
    rescheduleRequests: () =>
      [...queryKeys.appointments.all, 'reschedule-requests'] as const,
  },

  treatment: {
    all: ['treatment'] as const,
    plansFor: (patientId: string) =>
      [...queryKeys.treatment.all, 'plans', patientId] as const,
    goalsFor: (planId: string) =>
      [...queryKeys.treatment.all, 'goals', planId] as const,
  },

  medications: {
    all: ['medications'] as const,
    schedulesFor: (patientId: string) =>
      [...queryKeys.medications.all, 'schedules', patientId] as const,
    dosesFor: (patientId: string, from: string, to: string) =>
      [...queryKeys.medications.all, 'doses', patientId, from, to] as const,
    adherenceFor: (patientId: string) =>
      [...queryKeys.medications.all, 'adherence', patientId] as const,
  },

  prescriptions: {
    all: ['prescriptions'] as const,
    forPatient: (patientId: string) =>
      [...queryKeys.prescriptions.all, patientId] as const,
  },

  recoveryLogs: {
    all: ['recovery-logs'] as const,
    forPatient: (patientId: string) =>
      [...queryKeys.recoveryLogs.all, patientId] as const,
  },

  doctorNotes: {
    all: ['doctor-notes'] as const,
    forPatient: (patientId: string) =>
      [...queryKeys.doctorNotes.all, patientId] as const,
  },

  notifications: {
    all: ['notifications'] as const,
    list: () => [...queryKeys.notifications.all, 'list'] as const,
    unreadCount: () => [...queryKeys.notifications.all, 'unread-count'] as const,
  },

  announcements: {
    all: ['announcements'] as const,
    list: () => [...queryKeys.announcements.all, 'list'] as const,
  },

  chat: {
    all: ['chat'] as const,
    sessionsFor: (patientId: string) =>
      [...queryKeys.chat.all, 'sessions', patientId] as const,
    messagesFor: (sessionId: string) =>
      [...queryKeys.chat.all, 'messages', sessionId] as const,
  },

  reports: {
    all: ['reports'] as const,
    list: () => [...queryKeys.reports.all, 'list'] as const,
  },

  admin: {
    all: ['admin'] as const,
    dashboard: () => [...queryKeys.admin.all, 'dashboard'] as const,
    chatbotUsage: () => [...queryKeys.admin.all, 'chatbot-usage'] as const,
    auditLog: (filters: string) =>
      [...queryKeys.admin.all, 'audit-log', filters] as const,
    settings: () => [...queryKeys.admin.all, 'settings'] as const,
  },
} as const
