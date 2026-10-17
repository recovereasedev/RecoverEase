import { supabase } from '@/lib/supabase/client'
import type { Tables } from '@/types/database.types'

export type SystemSetting = Tables<'system_setting'>

/** The administrator's clinic, as far as its settings need it. */
export type ClinicSettings = Pick<
  Tables<'clinic'>,
  'clinic_id' | 'clinic_timezone' | 'clinic_updated_at'
>

/** What a setting makes of a value typed in: the value to store, or why not. */
export type SettingParseResult =
  | { ok: true; value: string }
  | { ok: false; message: string }

/**
 * QA-03. The overdue job reads the missed-dose grace period as a whole number
 * of hours from 1 to 24, and falls back to six hours on anything else
 * (migration 20260902100024). The same rule is checked here so that an
 * administrator is told at once, rather than saving a value the job then
 * ignores. ASCII digits only; spaces around the number and leading zeros are
 * ignored, and the number is stored without them.
 */
const GRACE_HOURS = /^0*([1-9]|1[0-9]|2[0-4])$/

export function parseGraceHours(input: string): SettingParseResult {
  const hours = GRACE_HOURS.exec(input.trim())?.[1]
  return hours === undefined
    ? { ok: false, message: 'Enter a whole number of hours from 1 to 24.' }
    : { ok: true, value: hours }
}

/**
 * A named zone in the shape the database lists them: UTC, GMT or Area/City.
 * Browsers also accept offsets such as "+08:00", which the database does not.
 */
const NAMED_ZONE = /^(?:UTC|GMT|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)$/

/**
 * A time zone the browser knows, in its canonical spelling ("asia/manila"
 * becomes "Asia/Manila"). The database checks it again against its own list
 * of zones, which is the one that counts.
 */
export function parseTimezone(input: string): SettingParseResult {
  const zone = input.trim()
  if (zone === '') {
    return { ok: false, message: 'Enter a time zone, such as Asia/Manila.' }
  }
  if (!NAMED_ZONE.test(zone)) {
    return { ok: false, message: 'Enter a time zone name, such as Asia/Manila or Asia/Singapore.' }
  }
  try {
    const canonical = new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone
    return { ok: true, value: canonical }
  } catch {
    return { ok: false, message: 'Enter a time zone name, such as Asia/Manila or Asia/Singapore.' }
  }
}

/**
 * The clinic's time zone (migration 31). It belongs to the clinic rather
 * than being a stored setting, and is saved through its own audited
 * function; the form shows it like any other setting.
 */
export const TIMEZONE_DEFINITION = {
  key: 'clinic.timezone',
  label: 'Clinic time zone',
  description:
    'Medication times are wall-clock times in this zone. A dose set for 08:00 means 08:00 here. It also decides "today", reminder hours and the dates in notifications.',
  placeholder: 'Asia/Manila',
  multiline: false,
  parse: parseTimezone,
} as const

/**
 * The settings the application understands, with the guidance an
 * administrator needs to set them sensibly. Each is the administrator's own
 * clinic's (migration 31).
 *
 * Declaring them here rather than letting arbitrary keys be typed in means
 * the settings screen can explain each one, and a typo cannot silently create
 * a setting nothing reads.
 */
export const SETTING_DEFINITIONS = [
  {
    key: 'chatbot.system_prompt',
    label: 'Chatbot guidance',
    description:
      'Instructions given to the guidance chatbot before each conversation. Keep it explicit that it must not diagnose or change a prescription.',
    placeholder:
      'You support patients recovering after treatment. Do not diagnose…',
    multiline: true,
  },
  {
    key: 'medication.reminder_grace_hours',
    label: 'Missed dose grace period (hours)',
    description:
      'How long after a scheduled time a dose stays open before it is recorded as missed. A whole number of hours from 1 to 24.',
    placeholder: '6',
    multiline: false,
    parse: parseGraceHours,
  },
] as const

export type SettingKey = (typeof SETTING_DEFINITIONS)[number]['key']

/**
 * Module 14.1 "Configure System Settings": the administrator's clinic's
 * settings, which is all Row Level Security returns.
 */
export async function fetchSystemSettings(): Promise<SystemSetting[]> {
  const { data, error } = await supabase
    .from('system_setting')
    .select('*')
    .order('system_setting_key', { ascending: true })

  if (error) throw error
  return data
}

/**
 * Upsert on the clinic and key, which are unique together in the database.
 * Using insert-or-update here means the settings form does not need to know
 * whether a value has ever been saved before. The clinic is sent to name the
 * row; the database sets it from the administrator regardless.
 */
export async function saveSystemSetting(input: {
  adminId: string
  clinicId: string
  key: string
  value: string
}): Promise<void> {
  const { error } = await supabase.from('system_setting').upsert(
    {
      admin_id: input.adminId,
      clinic_id: input.clinicId,
      system_setting_key: input.key,
      system_setting_value: input.value,
    },
    { onConflict: 'clinic_id,system_setting_key' },
  )

  if (error) throw error
}

/** The administrator's clinic: its time zone, and when it last changed. */
export async function fetchClinicSettings(): Promise<ClinicSettings> {
  const { data, error } = await supabase
    .from('clinic')
    .select('clinic_id, clinic_timezone, clinic_updated_at')
    .maybeSingle()

  if (error) throw error
  if (!data) throw new Error('Your clinic could not be found.')
  return data
}

/** Sets the administrator's clinic's time zone. Refused for an unknown zone. */
export async function saveClinicTimezone(timezone: string): Promise<void> {
  const { error } = await supabase.rpc('admin_set_clinic_timezone', {
    new_timezone: timezone,
  })

  if (error) throw error
}

export function settingsToMap(
  settings: SystemSetting[],
): Record<string, string> {
  return Object.fromEntries(
    settings.map((setting) => [
      setting.system_setting_key,
      setting.system_setting_value,
    ]),
  )
}
