import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Admin → System settings: QA-03's missed-dose grace period, and the
 * clinic's own settings and time zone (migration 31).
 *
 * The overdue job uses a whole number of hours from 1 to 24 and ignores
 * anything else, so the form refuses anything else before it is saved: the
 * administrator is told why, nothing is sent, and the stored value stands.
 * The chatbot guidance saves exactly what was typed. The time zone is the
 * clinic's: shown from the clinic, saved through its own function, and
 * refused before sending when it is not a zone at all.
 */

const api = vi.hoisted(() => ({
  fetchSystemSettings: vi.fn(),
  saveSystemSetting: vi.fn(),
  fetchClinicSettings: vi.fn(),
  saveClinicTimezone: vi.fn(),
}))

vi.mock('@/features/system-settings/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/system-settings/api')>()),
  fetchSystemSettings: api.fetchSystemSettings,
  saveSystemSetting: api.saveSystemSetting,
  fetchClinicSettings: api.fetchClinicSettings,
  saveClinicTimezone: api.saveClinicTimezone,
}))

vi.mock('@/features/auth/auth-context', () => ({
  useCurrentUser: () => ({
    userId: 'u-admin',
    role: 'admin',
    profile: { kind: 'admin', admin: { admin_id: 'admin-1' } },
  }),
}))

const { parseGraceHours, parseTimezone } = await import('@/features/system-settings/api')
const { SystemSettingsPage } = await import(
  '@/features/system-settings/pages/system-settings-page'
)

const GRACE = 'medication.reminder_grace_hours'
const MESSAGE = 'Enter a whole number of hours from 1 to 24.'

const VALID: [string, string][] = [
  ['1', '1'],
  ['2', '2'],
  ['6', '6'],
  ['12', '12'],
  ['24', '24'],
  [' 12 ', '12'],
  ['06', '6'],
]

const INVALID = [
  '0',
  '-1',
  '-6',
  '1.5',
  '6.0',
  'abc',
  '6 hours',
  '',
  '   ',
  '25',
  '100000',
  '2147483648',
  '+6',
  '1e1',
  '٦', // Arabic-Indic six
  '６', // full-width six
]

function stored(key: string, value: string) {
  return {
    system_setting_id: `set-${key}`,
    admin_id: 'admin-1',
    system_setting_key: key,
    system_setting_value: value,
    system_setting_updated_at: '2026-09-01T00:00:00Z',
  }
}

async function renderSettings(graceHours = '8') {
  // The time zone alias the website before migration 31 used is still a row;
  // this page ignores it and reads the clinic.
  api.fetchSystemSettings.mockResolvedValue([
    stored('app.timezone', 'Asia/Tokyo'),
    stored('chatbot.system_prompt', 'Be kind.'),
    stored(GRACE, graceHours),
  ])
  api.fetchClinicSettings.mockResolvedValue({
    clinic_id: 'clinic-1',
    clinic_timezone: 'Asia/Manila',
    clinic_updated_at: '2026-09-01T00:00:00Z',
  })
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SystemSettingsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return field('Missed dose grace period (hours)')
}

async function field(label: string) {
  const control = await screen.findByLabelText(label, { exact: true })
  const form = control.closest('form')
  if (!form) throw new Error(`${label} is not in a form`)
  return {
    control,
    type: (value: string) => fireEvent.change(control, { target: { value } }),
    save: () => fireEvent.click(within(form).getByRole('button', { name: 'Save' })),
    alert: () => within(form).queryByRole('alert'),
  }
}

