import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The platform console's calls (src/features/platform/api.ts).
 *
 * Each is one Super Admin function in the database, called with only what
 * the person chose - never a user id, role or clinic of the caller's, which
 * the database takes from the session. Whether those functions refuse a
 * caller is tested against the real migrations in tests/db/super-admin.test.ts;
 * this is the request the website sends and what it makes of the answer.
 */

const client = vi.hoisted(() => ({
  rpc: vi.fn(),
  invoke: vi.fn(),
}))

vi.mock('@/lib/supabase/client', () => ({
  supabase: {
    rpc: client.rpc,
    functions: { invoke: client.invoke },
  },
}))

const api = await import('@/features/platform/api')

const CLINIC = {
  clinic_id: 'clinic-1',
  clinic_name: 'Harbor Clinic',
  clinic_status: 'active',
  clinic_timezone: 'Asia/Manila',
  clinic_created_at: '2026-10-01T00:00:00Z',
  clinic_updated_at: '2026-10-01T00:00:00Z',
  clinic_admin_count: 0,
}

beforeEach(() => {
  client.rpc.mockReset()
  client.invoke.mockReset()
})

const OVERVIEW = {
  clinics: { total: 2, active: 1, inactive: 1 },
  clinic_admins: 1,
  doctors: { total: 5, active: 3 },
  patients: { total: 6, active: 5 },
  announcements: { published: 1, drafts: 0 },
  by_clinic: [
    {
      clinic_id: 'clinic-1',
      clinic_name: 'Harbor Clinic',
      clinic_status: 'active',
      clinic_admins: 1,
      active_doctors: 2,
      active_patients: 4,
    },
  ],
  generated_at: '2026-11-05T02:00:00Z',
}

describe('the platform overview', () => {
  it('reads the counts through the Super Admin function, sending nothing', async () => {
    client.rpc.mockResolvedValue({ data: OVERVIEW, error: null })

    expect(await api.fetchPlatformOverview()).toEqual({
      clinics: { total: 2, active: 1, inactive: 1 },
      clinicAdmins: 1,
      doctors: { total: 5, active: 3 },
      patients: { total: 6, active: 5 },
      announcements: { published: 1, drafts: 0 },
      byClinic: [
        {
          clinicId: 'clinic-1',
          clinicName: 'Harbor Clinic',
          clinicStatus: 'active',
          clinicAdmins: 1,
          activeDoctors: 2,
          activePatients: 4,
        },
      ],
      generatedAt: '2026-11-05T02:00:00Z',
    })
    expect(client.rpc).toHaveBeenCalledWith('super_admin_platform_overview')
  })

  it("passes the database's refusal through", async () => {
    const refusal = { code: '42501', message: 'Super Admin privileges are required' }
    client.rpc.mockResolvedValue({ data: null, error: refusal })

    await expect(api.fetchPlatformOverview()).rejects.toBe(refusal)
  })

  it('refuses an answer that is not exactly counts, rather than showing it', () => {
    const broken: unknown[] = [
      null,
      [],
      'counts',
      { ...OVERVIEW, clinic_admins: '1' },
      { ...OVERVIEW, clinic_admins: -1 },
      { ...OVERVIEW, clinic_admins: 1.5 },
      { ...OVERVIEW, patients: { total: 6 } },
      { ...OVERVIEW, by_clinic: null },
      { ...OVERVIEW, by_clinic: [{ ...OVERVIEW.by_clinic[0], clinic_status: 'deleted' }] },
      { ...OVERVIEW, by_clinic: [{ ...OVERVIEW.by_clinic[0], active_patients: null }] },
      { ...OVERVIEW, generated_at: undefined },
    ]
    for (const data of broken) {
      expect(() => api.parsePlatformOverview(data), JSON.stringify(data)).toThrow(
        'The platform overview could not be read.',
      )
    }
  })

  it('keeps no field the page does not show', () => {
    const parsed = api.parsePlatformOverview({
      ...OVERVIEW,
      unexpected: 'ignored',
      by_clinic: [{ ...OVERVIEW.by_clinic[0], also_unexpected: 'ignored' }],
    })
    expect(JSON.stringify(parsed)).not.toContain('ignored')
  })
})

describe('clinics', () => {
  it('lists them through the Super Admin function', async () => {
    client.rpc.mockResolvedValue({ data: [CLINIC], error: null })

    expect(await api.fetchClinics()).toEqual([CLINIC])
    expect(client.rpc).toHaveBeenCalledWith('super_admin_list_clinics')
  })

  it('creates one with the name and zone given, and nothing else', async () => {
    client.rpc.mockResolvedValue({ data: [CLINIC], error: null })

    expect(await api.createClinic({ name: 'Harbor Clinic', timezone: 'Asia/Manila' })).toEqual(
      CLINIC,
    )
    expect(client.rpc).toHaveBeenCalledWith('super_admin_create_clinic', {
      new_clinic_name: 'Harbor Clinic',
      new_clinic_timezone: 'Asia/Manila',
    })
  })

  it("explains the single-clinic gate in words rather than the index's name", async () => {
    client.rpc.mockResolvedValue({
      data: null,
      error: {
        code: '23505',
        message: 'duplicate key value violates unique constraint "clinic_single_clinic_gate"',
      },
    })

    await expect(
      api.createClinic({ name: 'Second Clinic', timezone: 'Asia/Manila' }),
    ).rejects.toThrow(
      'RecoverEase is set up for one clinic for now, so another clinic cannot be added yet.',
    )
  })

  it("passes the database's own refusals through", async () => {
    const refusal = { code: '23505', message: 'A clinic with that name already exists' }
    client.rpc.mockResolvedValue({ data: null, error: refusal })

    await expect(
      api.createClinic({ name: 'Harbor Clinic', timezone: 'Asia/Manila' }),
    ).rejects.toBe(refusal)
  })

  it('sets a status by clinic id', async () => {
    client.rpc.mockResolvedValue({
      data: [{ ...CLINIC, clinic_status: 'inactive' }],
      error: null,
    })

    expect((await api.setClinicStatus('clinic-1', 'inactive')).clinic_status).toBe('inactive')
    expect(client.rpc).toHaveBeenCalledWith('super_admin_set_clinic_status', {
      target_clinic_id: 'clinic-1',
      new_status: 'inactive',
    })
  })
})

