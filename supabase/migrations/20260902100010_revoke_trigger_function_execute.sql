-- ===========================================================================
-- RecoverEase — 11. Close trigger functions to the Data API
-- ===========================================================================
-- Raised by the live Supabase security advisor
-- (anon/authenticated_security_definer_function_executable) after the first
-- deployment.
--
-- PostgreSQL grants EXECUTE to PUBLIC on every new function, and PostgREST
-- exposes anything in `public` as /rest/v1/rpc/<name>. That made every
-- trigger function a callable endpoint for both anon and authenticated.
--
-- Calling one directly fails ("trigger functions can only be called as
-- triggers"), so this was not exploitable — but an endpoint that exists only
-- to error is still surface that should not be reachable, and three of them
-- were SECURITY DEFINER.
--
-- Revoking EXECUTE does NOT stop the triggers firing: PostgreSQL does not
-- check EXECUTE on a trigger function when the trigger runs, only when it is
-- called directly. That is precisely the call being removed.
--
-- Written as a loop over return type `trigger` rather than a hard-coded list,
-- so a trigger function added later is covered without anyone remembering to
-- come back here.
-- ===========================================================================

do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as signature
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prorettype = 'pg_catalog.trigger'::regtype
  loop
    execute format(
      'revoke all on function %s from public, anon, authenticated',
      fn.signature
    );
  end loop;
end;
$$;
