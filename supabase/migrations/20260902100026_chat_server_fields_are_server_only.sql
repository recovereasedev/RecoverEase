-- ===========================================================================
-- RecoverEase — 19. The assistant's words and the alert are the server's
-- ===========================================================================
-- Two things in the guidance chat are meant to be written only by
-- `chatbot-reply`, which uses the service key:
--
--   * `chat_message` rows with the role `assistant` - what the assistant said;
--   * `chat_session.chat_session_has_critical_flag` and
--     `chat_session_summary` - the critical-concern alert (module 8.2) and
--     the line a doctor reads beside it.
--
-- The policies decided only *whose* row it was, not what was in it.
-- `chat_message_insert_patient` admits a patient to their own conversation
-- with any role the check constraint allows, so a direct Data API call could
-- put words in the assistant's mouth in the transcript a doctor reads (module
-- 8.5), and replay them to the model as its own earlier turns.
-- `chat_session_update_patient` admits a patient to the whole of their own
-- session row, so they could set, clear or rewrite the alert and its summary.
-- No screen does either: the app inserts only patient messages and sessions
-- with nothing but `pat_id`, and never updates a session.
--
-- This refuses exactly those writes and nothing else:
--
--   * A caller of the Data API with an end-user session or none - the roles
--     `authenticated` and `anon` - may insert a chat message only as the
--     patient, and may never change a message's role. (No policy lets them
--     update a message at all; the role check stands behind that.)
--   * The same callers may not create a session already flagged or already
--     summarised, nor change the flag or the summary of an existing one.
--     Writing the value a row already holds is not a change and stays
--     allowed. The session's other columns are left as they were.
--   * Every other writer is left as it was. `chatbot-reply` writes as
--     service_role, database functions as their owner, and nothing here
--     looks at them.
--   * Nothing already stored is touched: existing assistant messages,
--     flags and summaries stay exactly as they are.
--
-- current_user rather than auth.uid(), and neither function SECURITY
-- DEFINER, for the reason migration 22 gives: it is what tells a direct
-- client write apart from one the server makes.
--
-- Rollback, should it be needed:
--   drop trigger chat_message_refuse_client_role on public.chat_message;
--   drop function public.chat_message_refuse_client_role();
--   drop trigger chat_session_guard_server_fields on public.chat_session;
--   drop function public.chat_session_guard_server_fields();
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- chat_message: a client speaks only as the patient
-- ---------------------------------------------------------------------------

create or replace function public.chat_message_refuse_client_role()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- The Data API's end-user roles. chatbot-reply writes as service_role.
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      if new.chat_message_role is distinct from 'patient' then
        raise exception
          'Only the guidance assistant can write an assistant message'
          using errcode = 'insufficient_privilege';
      end if;
    elsif new.chat_message_role is distinct from old.chat_message_role then
      raise exception 'Who wrote a chat message cannot be changed'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.chat_message_refuse_client_role() is
  'Refuses a direct client write that records a chat message as anything '
  'but the patient''s, or changes a message''s role, by the anon or '
  'authenticated role. chatbot-reply writes assistant messages as '
  'service_role and is unaffected. Run only by the '
  'chat_message_refuse_client_role trigger.';

-- Not callable directly, like every other trigger function (migration 10).
revoke all on function public.chat_message_refuse_client_role()
  from public, anon, authenticated;

create trigger chat_message_refuse_client_role
  before insert or update of chat_message_role on public.chat_message
  for each row
  execute function public.chat_message_refuse_client_role();

comment on trigger chat_message_refuse_client_role on public.chat_message is
  'Keeps assistant messages out of reach of direct client writes.';

-- ---------------------------------------------------------------------------
-- chat_session: the alert and its summary are the server's
-- ---------------------------------------------------------------------------

create or replace function public.chat_session_guard_server_fields()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  changed boolean;
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      changed := new.chat_session_has_critical_flag
                 or new.chat_session_summary is not null;
    else
      changed := new.chat_session_has_critical_flag
                   is distinct from old.chat_session_has_critical_flag
                 or new.chat_session_summary
                   is distinct from old.chat_session_summary;
    end if;

    if changed then
      raise exception
        'A conversation''s alert and summary are set by the guidance assistant and cannot be changed directly'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.chat_session_guard_server_fields() is
  'Refuses a direct client write that creates a chat session with the '
  'critical flag or summary set, or changes either on an existing one, by '
  'the anon or authenticated role. chatbot-reply sets them as service_role '
  'and is unaffected. Run only by the chat_session_guard_server_fields '
  'trigger.';

revoke all on function public.chat_session_guard_server_fields()
  from public, anon, authenticated;

create trigger chat_session_guard_server_fields
  before insert
      or update of chat_session_has_critical_flag, chat_session_summary
  on public.chat_session
  for each row
  execute function public.chat_session_guard_server_fields();

comment on trigger chat_session_guard_server_fields on public.chat_session is
  'Keeps the critical-concern flag and summary out of reach of direct client writes.';
