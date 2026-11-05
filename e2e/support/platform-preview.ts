import type { Page } from '@playwright/test'

import type { RpcReply, SupabaseStub } from './supabase-stub'

/**
 * An in-memory platform for previewing the Super Admin console locally:
 * clinics, their Clinic Admins, the guidance assistant's platform switch,
 * platform announcements and the platform audit trail, answering the same
 * Super Admin functions the console calls.
 *
 * This is a stand-in for the database's answers, not for its checks. It
 * does not decide who may call what - the real functions do, in PostgreSQL,
 * and tests/db/super-admin.test.ts tests them against the migrations. It
 * lives under e2e/ with the stub it plugs into: nothing in src/ imports it,
 * so no build of the website contains it (tests/unit/preview-isolation.test.ts).
 */

type Clinic = {
  clinic_id: string
  clinic_name: string
  clinic_status: 'active' | 'inactive'
  clinic_timezone: string
  clinic_created_at: string
  clinic_updated_at: string
  clinic_admin_count: number
}

type ClinicAdmin = {
  admin_first_name: string
  admin_last_name: string
  admin_created_at: string
  has_signed_in: boolean
  last_signed_in_at: string | null
}

type Announcement = {
  announcement_id: string
  announcement_title: string
  announcement_content: string
  announcement_published_at: string | null
  announcement_created_at: string
}

type AuditEntry = {
  audit_log_id: string
  audit_log_timestamp: string
  audit_log_action: string
  audit_log_entity: string
  audit_log_entity_id: string | null
  clinic_id: string | null
  actor_user_id: string | null
  audit_log_details: Record<string, unknown> | null
}

export type PlatformPreviewOptions = {
  /** The signed-in Super Admin, recorded as the actor of each change. */
  actorUserId: string
  clinics: Clinic[]
  /**
   * Each clinic's Clinic Admins, by clinic id. A clinic left out gets as
   * many placeholder Clinic Admins as its count says, none signed in.
   */
  clinicAdmins?: Record<string, ClinicAdmin[]>
  /**
   * Whether a second clinic is refused, as production refuses it until
   * migration 34 lifts the single-clinic gate. On by default.
   */
  singleClinicGate?: boolean
}

function refusal(status: number, code: string, message: string): RpcReply {
  return { status, error: { code, message } }
}

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    // A single name such as UTC, or Area/Location: PostgreSQL knows both.
    return /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(zone)
  } catch {
    return false
  }
}

