import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * QA-03 — the missed-dose grace period on Admin → System settings.
 *
 * The overdue job uses a whole number of hours from 1 to 24 and ignores
 * anything else, so the form refuses anything else before it is saved: the
 * administrator is told why, nothing is sent, and the stored value stands.
 * The other settings still save exactly what was typed.
 */

const api = vi.hoisted(() => ({
  fetchSystemSettings: vi.fn(),
  saveSystemSetting: vi.fn(),
}))

vi.mock('@/features/system-settings/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/system-settings/api')>()),
  fetchSystemSettings: api.fetchSystemSettings,
  saveSystemSetting: api.saveSystemSetting,
}))

vi.mock('@/features/auth/auth-context', () => ({
  useCurrentUser: () => ({
    userId: 'u-admin',
    role: 'admin',
    profile: { kind: 'admin', admin: { admin_id: 'admin-1' } },
  }),
}))

const { parseGraceHours } = await import('@/features/system-settings/api')
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
  api.fetchSystemSettings.mockResolvedValue([
    stored('app.timezone', 'Asia/Manila'),
    stored('chatbot.system_prompt', 'Be kind.'),
    stored(GRACE, graceHours),
  ])
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
        key: GRACE,
        value: '2',
      }),
    )
    expect(api.saveSystemSetting).toHaveBeenCalledTimes(1)
  })
})

describe('the other settings are unchanged', () => {
  it('saves the clinic time zone exactly as typed', async () => {
    await renderSettings()
    const zone = await field('Clinic time zone')

    zone.type(' 0 ')
    zone.save()

    await waitFor(() =>
      expect(api.saveSystemSetting).toHaveBeenCalledWith({
        adminId: 'admin-1',
        key: 'app.timezone',
        value: ' 0 ',
      }),
    )
    expect(zone.alert()).toBeNull()
  })

  it('saves the chatbot guidance exactly as typed', async () => {
    await renderSettings()
    const guidance = await field('Chatbot guidance')

    guidance.type('Be kind.\nNever diagnose. 25')
    guidance.save()

    await waitFor(() =>
      expect(api.saveSystemSetting).toHaveBeenCalledWith({
        adminId: 'admin-1',
        key: 'chatbot.system_prompt',
        value: 'Be kind.\nNever diagnose. 25',
      }),
    )
    expect(guidance.alert()).toBeNull()
  })
})
