import { supabase } from '@/lib/supabase/client'
import type { Tables } from '@/types/database.types'

export type SystemSetting = Tables<'system_setting'>

/**
 * The settings the application understands, with the guidance an
 * administrator needs to set them sensibly.
 *
 * Declaring them here rather than letting arbitrary keys be typed in means
 * the settings screen can explain each one, and a typo cannot silently create
 * a setting nothing reads.
 */
export const SETTING_DEFINITIONS = [
  {
    key: 'app.timezone',
    label: 'Clinic time zone',
    description:
      'Medication times are wall-clock times in this zone. A dose set for 08:00 means 08:00 here.',
    placeholder: 'Asia/Manila',
    multiline: false,
  },
  {
    key: 'chatbot.system_prompt',
    label: 'Chatbot guidance',
    description:
      'Module 8.7. Instructions given to the guidance chatbot before each conversation. Keep it explicit that it must not diagnose or change a prescription.',
    placeholder:
      'You support patients recovering after treatment. Do not diagnose…',
    multiline: true,
  },
  {
    key: 'medication.reminder_grace_hours',
    label: 'Missed dose grace period (hours)',
    description:
      'How long after a scheduled time a dose stays open before it is recorded as missed.',
    placeholder: '6',
    multiline: false,
  },
] as const

export type SettingKey = (typeof SETTING_DEFINITIONS)[number]['key']

/** Module 14.1 "Configure System Settings". */
export async function fetchSystemSettings(): Promise<SystemSetting[]> {
  const { data, error } = await supabase
    .from('system_setting')
    .select('*')
    .order('system_setting_key', { ascending: true })

  if (error) throw error
  return data
}

/**
 * Upsert on the key, which is unique in the database. Using insert-or-update
 * here means the settings form does not need to know whether a value has ever
 * been saved before.
 */
export async function saveSystemSetting(input: {
  adminId: string
  key: string
  value: string
}): Promise<void> {
  const { error } = await supabase.from('system_setting').upsert(
    {
      admin_id: input.adminId,
      system_setting_key: input.key,
      system_setting_value: input.value,
    },
    { onConflict: 'system_setting_key' },
  )

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
