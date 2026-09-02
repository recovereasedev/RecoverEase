import { supabase } from '@/lib/supabase/client'
import type { Tables } from '@/types/database.types'

export type AuditLogEntry = Tables<'audit_log'> & {
  user_account: Pick<
    Tables<'user_account'>,
    'user_email' | 'user_role'
  > | null
}

export type AuditLogFilters = {
  entity?: string
  action?: string
  search?: string
  limit?: number
}

/**
 * Modules 13.1 "View Audit Logs" and 13.2 "Filter / Search Audit Logs".
 *
 * Administrators only, enforced by the audit_log RLS policy. The details
 * column carries no patient content by design: on patient-touching tables the
 * audit trigger records which columns changed, never their values, because
 * administrators can read this table and cannot read patient records.
 */
export async function fetchAuditLog(
  filters: AuditLogFilters = {},
): Promise<AuditLogEntry[]> {
  let query = supabase
    .from('audit_log')
    .select(`*, user_account ( user_email, user_role )`)
    .order('audit_log_timestamp', { ascending: false })
    .limit(filters.limit ?? 200)

  if (filters.entity) {
    query = query.eq('audit_log_entity', filters.entity)
  }

  if (filters.action) {
    query = query.eq('audit_log_action', filters.action)
  }

  if (filters.search) {
    // Escape PostgREST's pattern wildcards so a literal % typed into the
    // search box does not silently match everything.
    const escaped = filters.search.replace(/[%_]/g, (match) => `\\${match}`)
    query = query.ilike('audit_log_entity', `%${escaped}%`)
  }

  const { data, error } = await query
  if (error) throw error
  return data as unknown as AuditLogEntry[]
}

/** Distinct entities present in the log, for the filter dropdown. */
export function distinctEntities(entries: AuditLogEntry[]): string[] {
  return [...new Set(entries.map((entry) => entry.audit_log_entity))].sort()
}
