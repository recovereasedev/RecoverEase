-- ===========================================================================
-- STAGING ONLY. Run once, on a NEW, EMPTY staging project, BEFORE any
-- migration.
-- ===========================================================================
-- New Supabase projects no longer grant the API roles on new objects in
-- `public`. Every RecoverEase migration was written for the old default,
-- which production still has: anon, authenticated and service_role get every
-- table, sequence and function as it is created (read from
-- kwsezszstdagzllbyjuk's pg_default_acl, 2026-11-27). The migrations then
-- revoke what each role must not have.
--
-- This puts the same default back for objects the migrations create. It must
-- run first: granting after the migrations would undo their revokes.
-- It refuses if `public` already has a table, so it can never run on
-- production or on a staging project that is already set up.
-- ===========================================================================

do $$
begin
  if exists (select 1 from pg_tables where schemaname = 'public') then
    raise exception 'public already has tables: this is not a new, empty staging project. Nothing was changed.';
  end if;
end
$$;

alter default privileges for role postgres in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on functions to anon, authenticated, service_role;
