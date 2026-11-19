-- ===========================================================================
-- RecoverEase — 54. A doctor's record ID and registration date are fixed
-- ===========================================================================
-- Migration 30's update policy lets a clinic's administrator update its
-- doctors' rows (module 11.2), and a doctor their own (module 2.6). The
-- guards of migrations 7, 29 and 42 already fix the linked account, the
-- clinic, activation and the licence (for the doctor), and the reminder
-- setting. Two columns had no guard:
--
--   * `doc_id`, which an administrator could rewrite on any of their
--     clinic's doctors nothing referenced yet;
--   * `doc_created_at`, the date the account was registered, which an
--     administrator or the doctor could rewrite through the Data API.
--
-- Neither has a legitimate change: no screen, Edge Function, job or seed
-- writes them after the row is inserted. Both are now refused for every
-- writer, the service role and the database's own jobs included, like the
-- clinic (migration 29). Sending either back unchanged, as a whole-row save
-- does, is not a change and is accepted. Nothing else about who may update
-- what changes: the policy and the earlier guards are untouched.
--
-- Rollback: supabase/rollbacks/20260902100054_doctor_identity_columns_fixed.down.sql
-- ===========================================================================

-- The trigger locks `doctor`, which the reminder jobs read - the pre-dose job
-- every minute. Waiting at most 3 seconds for that lock, the migration fails
-- rather than holding the website up behind it (docs/deployment.md,
-- "Migration timing and run history"). A plain SET, not SET LOCAL, so it
-- holds whether or not the runner wraps this file in one transaction; it is
-- reset at the end.
set lock_timeout = '3s';

create or replace function public.doctor_identity_is_fixed()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.doc_id is distinct from old.doc_id then
    raise exception 'A doctor''s record ID cannot be changed'
      using errcode = 'insufficient_privilege';
  end if;

  if new.doc_created_at is distinct from old.doc_created_at then
    raise exception 'A doctor''s registration date cannot be changed'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

comment on function public.doctor_identity_is_fixed() is
  'Refuses any change of a doctor''s doc_id or doc_created_at (migration 54). '
  'Run only by the doctor_identity_is_fixed trigger.';

-- Not callable through the Data API; firing a trigger needs no EXECUTE
-- (migration 10).
revoke all on function public.doctor_identity_is_fixed() from public, anon, authenticated;

-- No column list: the WHEN clause sees the row as it would be stored, so a
-- change made any way at all is caught, and an update that changes neither
-- column never calls the function.
drop trigger if exists doctor_identity_is_fixed on public.doctor;
create trigger doctor_identity_is_fixed
  before update on public.doctor
  for each row
  when (
    old.doc_id is distinct from new.doc_id
    or old.doc_created_at is distinct from new.doc_created_at
  )
  execute function public.doctor_identity_is_fixed();

-- Back to the server's default for anything else this connection runs.
reset lock_timeout;