export async function installPlatformPreview(
  page: Page,
  stub: SupabaseStub,
  options: PlatformPreviewOptions,
): Promise<void> {
  const clinics: Clinic[] = options.clinics.map((clinic) => ({ ...clinic }))
  const announcements: Announcement[] = []
  const audit: AuditEntry[] = []
  const admins = new Map<string, ClinicAdmin[]>(
    clinics.map((clinic) => [
      clinic.clinic_id,
      options.clinicAdmins?.[clinic.clinic_id]?.map((admin) => ({ ...admin })) ??
        Array.from({ length: clinic.clinic_admin_count }, (_, index) => ({
          admin_first_name: 'Clinic',
          admin_last_name: `Admin ${index + 1}`,
          admin_created_at: clinic.clinic_created_at,
          has_signed_in: false,
          last_signed_in_at: null,
        })),
    ]),
  )
  const gate = options.singleClinicGate ?? true
  const now = () => new Date().toISOString()

  const record = (
    action: string,
    entity: string,
    entityId: string | null,
    clinicId: string | null,
    details: Record<string, unknown> | null = null,
  ) => {
    audit.unshift({
      audit_log_id: crypto.randomUUID(),
      audit_log_timestamp: now(),
      audit_log_action: action,
      audit_log_entity: entity,
      audit_log_entity_id: entityId,
      clinic_id: clinicId,
      actor_user_id: options.actorUserId,
      audit_log_details: details,
    })
  }

  // --- The platform overview (migration 46) -----------------------------------
  // Platform totals, counted from this preview's own state as the real
  // function counts the database - no clinic broken out. The preview keeps
  // no doctors or patients - the console never reaches any - so those count
  // none.

  stub.setRpcHandler('super_admin_platform_overview', () => {
    const active = clinics.filter((clinic) => clinic.clinic_status === 'active').length
    return {
      result: {
        clinics: { total: clinics.length, active, inactive: clinics.length - active },
        clinic_admins: clinics.reduce((total, clinic) => total + clinic.clinic_admin_count, 0),
        doctors: { total: 0, active: 0 },
        patients: { total: 0, active: 0 },
        announcements: {
          published: announcements.filter((a) => a.announcement_published_at !== null).length,
          drafts: announcements.filter((a) => a.announcement_published_at === null).length,
        },
        generated_at: now(),
      },
    }
  })

  // --- Clinics ---------------------------------------------------------------

  stub.setRpcHandler('super_admin_list_clinics', () => ({
    result: [...clinics].sort((a, b) => a.clinic_name.localeCompare(b.clinic_name)),
  }))

  stub.setRpcHandler('super_admin_create_clinic', (args) => {
    const name = String(args['new_clinic_name'] ?? '').trim()
    const zone = String(args['new_clinic_timezone'] ?? '').trim()
    if (!name) return refusal(400, '23514', "Enter the clinic's name")
    if (name.length > 120) {
      return refusal(400, '23514', "A clinic's name can be at most 120 characters")
    }
    if (!zone) {
      return refusal(400, '23514', "Enter the clinic's time zone, such as Asia/Manila")
    }
    if (clinics.some((c) => c.clinic_name.toLowerCase() === name.toLowerCase())) {
      return refusal(409, '23505', 'A clinic with that name already exists')
    }
    if (!isTimeZone(zone)) return refusal(400, 'P0001', `Unknown time zone: ${zone}`)
    if (gate && clinics.length > 0) {
      return refusal(
        409,
        '23505',
        'duplicate key value violates unique constraint "clinic_single_clinic_gate"',
      )
    }
    const clinic: Clinic = {
      clinic_id: crypto.randomUUID(),
      clinic_name: name,
      clinic_status: 'active',
      clinic_timezone: zone,
      clinic_created_at: now(),
      clinic_updated_at: now(),
      clinic_admin_count: 0,
    }
    clinics.push(clinic)
    admins.set(clinic.clinic_id, [])
    record('insert', 'clinic', clinic.clinic_id, clinic.clinic_id)
    return { result: [clinic] }
  })

  stub.setRpcHandler('super_admin_set_clinic_status', (args) => {
    const clinic = clinics.find((c) => c.clinic_id === args['target_clinic_id'])
    const wanted = String(args['new_status'] ?? '')
    if (!clinic) return refusal(404, 'P0002', 'That clinic could not be found')
    if (wanted !== 'active' && wanted !== 'inactive') {
      return refusal(400, '23514', "A clinic's status is active or inactive")
    }
    if (clinic.clinic_status === wanted) {
      return refusal(409, '55000', `The clinic is already ${wanted}`)
    }
    clinic.clinic_status = wanted
    clinic.clinic_updated_at = now()
    record('update', 'clinic', clinic.clinic_id, clinic.clinic_id, {
      changed_columns: ['clinic_status', 'clinic_updated_at'],
    })
    return { result: [{ ...clinic }] }
  })

  // --- One clinic's details (migration 47) ------------------------------------

  stub.setRpcHandler('super_admin_list_clinic_admins', (args) => {
    const list = admins.get(String(args['target_clinic_id'] ?? ''))
    if (!list) return refusal(404, 'P0002', 'That clinic could not be found')
    return {
      result: [...list].sort((a, b) =>
        `${a.admin_last_name} ${a.admin_first_name}`.localeCompare(`${b.admin_last_name} ${b.admin_first_name}`),
      ),
    }
  })

  stub.setRpcHandler('super_admin_update_clinic', (args) => {
    const clinic = clinics.find((c) => c.clinic_id === args['target_clinic_id'])
    if (!clinic) return refusal(404, 'P0002', 'That clinic could not be found')
    const name = String(args['new_clinic_name'] ?? '').trim()
    const zone = String(args['new_clinic_timezone'] ?? '').trim()
    if (!name) return refusal(400, '23514', "Enter the clinic's name")
    if (name.length > 120) {
      return refusal(400, '23514', "A clinic's name can be at most 120 characters")
    }
    if (!zone) {
      return refusal(400, '23514', "Enter the clinic's time zone, such as Asia/Manila")
    }
    if (
      clinics.some(
        (c) => c.clinic_id !== clinic.clinic_id && c.clinic_name.toLowerCase() === name.toLowerCase(),
      )
    ) {
      return refusal(409, '23505', 'A clinic with that name already exists')
    }
    if (!isTimeZone(zone)) return refusal(400, '23514', `Unknown time zone: ${zone}`)
    const changed = [
      ...(name !== clinic.clinic_name ? ['clinic_name'] : []),
      ...(zone !== clinic.clinic_timezone ? ['clinic_timezone'] : []),
    ]
    if (changed.length > 0) {
      const before = { clinic_name: clinic.clinic_name, clinic_timezone: clinic.clinic_timezone }
      clinic.clinic_name = name
      clinic.clinic_timezone = zone
      clinic.clinic_updated_at = now()
      record('update', 'clinic', clinic.clinic_id, clinic.clinic_id, {
        changed_columns: [...changed, 'clinic_updated_at'],
        before: Object.fromEntries(changed.map((key) => [key, before[key as keyof typeof before]])),
        after: Object.fromEntries(changed.map((key) => [key, clinic[key as keyof Clinic]])),
      })
    }
    return { result: [{ ...clinic }] }
  })

  // --- The guidance assistant's platform switch ------------------------------
  // As migration 38: on until first set; the first change creates the setting
  // and later ones update it; setting the value it already has writes and
  // audits nothing. Its entries name no field - the setting is not in
  // `public`, so migration 35 drops its column's name from what is sent.

  let assistant: { id: string; enabled: boolean; updatedAt: string } | null = null

  stub.setRpcHandler('super_admin_get_guidance_assistant', () => ({
    result: [{ enabled: assistant?.enabled ?? true, updated_at: assistant?.updatedAt ?? null }],
  }))

  stub.setRpcHandler('super_admin_set_guidance_assistant', (args) => {
    const enabled = args['enabled']
    if (typeof enabled !== 'boolean') {
      return refusal(400, '23514', 'Say whether the guidance assistant is on or off')
    }
    if (!assistant) {
      assistant = { id: crypto.randomUUID(), enabled, updatedAt: now() }
      record('insert', 'platform_setting', assistant.id, null)
    } else if (assistant.enabled !== enabled) {
      assistant.enabled = enabled
      assistant.updatedAt = now()
      record('update', 'platform_setting', assistant.id, null)
    }
    return { result: enabled }
  })

  // --- Clinic Admins, through create-account ---------------------------------
  // Registered after the stub's catch-all for functions, so it is the one
  // Playwright uses for this function. No password, link or token is ever
  // part of the reply - the real function has none to give either.

  await page.route('**/functions/v1/create-account', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}') as Record<string, unknown>
    const reply = (status: number, payload: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) })

    if (body['kind'] !== 'clinic_admin') {
      await reply(403, { error: 'This preview models Clinic Admin invitations only' })
      return
    }
    const clinic = clinics.find((c) => c.clinic_id === body['clinicId'])
    if (!clinic) {
      await reply(404, { error: 'That clinic could not be found' })
      return
    }
    if (clinic.clinic_status !== 'active') {
      await reply(409, { error: 'That clinic is inactive and cannot take a new Clinic Admin' })
      return
    }
    clinic.clinic_admin_count += 1
    admins.get(clinic.clinic_id)?.push({
      admin_first_name: String(body['firstName'] ?? '').trim(),
      admin_last_name: String(body['lastName'] ?? '').trim(),
      admin_created_at: now(),
      has_signed_in: false,
      last_signed_in_at: null,
    })
    const profileId = crypto.randomUUID()
    // No details: of a created row's, the browser is sent none (migration 35).
    record('create', 'clinic_admin_account', profileId, clinic.clinic_id)
    await reply(201, {
      userId: crypto.randomUUID(),
      profileId,
      clinicId: clinic.clinic_id,
      setupEmailSent: true,
    })
  })

  // --- Platform announcements ------------------------------------------------

  const findAnnouncement = (id: unknown) =>
    announcements.find((a) => a.announcement_id === id)
  const checkText = (title: unknown, content: unknown): RpcReply | null => {
    if (!String(title ?? '').trim()) return refusal(400, '23514', 'Give the announcement a title.')
    if (!String(content ?? '').trim()) return refusal(400, '23514', 'Write the message.')
    return null
  }

  stub.setRpcHandler('super_admin_list_announcements', () => ({
    result: [...announcements],
  }))

  stub.setRpcHandler('super_admin_create_announcement', (args) => {
    const problem = checkText(args['title'], args['content'])
    if (problem) return problem
    const announcement: Announcement = {
      announcement_id: crypto.randomUUID(),
      announcement_title: String(args['title']).trim(),
      announcement_content: String(args['content']).trim(),
      announcement_published_at: args['publish'] === true ? now() : null,
      announcement_created_at: now(),
    }
    announcements.unshift(announcement)
    record('insert', 'announcement', announcement.announcement_id, null)
    return { result: announcement.announcement_id }
  })

  stub.setRpcHandler('super_admin_update_announcement', (args) => {
    const problem = checkText(args['title'], args['content'])
    if (problem) return problem
    const announcement = findAnnouncement(args['target_announcement_id'])
    if (!announcement) {
      return refusal(404, 'P0002', 'That platform announcement could not be found')
    }
    announcement.announcement_title = String(args['title']).trim()
    announcement.announcement_content = String(args['content']).trim()
    record('update', 'announcement', announcement.announcement_id, null, {
      changed_columns: ['announcement_title', 'announcement_content'],
    })
    return { result: null }
  })

  stub.setRpcHandler('super_admin_set_announcement_published', (args) => {
    const announcement = findAnnouncement(args['target_announcement_id'])
    if (!announcement) {
      return refusal(404, 'P0002', 'That platform announcement could not be found')
    }
    const published = args['published'] === true
    if (published !== (announcement.announcement_published_at !== null)) {
      announcement.announcement_published_at = published ? now() : null
      record('update', 'announcement', announcement.announcement_id, null, {
        changed_columns: ['announcement_published_at'],
      })
    }
    return { result: announcement.announcement_published_at }
  })

  stub.setRpcHandler('super_admin_delete_announcement', (args) => {
    const announcement = findAnnouncement(args['target_announcement_id'])
    if (!announcement) {
      return refusal(404, 'P0002', 'That platform announcement could not be found')
    }
    announcements.splice(announcements.indexOf(announcement), 1)
    record('delete', 'announcement', announcement.announcement_id, null)
    return { result: null }
  })

  // --- The platform audit trail ----------------------------------------------

  stub.setRpcHandler('super_admin_list_audit', (args) => {
    const pageSize = Number(args['page_size'] ?? 50)
    const beforeTimestamp = args['before_timestamp'] as string | undefined
    const beforeId = (args['before_id'] as string | undefined) ?? 'ffffffff-ffff-ffff-ffff-ffffffffffff'
    const rows = audit.filter(
      (entry) =>
        !beforeTimestamp ||
        entry.audit_log_timestamp < beforeTimestamp ||
        (entry.audit_log_timestamp === beforeTimestamp && entry.audit_log_id < beforeId),
    )
    return { result: rows.slice(0, pageSize) }
  })
}
