import { describe, expect, it, vi } from 'vitest'

import type { Caller } from '../../supabase/functions/_shared/caller'
import {
  resetAccountPassword,
  type ResetRequest,
  type ResetStore,
} from '../../supabase/functions/reset-account-password/handler'

/**
 * reset-account-password's rules, with Supabase replaced by a recording
 * store. A Clinic Admin reaches only their own clinic's doctors, and another
 * clinic's doctor is answered exactly as a doctor that does not exist.
 */

const admin: Caller = { userId: 'admin-user', email: 'admin@harborview.test', role: 'admin' }
const doctor: Caller = { userId: 'doctor-user', email: 'doctor@harborview.test', role: 'doctor' }
const patient: Caller = { userId: 'patient-user', email: 'patient@harborview.test', role: 'patient' }

const doctors: Record<string, { docId: string; userId: string; clinicId: string }> = {
  'doc-own': { docId: 'doc-own', userId: 'own-doctor-user', clinicId: 'clinic-a' },
  'doc-other': { docId: 'doc-other', userId: 'other-doctor-user', clinicId: 'clinic-b' },
}

function store(overrides: Partial<ResetStore> = {}): ResetStore {
  return {
    clinicOfAdmin: vi.fn(async () => 'clinic-a'),
    doctorById: vi.fn(async (docId: string) => doctors[docId] ?? null),
    doctorOf: vi.fn(async () => ({ docId: 'doc-own', isActive: true })),
    patientById: vi.fn(async (patId: string) =>
      patId === 'pat-mine'
        ? { patId: 'pat-mine', userId: 'my-patient-user', docId: 'doc-own' }
        : patId === 'pat-theirs'
          ? { patId: 'pat-theirs', userId: 'their-patient-user', docId: 'doc-elsewhere' }
          : null,
    ),
    readAppMetadata: vi.fn(async () => ({ provider: 'email', must_change_password: false })),
    setTemporaryPassword: vi.fn(async () => undefined),
    audit: vi.fn(async () => undefined),
    ...overrides,
  }
}

const password = () => 'temporary-passphrase'
const resetDoctor = (doctorId: string): ResetRequest => ({ kind: 'doctor', doctorId })
const resetPatient = (patientId: string): ResetRequest => ({ kind: 'patient', patientId })

describe('reset-account-password', () => {
  describe('a Clinic Admin resetting a doctor', () => {
    it('reissues the credential of a doctor in their own clinic, keeping their other settings', async () => {
      const s = store()
      expect(await resetAccountPassword(admin, resetDoctor('doc-own'), s, password)).toEqual({
        status: 200,
        body: { temporaryPassword: 'temporary-passphrase' },
      })
      expect(s.setTemporaryPassword).toHaveBeenCalledWith('own-doctor-user', 'temporary-passphrase', {
        provider: 'email',
        must_change_password: true,
      })
      expect(s.audit).toHaveBeenCalledWith({
        userId: 'admin-user',
        action: 'update',
        entity: 'doctor_account',
        entityId: 'doc-own',
        details: { reason: 'credential_reset', reset_by_role: 'admin' },
      })
    })

    it('cannot reach another clinic’s doctor, and cannot tell that one exists', async () => {
      const elsewhere = store()
      const missing = store()
      const other = await resetAccountPassword(admin, resetDoctor('doc-other'), elsewhere, password)
      const nobody = await resetAccountPassword(admin, resetDoctor('doc-nobody'), missing, password)

      expect(other).toEqual({ status: 404, body: { error: 'That doctor account could not be found' } })
      expect(nobody).toEqual(other)
      expect(elsewhere.setTemporaryPassword).not.toHaveBeenCalled()
      expect(elsewhere.readAppMetadata).not.toHaveBeenCalled()
    })

    it('is refused to an administrator with no clinic', async () => {
      const s = store({ clinicOfAdmin: vi.fn(async () => null) })
      expect(await resetAccountPassword(admin, resetDoctor('doc-own'), s, password)).toEqual({
        status: 403,
        body: { error: 'Your administrator account is not assigned to a clinic' },
      })
      expect(s.setTemporaryPassword).not.toHaveBeenCalled()
    })

    it.each([
      ['the administrator’s clinic', { clinicOfAdmin: vi.fn(async () => { throw new Error('column admin.clinic_id does not exist') }) }],
      ['the doctor’s clinic', { doctorById: vi.fn(async () => { throw new Error('column doctor.clinic_id does not exist') }) }],
    ])('fails closed if %s cannot be read, as before migration 29: nothing changes', async (_label, overrides) => {
      const s = store(overrides as Partial<ResetStore>)
      const result = await resetAccountPassword(admin, resetDoctor('doc-own'), s, password)
      expect(result.status).toBe(503)
      expect(result.body.error).toMatch(/could not be confirmed, so nothing was changed/)
      expect(s.setTemporaryPassword).not.toHaveBeenCalled()
      expect(s.audit).not.toHaveBeenCalled()
    })

    it('is refused to doctors and patients', async () => {
      for (const caller of [doctor, patient]) {
        const s = store()
        expect((await resetAccountPassword(caller, resetDoctor('doc-own'), s, password)).status).toBe(403)
        expect(s.setTemporaryPassword).not.toHaveBeenCalled()
      }
    })
  })

  describe('a doctor resetting a patient', () => {
    it('reissues the credential of their own patient', async () => {
      const s = store()
      expect((await resetAccountPassword(doctor, resetPatient('pat-mine'), s, password)).status).toBe(200)
      expect(s.setTemporaryPassword).toHaveBeenCalledWith('my-patient-user', 'temporary-passphrase', expect.anything())
      expect(s.clinicOfAdmin).not.toHaveBeenCalled()
    })

    it('cannot reach another doctor’s patient', async () => {
      const s = store()
      expect(await resetAccountPassword(doctor, resetPatient('pat-theirs'), s, password)).toEqual({
        status: 403,
        body: { error: 'That patient is not assigned to you' },
      })
      expect(s.setTemporaryPassword).not.toHaveBeenCalled()
    })

    it('is refused once the doctor is deactivated', async () => {
      const s = store({ doctorOf: vi.fn(async () => ({ docId: 'doc-own', isActive: false })) })
      expect((await resetAccountPassword(doctor, resetPatient('pat-mine'), s, password)).status).toBe(403)
      expect(s.setTemporaryPassword).not.toHaveBeenCalled()
    })

    it('is refused to administrators, who have no clinical access', async () => {
      const s = store()
      expect(await resetAccountPassword(admin, resetPatient('pat-mine'), s, password)).toEqual({
        status: 403,
        body: { error: 'Only the assigned doctor can reset a patient account' },
      })
    })
  })

  it('never puts the password in an unexpected error’s answer or log', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const s = store({
      setTemporaryPassword: vi.fn(async () => {
        throw new Error('temporary-passphrase rejected')
      }),
    })
    const result = await resetAccountPassword(admin, resetDoctor('doc-own'), s, password)
    expect(result).toEqual({ status: 500, body: { error: 'That account could not be reset' } })
    expect(JSON.stringify(error.mock.calls)).not.toContain('temporary-passphrase')
    error.mockRestore()
  })
})
