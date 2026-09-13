-- ===========================================================================
-- RecoverEase — 18. A dose cannot be recorded as skipped from the app
-- ===========================================================================
-- QA 9/13, item 3: "Don't give them the option to skip". The patient's
-- medication page no longer offers Skip, but the button was never the
-- control. `medication_log_update_patient` admits a patient to the whole of
-- their own dose rows, and `medication_log_guard_slot` protects only when a
-- dose was due, so a direct Data API call could still record any of their
-- doses - past, today's or future - as `skipped`.
--
-- This refuses exactly that and nothing else:
--
--   * A caller of the Data API with an end-user session or none - the roles
--     `authenticated` and `anon` - may not insert a dose as `skipped`, nor
--     change an existing dose to `skipped`, however the rest of the statement
--     is shaped. Writing the value a row already holds is not a change and
--     stays allowed.
--   * Doses already recorded as `skipped` are not touched and stay readable.
--     `skipped` remains a valid status: adherence (module 4.8), the doctor's
--     summary and the recovery report still tell a dose deliberately not
--     taken apart from a missed one, and nothing here rewrites history.
--   * A patient can still record a dose as taken, and Undo still returns a
--     recorded dose - a skipped one included - to pending.
--   * Every other writer is left as it was. No database function writes
--     `skipped`. The dose generator and the reminder and overdue jobs run as
--     their owner, the cron job as postgres, and the service key as
--     service_role, so none of them is affected.
--
-- current_user rather than auth.uid(), and not SECURITY DEFINER itself, for
-- the reason migration 22 gives: inside a SECURITY DEFINER function
-- current_user is the function's owner, so it is what tells a direct client
-- write apart from one a database function makes.
--
-- Rollback, should it be needed:
--   drop trigger medication_log_refuse_client_skip on public.medication_log;
--   drop function public.medication_log_refuse_client_skip();
-- ===========================================================================

create or replace function public.medication_log_refuse_client_skip()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  becomes_skipped boolean;
begin
  -- The Data API's end-user roles. The dose generator, the reminder and
  -- overdue jobs, the cron job and the service key all write as other roles.
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      becomes_skipped := new.medication_log_status = 'skipped';
    else
      becomes_skipped := new.medication_log_status = 'skipped'
                         and old.medication_log_status is distinct from 'skipped';
    end if;

    if becomes_skipped then
      raise exception
        'A dose cannot be recorded as skipped. Record it as taken, or it will be marked missed.'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.medication_log_refuse_client_skip() is
  'Refuses a direct client write that records a dose as skipped: an insert '
  'with status skipped, or an update that changes a dose to skipped, by the '
  'anon or authenticated role. Doses already skipped are untouched. Run only '
  'by the medication_log_refuse_client_skip trigger.';

-- Not callable directly, like every other trigger function (migration 10).
revoke all on function public.medication_log_refuse_client_skip()
  from public, anon, authenticated;

create trigger medication_log_refuse_client_skip
  before insert or update of medication_log_status on public.medication_log
  for each row
  execute function public.medication_log_refuse_client_skip();

comment on trigger medication_log_refuse_client_skip on public.medication_log is
  'Keeps the skipped status out of reach of direct client writes (QA 9/13).';
