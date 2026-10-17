-- ===========================================================================
-- RecoverEase — 25. A role for the Super Admin
-- ===========================================================================
-- Phase A, PR 4. Adds `super_admin` to `user_role`, and nothing else.
--
-- It is a migration of its own because PostgreSQL will not let a new enum
-- value be used in the transaction that adds it, and migration 33 uses it
-- throughout: in policies, functions and guards.
--
-- Adding the value gives no one anything. No account has it; the account
-- guard (migrations 27 and 28) already refuses every role write from the
-- browser; and migration 33 refuses `super_admin` to every writer except the
-- owner-only provisioning procedure. Until 33 is applied, the service role
-- could still write the value, as it can write any role today - so 33 is
-- applied straight after this one.
--
-- Rollback: PostgreSQL cannot remove a value from an enum without
-- recreating the type and everything that uses it. The value is left in
-- place, unused, if migration 33 is rolled back (see that rollback).
-- ===========================================================================

alter type public.user_role add value if not exists 'super_admin';

comment on type public.user_role is
  'An account''s role: patient, doctor, admin (a Clinic Admin) or '
  'super_admin (the platform''s administrator, migration 33). Fixed when the '
  'account is created, and written only by the server.';
