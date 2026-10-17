import { describe, expect, it, vi } from 'vitest'

import { AuthError, type Caller } from '../../supabase/functions/_shared/caller'
import {
  createAccount,
  refusalFromDatabase,
  type AccountStore,
  type CreateAccountRequest,
} from '../../supabase/functions/create-account/handler'

/**
 * create-account's rules, with Supabase replaced by a recording store.
 *
 * What matters is the order as much as the outcome: anything that can refuse
 * must refuse before a login exists, and once one does, any failure must
 * remove it - or the email is taken by a sign-in with no account behind it.
 */

const admin: Caller = { userId: 'admin-user', email: 'admin@harborview.test', role: 'admin' }
const doctor: Caller = { userId: 'doctor-user', email: 'doctor@harborview.test', role: 'doctor' }
const patient: Caller = { userId: 'patient-user', email: 'patient@harborview.test', role: 'patient' }
const superAdmin: Caller = { userId: 'super-user', email: 'super@platform.test', role: 'super_admin' }

const CLINIC = '7d2f3c1e-8a4b-4c5d-9e6f-0a1b2c3d4e5f'

const newClinicAdmin: CreateAccountRequest = {
  kind: 'clinic_admin',
  email: ' New.Admin@Lakeside.test ',
  firstName: ' Lena ',
  lastName: 'Hart',
  clinicId: CLINIC,
}

const newDoctor: CreateAccountRequest = {
  kind: 'doctor',
  email: 'New.Doctor@Harborview.test',
  firstName: ' Nina ',
  lastName: 'Reyes',
  licenseNo: 'LIC-NEW-1',
  specialization: 'Orthopaedics',
}

const newPatient: CreateAccountRequest = {
  kind: 'patient',
  email: 'new.patient@harborview.test',
  firstName: 'Paolo',
  lastName: 'Cruz',
}

function store(overrides: Partial<AccountStore> = {}) {
  const calls: string[] = []
  const record =
    <A extends unknown[], R>(name: string, value: (...args: A) => R) =>
    (...args: A) => {
      calls.push(name)
      return value(...args)
    }
  const base: AccountStore = {
    clinicOfAdmin: vi.fn(record('clinicOfAdmin', async () => 'clinic-a')),
    doctorOf: vi.fn(record('doctorOf', async () => ({ docId: 'doc-1', isActive: true }))),
    createLogin: vi.fn(record('createLogin', async () => 'new-user')),
    deleteLogin: vi.fn(record('deleteLogin', async () => undefined)),
    insertAccount: vi.fn(record('insertAccount', async () => undefined)),
    insertDoctor: vi.fn(record('insertDoctor', async () => 'new-doc')),
    insertPatient: vi.fn(record('insertPatient', async () => 'new-pat')),
    audit: vi.fn(record('audit', async () => undefined)),
    checkClinicForAdmin: vi.fn(record('checkClinicForAdmin', async () => undefined)),
    createClinicAdminLogin: vi.fn(record('createClinicAdminLogin', async () => 'new-admin-user')),
    attachClinicAdmin: vi.fn(record('attachClinicAdmin', async () => 'new-admin')),
    sendPasswordSetup: vi.fn(record('sendPasswordSetup', async () => true)),
  }
  return { store: { ...base, ...overrides }, calls }
}

const password = () => 'temporary-passphrase'

