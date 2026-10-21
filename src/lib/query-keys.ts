/**
 * Every TanStack Query key in the application, in one place.
 *
 * Keys defined ad hoc at each call site are how cache invalidation quietly
 * stops working: one file writes `['patients']`, another writes
 * `['patient', 'list']`, and invalidating after a mutation misses half the
 * screens showing that data. Declaring them centrally makes the hierarchy
 * visible and lets a mutation invalidate a whole branch at once.
 *
 * Every key starts with the id of the account it is fetched for. What a
 * query returns depends on who asks - Row Level Security answers
 * `patients.list()` with this doctor's patients, and `notifications.list()`
 * with this person's notifications - so the key says who asked as well as
 * what. AuthProvider already empties the cache whenever the signed-in
 * account changes; this is the second defence. Should anything still reach
 * the cache for the previous account after that - a mutation's callback
 * finishing late, holding the keys it was rendered with - it is filed under
 * that account's id, and the next account's screens, asking under their
 * own, cannot read it.
 *
 * There is deliberately no unscoped set of keys. Components get these
 * through `useQueryKeys()`, which reads the signed-in account, so none of
 * them can be built without naming whose they are.
 */
export function queryKeysFor(userId: string) {
  const queryKeys = {
    patients: {
      all: [userId, 'patients'] as const,
      list: () => [...queryKeys.patients.all, 'list'] as const,
      detail: (patientId: string) =>
        [...queryKeys.patients.all, 'detail', patientId] as const,
    },

    doctors: {
      all: [userId, 'doctors'] as const,
      list: () => [...queryKeys.doctors.all, 'list'] as const,
      mine: () => [...queryKeys.doctors.all, 'mine'] as const,
      reassignmentCounts: (doctorId: string) =>
        [...queryKeys.doctors.all, 'reassignment-counts', doctorId] as const,
    },

    appointments: {
      all: [userId, 'appointments'] as const,
      forPatient: (patientId: string) =>
        [...queryKeys.appointments.all, 'patient', patientId] as const,
      forDoctor: () => [...queryKeys.appointments.all, 'doctor'] as const,
      rescheduleRequests: () =>
        [...queryKeys.appointments.all, 'reschedule-requests'] as const,
    },

    treatment: {
      all: [userId, 'treatment'] as const,
      plansFor: (patientId: string) =>
        [...queryKeys.treatment.all, 'plans', patientId] as const,
      goalsFor: (planId: string) =>
        [...queryKeys.treatment.all, 'goals', planId] as const,
    },

    medications: {
      all: [userId, 'medications'] as const,
      schedulesFor: (patientId: string) =>
        [...queryKeys.medications.all, 'schedules', patientId] as const,
      dosesFor: (patientId: string, from: string, to: string) =>
        [...queryKeys.medications.all, 'doses', patientId, from, to] as const,
      adherenceFor: (patientId: string) =>
        [...queryKeys.medications.all, 'adherence', patientId] as const,
    },

    prescriptions: {
      all: [userId, 'prescriptions'] as const,
      forPatient: (patientId: string) =>
        [...queryKeys.prescriptions.all, patientId] as const,
    },

    recoveryLogs: {
      all: [userId, 'recovery-logs'] as const,
      forPatient: (patientId: string) =>
        [...queryKeys.recoveryLogs.all, patientId] as const,
    },

    doctorNotes: {
      all: [userId, 'doctor-notes'] as const,
      forPatient: (patientId: string) =>
        [...queryKeys.doctorNotes.all, patientId] as const,
    },

    notifications: {
      all: [userId, 'notifications'] as const,
      list: () => [...queryKeys.notifications.all, 'list'] as const,
      unreadCount: () =>
        [...queryKeys.notifications.all, 'unread-count'] as const,
    },

    announcements: {
      all: [userId, 'announcements'] as const,
      list: () => [...queryKeys.announcements.all, 'list'] as const,
    },

    chat: {
      all: [userId, 'chat'] as const,
      sessionsFor: (patientId: string) =>
        [...queryKeys.chat.all, 'sessions', patientId] as const,
      messagesFor: (sessionId: string) =>
        [...queryKeys.chat.all, 'messages', sessionId] as const,
      /** Whether the guidance assistant is switched on for this user (migration 38). */
      assistant: () => [...queryKeys.chat.all, 'assistant'] as const,
    },

    reports: {
      all: [userId, 'reports'] as const,
      list: () => [...queryKeys.reports.all, 'list'] as const,
    },

    admin: {
      all: [userId, 'admin'] as const,
      dashboard: () => [...queryKeys.admin.all, 'dashboard'] as const,
      chatbotUsage: () => [...queryKeys.admin.all, 'chatbot-usage'] as const,
      auditLog: (filters: string) =>
        [...queryKeys.admin.all, 'audit-log', filters] as const,
      settings: () => [...queryKeys.admin.all, 'settings'] as const,
      clinic: () => [...queryKeys.admin.all, 'clinic'] as const,
    },

    /** The platform console (Super Admin). */
    platform: {
      all: [userId, 'platform'] as const,
      /**
       * Whether this session may use the console; see
       * SuperAdminAssuranceGate.
       */
      assurance: () => [...queryKeys.platform.all, 'assurance'] as const,
      clinics: () => [...queryKeys.platform.all, 'clinics'] as const,
      announcements: () =>
        [...queryKeys.platform.all, 'announcements'] as const,
      audit: () => [...queryKeys.platform.all, 'audit'] as const,
      guidanceAssistant: () =>
        [...queryKeys.platform.all, 'guidance-assistant'] as const,
    },
  } as const

  return queryKeys
}

export type QueryKeys = ReturnType<typeof queryKeysFor>
