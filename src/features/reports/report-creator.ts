import type { ReportWithPatient } from '@/features/reports/api'

/** The signed-in account reading a list of reports. */
export type ReportReader = {
  userId: string
  name: string | null
  email: string | null
}

/**
 * Module 9.5: who generated a report, from what the reader may see.
 *
 * The reader's own reports name them. Anyone else's give that account's email
 * address, which is what a Clinic Admin may read of another account in their
 * clinic (migration 30); another administrator's name is readable only by
 * that administrator. Where even the address is hidden, it says so rather
 * than guess.
 *
 * Kept apart from the export builders, which are loaded only on download, so
 * the page can use it without loading them.
 */
export function reportCreator(
  report: Pick<ReportWithPatient, 'user_id' | 'user_account'>,
  reader: ReportReader,
): string {
  if (report.user_id === reader.userId) {
    const self = reader.name ?? reader.email
    return self ? `${self} (you)` : 'You'
  }
  return report.user_account?.user_email ?? 'Not available'
}
