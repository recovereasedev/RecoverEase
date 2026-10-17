-- ===========================================================================
-- RecoverEase — 27. A second clinic may exist
-- ===========================================================================
-- Phase A, PR 4. Drops the two indexes that kept the platform to one clinic,
-- and nothing else:
--
--   * `clinic_single_clinic_gate` (migration 28), which allowed one clinic
--     row "until every settings reader is clinic-aware";
--   * `system_setting_key_unique`, the key-only index migration 31 kept for
--     the settings screen deployed before it. That screen has been replaced
--     (PR #40 saves on the clinic and key), and with the index a second
--     clinic could not have a single setting of its own.
--     `system_setting_clinic_key_unique` (migration 31) stays: one of each
--     setting per clinic.
--
-- Why it is safe now - every reader that used to assume one clinic resolves
-- the clinic from its own row (migration 31), and each is shown with two
-- clinics in tests/db (clinic-isolation, clinic-settings, d8-appointments,
-- super-admin, gate-lift):
--
--   * "today", dose slots and their nightly extension, missed doses (each
--     clinic's own grace period), dose and appointment reminders,
--     cancellation notices, course end, birth and recovery date checks;
--   * settings: every policy, the settings screen and admin_set_clinic_timezone
--     work on the caller's clinic; the old `app.timezone` row is one clinic's
--     alias, passed only to that clinic, and a new clinic gets none;
--   * chatbot-reply v15 reads the patient's clinic's prompt by clinic and key,
--     and the built-in guidance when there is none - never another clinic's;
--   * announcements, reports, the audit log, dashboard counts and D8 are
--     scoped to the Clinic Admin's clinic (migration 30); platform entries
--     and announcements to the Super Admin (migration 33).
--
-- What still assumes a single clinic does so by refusing, never by guessing:
-- `app_today()` and the settings and doctor clinic defaults, asked by a
-- server-side writer that names no clinic, raise once there are two. Every
-- writer the application has names its clinic, or is a member whose clinic
-- is known.
--
-- This adds no clinic. A clinic is created only by a Super Admin
-- (`super_admin_create_clinic`, migration 33).
--
-- Rollback, should it be needed:
-- supabase/rollbacks/20260902100034_lift_single_clinic_gate.down.sql. It
-- restores both indexes, and refuses once a second clinic exists: two
-- clinics cannot be made one by an index. tests/db/super-admin-rollback.test.ts
-- covers both.
-- ===========================================================================

do $$
begin
  if to_regclass('public.system_setting_clinic_key_unique') is null then
    raise exception 'Migration 34 needs migration 31''s per-clinic settings index first. Nothing was applied.';
  end if;

  if to_regclass('public.super_admin') is null then
    raise exception 'Migration 34 needs migration 33 first: a clinic is created only by a Super Admin. Nothing was applied.';
  end if;
end
$$;

drop index if exists public.clinic_single_clinic_gate;
drop index if exists public.system_setting_key_unique;

comment on table public.clinic is
  'A clinic using RecoverEase. Doctors and Clinic Admins belong to one '
  'directly (migration 29); patients through their assigned doctor. Created '
  'and managed only by a Super Admin (migration 33); never deleted.';
