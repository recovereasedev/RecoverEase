import type { TestDatabase } from './database'

/**
 * What the later gate-lift migration will do, in a test's own database only:
 * drop the single-clinic gate, and the key-only settings index that the
 * settings screen deployed before migration 31 still relies on. Production
 * keeps both until every reader of a setting is clinic-aware.
 */
export async function liftSingleClinicGate(database: TestDatabase): Promise<void> {
  await database.db.exec(`
    drop index if exists public.clinic_single_clinic_gate;
    drop index if exists public.system_setting_key_unique;
  `)
}

/** Adds a clinic, once the gate has been lifted. */
export async function addClinic(
  database: TestDatabase,
  name: string,
  timezone: string,
): Promise<string> {
  const [row] = await database.asService<{ clinic_id: string }>(
    `insert into public.clinic (clinic_name, clinic_timezone)
     values ($1, $2) returning clinic_id`,
    [name, timezone],
  )
  return row!.clinic_id
}
