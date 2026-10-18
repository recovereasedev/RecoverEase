import { supabase } from '@/lib/supabase/client'
import type { Database, Enums } from '@/types/database.types'

/**
 * The platform console's reads and writes (migration 33).
 *
 * Every one is a Super Admin function in the database, and each starts by
 * checking its caller there - a Super Admin in a live session verified with
 * their own authenticator app. Nothing here passes a user id, role or clinic
 * of the caller's; the database takes all of that from the session. These
 * functions read no patient, prescription, plan, note or chat, and none of
 * them can.
 */

type Functions = Database['public']['Functions']

export type PlatformClinic = Functions['super_admin_list_clinics']['Returns'][number]
export type ClinicStatus = Enums<'clinic_status'>
export type PlatformAnnouncement =
  Functions['super_admin_list_announcements']['Returns'][number]
export type PlatformAuditEntry = Functions['super_admin_list_audit']['Returns'][number]

/** The SQLSTATE PostgreSQL gives a unique index refusing a row. */
const UNIQUE_VIOLATION = '23505'

function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function messageOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) return ''
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' ? message : ''
}

// --- Clinics -----------------------------------------------------------------

export async function fetchClinics(): Promise<PlatformClinic[]> {
  const { data, error } = await supabase.rpc('super_admin_list_clinics')
  if (error) throw error
  return data ?? []
}

/**
 * Creates an active clinic with its own default settings, in one
 * transaction. The database validates the name and the time zone again.
 */
export async function createClinic(input: {
  name: string
  timezone: string
}): Promise<PlatformClinic> {
  const { data, error } = await supabase.rpc('super_admin_create_clinic', {
    new_clinic_name: input.name,
    new_clinic_timezone: input.timezone,
  })

  if (error) {
    // Until migration 34 lifts it, a unique index allows one clinic. Its
    // message names the index, which says nothing to the person who pressed
    // Create.
    if (
      codeOf(error) === UNIQUE_VIOLATION &&
      messageOf(error).includes('clinic_single_clinic_gate')
    ) {
      throw new Error(
        'RecoverEase is set up for one clinic for now, so another clinic cannot be added yet.',
      )
    }
    throw error
  }

  const created = data?.[0]
  if (!created) throw new Error('The clinic could not be created.')
  return created
}

/**
 * Moves a clinic between active and inactive. Nothing is deleted or moved:
 * an inactive clinic keeps its people and records, and only stops taking
 * new Clinic Admins.
 */
export async function setClinicStatus(
  clinicId: string,
  status: ClinicStatus,
): Promise<PlatformClinic> {
  const { data, error } = await supabase.rpc('super_admin_set_clinic_status', {
    target_clinic_id: clinicId,
    new_status: status,
  })
  if (error) throw error

  const updated = data?.[0]
  if (!updated) throw new Error('The clinic could not be updated.')
  return updated
}

// --- Clinic Admins -------------------------------------------------------------

export type NewClinicAdminInput = {
  clinicId: string
  email: string
  firstName: string
  lastName: string
}

/**
 * What `create-account` answers for a Clinic Admin: the new ids, and whether
 * the email inviting them to set a password went. Never a password, link or
 * token - the new Clinic Admin chooses their own password from that email.
 */
export type ClinicAdminCreated = {
  userId: string
  profileId: string
  clinicId: string
  setupEmailSent: boolean
}

/**
 * Adds a Clinic Admin to an active clinic through `create-account`
 * (`kind: 'clinic_admin'`), which runs the database's checks as the Super
 * Admin, with their own token, before and after creating the sign-in. The
 * role is always Clinic Admin: the request has no field for it.
 */
export async function createClinicAdmin(
  input: NewClinicAdminInput,
): Promise<ClinicAdminCreated> {
  const { data, error } = await supabase.functions.invoke<
    ClinicAdminCreated & { error?: string }
  >('create-account', {
    body: {
      kind: 'clinic_admin',
      clinicId: input.clinicId,
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
    },
  })

  if (error) {
    // An Edge Function's refusal is in its response body; read it rather
    // than showing a bare "non-2xx status code".
    let message = 'The Clinic Admin could not be added.'
    const context = (error as { context?: Response }).context
    if (context && typeof context.json === 'function') {
      try {
        const payload = (await context.json()) as { error?: string }
        if (payload?.error) message = payload.error
      } catch {
        // Not JSON; keep the general message.
      }
    }
    throw new Error(message)
  }

  if (!data || data.error) {
    throw new Error(data?.error ?? 'The Clinic Admin could not be added.')
  }

  return {
    userId: data.userId,
    profileId: data.profileId,
    clinicId: data.clinicId,
    setupEmailSent: data.setupEmailSent === true,
  }
}

// --- Platform announcements --------------------------------------------------

/** Platform announcements, drafts included. Never a clinic's. */
export async function fetchPlatformAnnouncements(): Promise<PlatformAnnouncement[]> {
  const { data, error } = await supabase.rpc('super_admin_list_announcements')
  if (error) throw error
  return data ?? []
}

/** A draft unless `publish` is true. Returns the new announcement's id. */
export async function createPlatformAnnouncement(input: {
  title: string
  content: string
  publish: boolean
}): Promise<string> {
  const { data, error } = await supabase.rpc('super_admin_create_announcement', {
    title: input.title,
    content: input.content,
    publish: input.publish,
  })
  if (error) throw error
  return data
}

export async function updatePlatformAnnouncement(input: {
  announcementId: string
  title: string
  content: string
}): Promise<void> {
  const { error } = await supabase.rpc('super_admin_update_announcement', {
    target_announcement_id: input.announcementId,
    title: input.title,
    content: input.content,
  })
  if (error) throw error
}

/** Publishes or withdraws. Already as asked, nothing is written. */
export async function setPlatformAnnouncementPublished(
  announcementId: string,
  published: boolean,
): Promise<void> {
  const { error } = await supabase.rpc('super_admin_set_announcement_published', {
    target_announcement_id: announcementId,
    published,
  })
  if (error) throw error
}

export async function deletePlatformAnnouncement(
  announcementId: string,
): Promise<void> {
  const { error } = await supabase.rpc('super_admin_delete_announcement', {
    target_announcement_id: announcementId,
  })
  if (error) throw error
}

// --- The platform audit trail ------------------------------------------------

export const AUDIT_PAGE_SIZE = 50

/** Where the next, older page starts: after this entry. */
export type AuditCursor = { timestamp: string; id: string }

/**
 * One page of platform entries, newest first, starting after `before`. The
 * database decides which entries are platform ones; the request cannot ask
 * for any other kind. Of each entry's details it sends only the names of the
 * fields an update changed, never a value (migration 35).
 */
export async function fetchPlatformAudit(
  before?: AuditCursor,
): Promise<PlatformAuditEntry[]> {
  const { data, error } = await supabase.rpc(
    'super_admin_list_audit',
    before
      ? {
          page_size: AUDIT_PAGE_SIZE,
          before_timestamp: before.timestamp,
          before_id: before.id,
        }
      : { page_size: AUDIT_PAGE_SIZE },
  )
  if (error) throw error
  return data ?? []
}

/** The cursor for the page after `page`, or undefined when there is none. */
export function nextAuditCursor(
  page: PlatformAuditEntry[],
): AuditCursor | undefined {
  if (page.length < AUDIT_PAGE_SIZE) return undefined
  const last = page[page.length - 1]
  return last
    ? { timestamp: last.audit_log_timestamp, id: last.audit_log_id }
    : undefined
}