/** Lets anything the click scheduled run before asserting it did not happen. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

beforeEach(() => {
  api.fetchSystemSettings.mockReset()
  api.saveSystemSetting.mockReset().mockResolvedValue(undefined)
  api.fetchClinicSettings.mockReset()
  api.saveClinicTimezone.mockReset().mockResolvedValue(undefined)
})

describe('reading a grace period', () => {
  it.each(VALID)('accepts %j as %j', (input, value) => {
    expect(parseGraceHours(input)).toEqual({ ok: true, value })
  })

  it.each(INVALID)('refuses %j', (input) => {
    expect(parseGraceHours(input)).toEqual({ ok: false, message: MESSAGE })
  })
})

describe('the grace period on the settings page', () => {
  it('shows the stored value and says what it accepts', async () => {
    const grace = await renderSettings('6')

    expect(grace.control).toHaveValue('6')
    expect(screen.getByText(/whole number of hours from 1 to 24/)).toBeInTheDocument()
    expect(grace.alert()).toBeNull()
  })

  it.each(VALID)('saves %j as %j', async (input, value) => {
    const grace = await renderSettings()

    grace.type(input)
    grace.save()

    await waitFor(() => expect(api.saveSystemSetting).toHaveBeenCalledTimes(1))
    expect(api.saveSystemSetting).toHaveBeenCalledWith({
      adminId: 'admin-1',
      clinicId: 'clinic-1',
      key: GRACE,
      value,
    })
    expect(grace.alert()).toBeNull()
  })

  it.each(INVALID)('refuses %j: says why, and sends nothing', async (input) => {
    const grace = await renderSettings()

    grace.type(input)
    grace.save()
    // A save would reach the API a few ticks after the click, not during it.
    await settle()

    expect(grace.alert()).toHaveTextContent(MESSAGE)
    expect(grace.control).toHaveAttribute('aria-invalid', 'true')
    // What was typed stays in front of the administrator to correct.
    expect(grace.control).toHaveValue(input)
    expect(api.saveSystemSetting).not.toHaveBeenCalled()
  })

  it('saves a corrected value after refusing one', async () => {
    const grace = await renderSettings()

    grace.type('0')
    grace.save()
    expect(grace.alert()).toHaveTextContent(MESSAGE)

    grace.type('2')
    expect(grace.alert()).toBeNull()
    grace.save()

    await waitFor(() =>
      expect(api.saveSystemSetting).toHaveBeenCalledWith({
        adminId: 'admin-1',
        clinicId: 'clinic-1',
        key: GRACE,
        value: '2',
      }),
    )
    expect(api.saveSystemSetting).toHaveBeenCalledTimes(1)
  })
})

describe('reading a time zone', () => {
  it.each([
    ['Asia/Manila', 'Asia/Manila'],
    [' Asia/Singapore ', 'Asia/Singapore'],
    ['asia/manila', 'Asia/Manila'],
    ['UTC', 'UTC'],
  ])('accepts %j as %j', (input, value) => {
    expect(parseTimezone(input)).toEqual({ ok: true, value })
  })

  it.each(['Mars/Olympus_Mons', '0', 'Manila', '+08:00', 'UTC+8'])('refuses %j', (input) => {
    expect(parseTimezone(input)).toEqual({
      ok: false,
      message: 'Enter a time zone name, such as Asia/Manila or Asia/Singapore.',
    })
  })

  it('asks for one when the field is empty', () => {
    expect(parseTimezone('   ')).toEqual({ ok: false, message: 'Enter a time zone, such as Asia/Manila.' })
  })
})

describe('the clinic time zone (migration 31)', () => {
  it('is the clinic’s, not the old setting’s, and the page says the settings are the clinic’s', async () => {
    await renderSettings()
    const zone = await field('Clinic time zone')

    expect(zone.control).toHaveValue('Asia/Manila')
    expect(screen.getByText(/Configuration for your clinic/)).toBeInTheDocument()
  })

  it('is saved through the clinic’s own function, in its canonical spelling, and nothing else is saved', async () => {
    await renderSettings()
    const zone = await field('Clinic time zone')

    zone.type(' asia/singapore ')
    zone.save()

    await waitFor(() => expect(api.saveClinicTimezone).toHaveBeenCalledWith('Asia/Singapore'))
    expect(api.saveSystemSetting).not.toHaveBeenCalled()
    expect(zone.alert()).toBeNull()
  })

  it('is refused before sending when it is not a time zone', async () => {
    await renderSettings()
    const zone = await field('Clinic time zone')

    zone.type('Mars/Olympus_Mons')
    zone.save()
    await settle()

    expect(zone.alert()).toHaveTextContent('Enter a time zone name, such as Asia/Manila or Asia/Singapore.')
    expect(zone.control).toHaveAttribute('aria-invalid', 'true')
    expect(api.saveClinicTimezone).not.toHaveBeenCalled()
  })

  it('shows the database’s refusal when its own list of zones does not have it', async () => {
    // The browser's list and the database's can differ; the database decides.
    api.saveClinicTimezone.mockRejectedValue(new Error('Unknown time zone: Asia/Singapore'))
    await renderSettings()
    const zone = await field('Clinic time zone')

    zone.type('Asia/Singapore')
    zone.save()

    expect(await screen.findByText(/Unknown time zone: Asia\/Singapore/)).toBeInTheDocument()
    expect(screen.getByText('The setting was not saved')).toBeInTheDocument()
  })
})

describe('the chatbot guidance', () => {
  it('saves the chatbot guidance exactly as typed', async () => {
    await renderSettings()
    const guidance = await field('Chatbot guidance')

    guidance.type('Be kind.\nNever diagnose. 25')
    guidance.save()

    await waitFor(() =>
      expect(api.saveSystemSetting).toHaveBeenCalledWith({
        adminId: 'admin-1',
        clinicId: 'clinic-1',
        key: 'chatbot.system_prompt',
        value: 'Be kind.\nNever diagnose. 25',
      }),
    )
    expect(guidance.alert()).toBeNull()
  })
})