describe('adding a Clinic Admin', () => {
  const input = {
    clinicId: 'clinic-1',
    email: 'ana@harbor.test',
    firstName: 'Ana',
    lastName: 'Cruz',
  }

  it("asks create-account for a clinic_admin, with no role or password field", async () => {
    client.invoke.mockResolvedValue({
      data: { userId: 'u-2', profileId: 'admin-2', clinicId: 'clinic-1', setupEmailSent: true },
      error: null,
    })

    await api.createClinicAdmin(input)

    expect(client.invoke).toHaveBeenCalledWith('create-account', {
      body: {
        kind: 'clinic_admin',
        clinicId: 'clinic-1',
        email: 'ana@harbor.test',
        firstName: 'Ana',
        lastName: 'Cruz',
      },
    })
  })

  it('keeps only the ids and whether the email went - never anything secret', async () => {
    client.invoke.mockResolvedValue({
      data: {
        userId: 'u-2',
        profileId: 'admin-2',
        clinicId: 'clinic-1',
        setupEmailSent: false,
        // Not something create-account sends for a Clinic Admin; if it ever
        // did, the console would still not hold it.
        temporaryPassword: 'should-never-surface',
      },
      error: null,
    })

    const created = await api.createClinicAdmin(input)

    expect(created).toEqual({
      userId: 'u-2',
      profileId: 'admin-2',
      clinicId: 'clinic-1',
      setupEmailSent: false,
    })
    expect(JSON.stringify(created)).not.toContain('should-never-surface')
  })

  it("shows the function's own refusal", async () => {
    client.invoke.mockResolvedValue({
      data: null,
      error: {
        message: 'Edge Function returned a non-2xx status code',
        context: new Response(
          JSON.stringify({ error: 'That clinic is inactive and cannot take a new Clinic Admin' }),
          { status: 409 },
        ),
      },
    })

    await expect(api.createClinicAdmin(input)).rejects.toThrow(
      'That clinic is inactive and cannot take a new Clinic Admin',
    )
  })
})

describe('platform announcements', () => {
  it('lists, creates, edits, publishes and deletes through the Super Admin functions', async () => {
    client.rpc.mockResolvedValue({ data: 'ann-1', error: null })

    await api.fetchPlatformAnnouncements()
    await api.createPlatformAnnouncement({ title: 'Maintenance', content: 'Sunday', publish: false })
    await api.updatePlatformAnnouncement({ announcementId: 'ann-1', title: 'Maintenance', content: 'Saturday' })
    await api.setPlatformAnnouncementPublished('ann-1', true)
    await api.deletePlatformAnnouncement('ann-1')

    expect(client.rpc.mock.calls).toEqual([
      ['super_admin_list_announcements'],
      ['super_admin_create_announcement', { title: 'Maintenance', content: 'Sunday', publish: false }],
      [
        'super_admin_update_announcement',
        { target_announcement_id: 'ann-1', title: 'Maintenance', content: 'Saturday' },
      ],
      ['super_admin_set_announcement_published', { target_announcement_id: 'ann-1', published: true }],
      ['super_admin_delete_announcement', { target_announcement_id: 'ann-1' }],
    ])
  })
})

describe('the platform audit trail', () => {
  function entries(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      audit_log_id: `entry-${index}`,
      audit_log_timestamp: `2026-10-0${(index % 9) + 1}T00:00:00Z`,
      audit_log_action: 'insert',
      audit_log_entity: 'clinic',
      audit_log_entity_id: null,
      clinic_id: null,
      actor_user_id: null,
      audit_log_details: null,
    }))
  }

  it('reads the newest page, then continues after the last entry shown', async () => {
    client.rpc.mockResolvedValue({ data: [], error: null })

    await api.fetchPlatformAudit()
    await api.fetchPlatformAudit({ timestamp: '2026-10-01T00:00:00Z', id: 'entry-49' })

    expect(client.rpc.mock.calls).toEqual([
      ['super_admin_list_audit', { page_size: api.AUDIT_PAGE_SIZE }],
      [
        'super_admin_list_audit',
        {
          page_size: api.AUDIT_PAGE_SIZE,
          before_timestamp: '2026-10-01T00:00:00Z',
          before_id: 'entry-49',
        },
      ],
    ])
  })

  it('has a next page only after a full one', () => {
    const full = entries(api.AUDIT_PAGE_SIZE)
    const last = full[full.length - 1]!

    expect(api.nextAuditCursor(full)).toEqual({
      timestamp: last.audit_log_timestamp,
      id: last.audit_log_id,
    })
    expect(api.nextAuditCursor(entries(api.AUDIT_PAGE_SIZE - 1))).toBeUndefined()
    expect(api.nextAuditCursor([])).toBeUndefined()
  })
})
