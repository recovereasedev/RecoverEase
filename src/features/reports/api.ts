import { supabase } from '@/lib/supabase/client'
import type { Enums, Tables } from '@/types/database.types'

export type Report = Tables<'report'>
export type ReportType = Enums<'report_type'>

export type ReportWithPatient = Report & {
  patient: Pick<Tables<'patient'>, 'pat_first_name' | 'pat_last_name'> | null
  /**
   * The account that generated it, where the reader may see that account:
   * their own, and for a Clinic Admin every account in their clinic
   * (migration 30). Null where RLS hides it.
   */
  user_account: Pick<Tables<'user_account'>, 'user_email'> | null
}

/** Module 9.5 "View Recently Generated Reports". */
export async function fetchReports(): Promise<ReportWithPatient[]> {
  const { data, error } = await supabase
    .from('report')
    .select(`*, patient ( pat_first_name, pat_last_name ), user_account ( user_email )`)
    .order('report_generated_at', { ascending: false })
    .limit(100)

  if (error) throw error
  return data as unknown as ReportWithPatient[]
}

/**
 * Modules 9.1 (doctor, recovery report) and 9.3 (administrator, system-wide).
 *
 * This records that a report was generated, by whom and about whom. The
 * document itself is produced by the browser's print pipeline (see
 * `components/patient-report.tsx`), which is why `report_file_path` stays
 * null here.
 *
 * `report_file_path` exists in the ERD for a stored artefact. Populating it
 * means uploading a rendered file to Supabase Storage from an Edge Function;
 * that is the documented extension point, and it is deliberately not faked
 * with a URL that would 404.
 */
export async function recordGeneratedReport(input: {
  userId: string
  type: ReportType
  patientId: string | null
}): Promise<Report> {
  const { data, error } = await supabase
    .from('report')
    .insert({
      user_id: input.userId,
      report_type: input.type,
      pat_id: input.patientId,
    })
    .select()
    .single()

  if (error) throw error
  return data
}

/**
 * Module 9.3 for the Clinic Admin: records a system-wide report together with
 * the figures the database computes for their clinic now
 * (`admin_record_system_report`, migration 43), so module 9.5's history can
 * download it again exactly as it was generated. The figures are the
 * database's; nothing the browser has is sent.
 */
export async function recordSystemReport(): Promise<Report> {
  const { data, error } = await supabase.rpc('admin_record_system_report')
  if (error) throw error
  return data as unknown as Report
}

/**
 * The figures a system-wide report was generated with, when it kept them -
 * null for one generated before migration 43, or anything that is not the
 * shape `admin_dashboard_stats()` returns, so a download is never built from
 * figures that are not there.
 */
export function keptFigures(report: Pick<Report, 'report_type' | 'report_snapshot'>): DashboardStats | null {
  if (report.report_type !== 'system_wide') return null
  const kept = report.report_snapshot as Partial<DashboardStats> | null
  const isCount = (value: unknown) => typeof value === 'number' && Number.isFinite(value)
  if (
    !kept ||
    typeof kept !== 'object' ||
    !isCount(kept.patients?.total) ||
    !isCount(kept.patients?.active) ||
    !isCount(kept.doctors?.total) ||
    !isCount(kept.doctors?.active) ||
    !isCount(kept.appointments?.upcoming) ||
    typeof kept.generated_at !== 'string'
  ) {
    return null
  }
  return { ...kept, accounts: kept.accounts ?? {} } as DashboardStats
}

/**
 * Module 10.1 and 10.2, and module 8.6.
 *
 * These call database functions that return aggregates. Administrators have
 * no row access to patient or chat data, so counts cannot be assembled
 * client-side — and should not be: an administrator does not need the rows to
 * see how many there are.
 */
export type DashboardStats = {
  patients: { total: number; active: number }
  doctors: { total: number; active: number }
  accounts: Record<string, number>
  appointments: { upcoming: number }
  generated_at: string
}

export async function fetchAdminDashboardStats(): Promise<DashboardStats> {
  const { data, error } = await supabase.rpc('admin_dashboard_stats')
  if (error) throw error
  return data as unknown as DashboardStats
}

export type ChatbotUsage = {
  window_days: number
  sessions: number
  sessions_flagged_critical: number
  messages: number
  generated_at: string
}

export async function fetchChatbotUsage(
  windowDays = 30,
): Promise<ChatbotUsage> {
  const { data, error } = await supabase.rpc('admin_chatbot_usage', {
    window_days: windowDays,
  })

  if (error) throw error
  return data as unknown as ChatbotUsage
}