describe('create-account', () => {
  describe('registering a doctor', () => {
    it('puts the doctor in the administrator’s own clinic', async () => {
      const { store: s } = store()
      const result = await createAccount(admin, newDoctor, s, password)

      expect(result).toEqual({
        status: 201,
        body: { userId: 'new-user', profileId: 'new-doc', temporaryPassword: 'temporary-passphrase' },
      })
      expect(s.clinicOfAdmin).toHaveBeenCalledWith('admin-user')
      expect(s.createLogin).toHaveBeenCalledWith('new.doctor@harborview.test', 'temporary-passphrase')
      expect(s.insertAccount).toHaveBeenCalledWith({
        userId: 'new-user',
        email: 'new.doctor@harborview.test',
        role: 'doctor',
      })
      expect(s.insertDoctor).toHaveBeenCalledWith({
        userId: 'new-user',
        clinicId: 'clinic-a',
        firstName: 'Nina',
        lastName: 'Reyes',
        licenseNo: 'LIC-NEW-1',
        specialization: 'Orthopaedics',
        contactNo: null,
      })
      expect(s.audit).toHaveBeenCalledWith({
        userId: 'admin-user',
        action: 'create',
        entity: 'doctor_account',
        entityId: 'new-doc',
        details: { created_by_role: 'admin' },
      })
    })

    it('ignores any clinic the request names', async () => {
      const { store: s } = store()
      await createAccount(admin, { ...newDoctor, clinicId: 'clinic-b' } as CreateAccountRequest, s, password)
      expect(s.insertDoctor).toHaveBeenCalledWith(expect.objectContaining({ clinicId: 'clinic-a' }))
    })

    it('is refused, before any login exists, to an administrator with no clinic', async () => {
      const { store: s, calls } = store({ clinicOfAdmin: vi.fn(async () => null) })
      expect(await createAccount(admin, newDoctor, s, password)).toEqual({
        status: 403,
        body: { error: 'Your administrator account is not assigned to a clinic' },
      })
      expect(calls).not.toContain('createLogin')
    })

    it('fails closed if deployed before migration 29: nothing is created', async () => {
      // admin.clinic_id does not exist yet, so the lookup itself fails.
      const { store: s, calls } = store({
        clinicOfAdmin: vi.fn(async () => {
          throw new Error('column admin.clinic_id does not exist')
        }),
      })
      const result = await createAccount(admin, newDoctor, s, password)
      expect(result.status).toBe(503)
      expect(result.body.error).toMatch(/clinic could not be confirmed, so nothing was changed/)
      expect(calls).not.toContain('createLogin')
      expect(calls).not.toContain('deleteLogin')
    })

    it('checks the licence number before creating a login', async () => {
      const { store: s, calls } = store()
      expect(await createAccount(admin, { ...newDoctor, licenseNo: '  ' }, s, password)).toEqual({
        status: 400,
        body: { error: 'Licence number is required' },
      })
      expect(calls).not.toContain('createLogin')
    })

    it('is refused to doctors and patients', async () => {
      for (const caller of [doctor, patient]) {
        const { store: s, calls } = store()
        expect(await createAccount(caller, newDoctor, s, password)).toEqual({
          status: 403,
          body: { error: 'Only an administrator can register a doctor account' },
        })
        expect(calls).toEqual([])
      }
    })
  })

  describe('registering a patient', () => {
    it('assigns the patient to the doctor registering them, whatever the request says', async () => {
      const { store: s } = store()
      const result = await createAccount(
        doctor,
        { ...newPatient, doctorId: 'someone-else' } as CreateAccountRequest,
        s,
        password,
      )
      expect(result.status).toBe(201)
      expect(s.insertPatient).toHaveBeenCalledWith(expect.objectContaining({ userId: 'new-user', docId: 'doc-1' }))
      // A patient's clinic is their doctor's: no clinic is looked up or sent.
      expect(s.clinicOfAdmin).not.toHaveBeenCalled()
      expect(s.audit).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'patient_account', entityId: 'new-pat', details: { created_by_role: 'doctor' } }),
      )
    })

    it('is refused, before any login exists, to a deactivated doctor', async () => {
      const { store: s, calls } = store({ doctorOf: vi.fn(async () => ({ docId: 'doc-1', isActive: false })) })
      expect(await createAccount(doctor, newPatient, s, password)).toEqual({
        status: 403,
        body: { error: 'A deactivated account cannot register patients' },
      })
      expect(calls).not.toContain('createLogin')
    })

    it('is refused to administrators and patients', async () => {
      for (const caller of [admin, patient]) {
        const { store: s, calls } = store()
        expect((await createAccount(caller, newPatient, s, password)).status).toBe(403)
        expect(calls).toEqual([])
      }
    })
  })

  describe('a failure after the login exists', () => {
    it.each([
      ['the account row', { insertAccount: vi.fn(async () => { throw new AuthError('account refused', 400) }) }],
      ['the doctor profile', { insertDoctor: vi.fn(async () => { throw new AuthError('profile refused', 400) }) }],
    ])('removes the login when %s cannot be written', async (_label, overrides) => {
      const { store: s } = store(overrides as Partial<AccountStore>)
      const result = await createAccount(admin, newDoctor, s, password)
      expect(result.status).toBe(400)
      expect(s.deleteLogin).toHaveBeenCalledWith('new-user')
    })

    it('still reports the original failure if removing the login fails too', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const { store: s } = store({
        insertPatient: vi.fn(async () => {
          throw new AuthError('profile refused', 400)
        }),
        deleteLogin: vi.fn(async () => {
          throw new Error('auth unavailable')
        }),
      })
      expect(await createAccount(doctor, newPatient, s, password)).toEqual({
        status: 400,
        body: { error: 'profile refused' },
      })
      expect(error).toHaveBeenCalledWith('orphan cleanup failed', 'auth unavailable')
      error.mockRestore()
    })

    it('answers an unexpected error with a plain message, never its details', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const { store: s } = store({
        insertDoctor: vi.fn(async () => {
          throw new Error('connection reset by peer')
        }),
      })
      expect(await createAccount(admin, newDoctor, s, password)).toEqual({
        status: 500,
        body: { error: 'The account could not be created' },
      })
      expect(s.deleteLogin).toHaveBeenCalledWith('new-user')
      error.mockRestore()
    })
  })

  it('does not remove anything when the email is already taken', async () => {
    const { store: s } = store({
      createLogin: vi.fn(async () => {
        throw new AuthError('An account already exists for that email address', 409)
      }),
    })
    expect(await createAccount(admin, newDoctor, s, password)).toEqual({
      status: 409,
      body: { error: 'An account already exists for that email address' },
    })
    expect(s.deleteLogin).not.toHaveBeenCalled()
  })

  describe('adding a Clinic Admin (a Super Admin, migration 33)', () => {
    it('asks the database first, then creates the login, then attaches it - and hands over no password', async () => {
      const { store: s, calls } = store()
      const result = await createAccount(superAdmin, newClinicAdmin, s, password)

      expect(result).toEqual({
        status: 201,
        body: { userId: 'new-admin-user', profileId: 'new-admin', clinicId: CLINIC, setupEmailSent: true },
      })
      expect(JSON.stringify(result)).not.toContain('temporary-passphrase')
      expect(calls).toEqual(['checkClinicForAdmin', 'createClinicAdminLogin', 'attachClinicAdmin', 'sendPasswordSetup'])
      expect(s.checkClinicForAdmin).toHaveBeenCalledWith(CLINIC)
      expect(s.createClinicAdminLogin).toHaveBeenCalledWith('new.admin@lakeside.test', CLINIC)
      expect(s.attachClinicAdmin).toHaveBeenCalledWith({
        userId: 'new-admin-user',
        clinicId: CLINIC,
        firstName: 'Lena',
        lastName: 'Hart',
      })
      expect(s.sendPasswordSetup).toHaveBeenCalledWith('new.admin@lakeside.test')
      // Neither the handover password nor the doctor and patient path is used.
      expect(s.createLogin).not.toHaveBeenCalled()
      expect(s.insertAccount).not.toHaveBeenCalled()
    })

    it.each([
      ['a Clinic Admin', admin],
      ['a doctor', doctor],
      ['a patient', patient],
    ])('is refused to %s, before anything is asked or created', async (_label, caller) => {
      const { store: s, calls } = store()
      expect(await createAccount(caller, newClinicAdmin, s, password)).toEqual({
        status: 403,
        body: { error: 'Only a Super Admin can add a Clinic Admin' },
      })
      expect(calls).toEqual([])
    })

    it('takes no role from the request, and has no kind that makes a Super Admin', async () => {
      const { store: s } = store()
      const withRole = { ...newClinicAdmin, role: 'super_admin' } as CreateAccountRequest
      await createAccount(superAdmin, withRole, s, password)
      // The database makes a Clinic Admin; nothing else the request says reaches it.
      expect(s.attachClinicAdmin).toHaveBeenCalledWith({
        userId: 'new-admin-user', clinicId: CLINIC, firstName: 'Lena', lastName: 'Hart',
      })

      const { store: s2, calls: calls2 } = store()
      const asSuperAdmin = { ...newClinicAdmin, kind: 'super_admin' } as unknown as CreateAccountRequest
      expect(await createAccount(superAdmin, asSuperAdmin, s2, password)).toEqual({
        status: 400,
        body: { error: 'Unknown account kind' },
      })
      expect(calls2).toEqual([])
    })

    it.each([
      ['no clinic', { clinicId: undefined }, 'Choose the clinic they will administer'],
      ['a clinic that is not an id', { clinicId: 'harborview' }, 'Choose the clinic they will administer'],
      ['a bad email', { email: 'not-an-email' }, 'Enter a valid email address'],
      ['no first name', { firstName: '  ' }, 'First name is required'],
    ])('checks %s before asking the database or creating anything', async (_label, change, message) => {
      const { store: s, calls } = store()
      const body = { ...newClinicAdmin, ...change } as CreateAccountRequest
      expect(await createAccount(superAdmin, body, s, password)).toEqual({ status: 400, body: { error: message } })
      expect(calls).toEqual([])
    })

    it('creates no login when the database refuses the Super Admin or the clinic', async () => {
      const { store: s } = store({
        checkClinicForAdmin: vi.fn(async () => {
          throw refusalFromDatabase({
            code: '42501',
            message: 'Super Admin access requires a current session verified with an authenticator app',
          })
        }),
      })
      expect(await createAccount(superAdmin, newClinicAdmin, s, password)).toEqual({
        status: 403,
        body: { error: 'Super Admin access requires a current session verified with an authenticator app' },
      })
      expect(s.createClinicAdminLogin).not.toHaveBeenCalled()
      expect(s.attachClinicAdmin).not.toHaveBeenCalled()
    })

    it('removes the login when the database will not attach it', async () => {
      const { store: s } = store({
        attachClinicAdmin: vi.fn(async () => {
          throw refusalFromDatabase({ code: '55000', message: 'That clinic is inactive and cannot take a new Clinic Admin' })
        }),
      })
      expect(await createAccount(superAdmin, newClinicAdmin, s, password)).toEqual({
        status: 409,
        body: { error: 'That clinic is inactive and cannot take a new Clinic Admin' },
      })
      expect(s.deleteLogin).toHaveBeenCalledWith('new-admin-user')
      expect(s.sendPasswordSetup).not.toHaveBeenCalled()
    })

    it('still creates the account when the setup email cannot be sent, and says so', async () => {
      const { store: s } = store({
        sendPasswordSetup: vi.fn(async () => {
          throw new Error('rate limited')
        }),
      })
      expect(await createAccount(superAdmin, newClinicAdmin, s, password)).toEqual({
        status: 201,
        body: { userId: 'new-admin-user', profileId: 'new-admin', clinicId: CLINIC, setupEmailSent: false },
      })
      expect(s.deleteLogin).not.toHaveBeenCalled()
    })
  })

  describe('the database\u2019s refusals', () => {
    it.each([
      ['42501', 403],
      ['P0002', 404],
      ['55000', 409],
      ['23505', 409],
      ['23514', 400],
    ])('keep their own message for %s, as %s', (code, status) => {
      const refusal = refusalFromDatabase({ code, message: 'Written for the reader' })
      expect(refusal).toBeInstanceOf(AuthError)
      expect(refusal).toMatchObject({ status, message: 'Written for the reader' })
    })

    it('fail closed with a plain message for anything else, such as a missing function', () => {
      const refusal = refusalFromDatabase({
        code: 'PGRST202',
        message: 'Could not find the function public.super_admin_check_clinic_for_admin',
      })
      expect(refusal).toMatchObject({ status: 503, message: 'Clinic Admins cannot be added right now. Nothing was created.' })
      expect(refusalFromDatabase({})).toMatchObject({ status: 503 })
    })
  })
})
