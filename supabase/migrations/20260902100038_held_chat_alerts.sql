-- ===========================================================================
-- RecoverEase — 31. A critical alert waits for a clinician who can open it
-- ===========================================================================
-- Modules 8.2 and 8.3: a guidance-chat reply that raises a critical concern
-- alerts the patient's doctor. Decision D8 (migration 30) leaves a
-- deactivated doctor's patients assigned to them until a Clinic Admin moves
-- them, and a deactivated doctor can no longer open the conversation - so in
-- that window the alert reached no clinician at all.
-- docs/critical-alert-escalation.md sets out the options; this is the
-- database half of option C:
--
--   * `chat_session.chat_session_alert_held_since`: set while a critical
--     alert about the conversation is waiting for a clinician who can open
--     it, empty otherwise. One hold per conversation, however many replies
--     raise a concern. Server-only, like the flag beside it (migration 26).
--   * `hold_chat_alert(chat_session_id)`, for `chatbot-reply` alone: holds
--     the alert when the patient's doctor is deactivated. If, by the time it
--     runs, the patient's doctor is active - reactivated, or the patient
--     just moved - the alert goes to them at once instead.
--   * Delivery on hand-over: once a patient's doctor is active again - the
--     patients moved to an active doctor (D8), or the doctor reactivated -
--     every alert held for them is sent to that doctor as an ordinary chat
--     alert, linked to the conversation, and the hold is cleared. However
--     the move is made, since it is a trigger and not a step of one screen.
--   * `admin_held_chat_alert_counts()`: for the caller's clinic, how many
--     alerts wait on each doctor's patients. A count against a doctor, never
--     a conversation, a patient or anything they wrote.
--
-- The Clinic Admins are told by `chatbot-reply`, not here
-- (_shared/critical-alert.ts). Nothing already stored changes: every flag,
-- summary and notification stays as it is, and the new column starts empty.
-- Independent of migration 34.
--
-- Rollback, should it be needed:
-- supabase/rollbacks/20260902100038_held_chat_alerts.down.sql, applied as a
-- new migration with approval.
-- ===========================================================================

-- Migration 29's clinics must be there, and this not yet.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'admin' and column_name = 'clinic_id'
  ) then
    raise exception 'Migration 38 needs migration 29 first. Nothing was applied.';
  end if;

  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'chat_session'
       and column_name = 'chat_session_alert_held_since'
  ) then
    raise exception 'Migration 38 has already been applied. Nothing was changed.';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- The hold
-- ---------------------------------------------------------------------------

alter table public.chat_session
  add column chat_session_alert_held_since timestamptz;

comment on column public.chat_session.chat_session_alert_held_since is
  'When a critical alert about this conversation began waiting for a '
  'clinician who can open it - the patient''s doctor was deactivated. Empty '
  'once delivered, and for every other conversation. Written only by '
  'hold_chat_alert and the delivery on hand-over.';

-- Delivery reads only held conversations; this covers exactly those.
create index chat_session_alert_held_idx
  on public.chat_session (chat_session_alert_held_since)
  where chat_session_alert_held_since is not null;

-- Migration 26's rule for the flag and summary, for the hold beside them. A
-- patient who could clear it would take the alert away from the clinician it
-- is waiting for; one who could set it would alarm the Clinic Admin.
-- current_user, and not SECURITY DEFINER, for migration 22's reason.
create or replace function public.chat_session_guard_held_alert()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  changed boolean;
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      changed := new.chat_session_alert_held_since is not null;
    else
      changed := new.chat_session_alert_held_since
                   is distinct from old.chat_session_alert_held_since;
    end if;

    if changed then
      raise exception
        'Whether a conversation''s alert is waiting for a clinician is set by the server and cannot be changed directly'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.chat_session_guard_held_alert() is
  'Refuses a direct client write that creates a chat session with its alert '
  'held, or holds or releases one, by the anon or authenticated role. Run '
  'only by the chat_session_guard_held_alert trigger.';

revoke all on function public.chat_session_guard_held_alert()
  from public, anon, authenticated;

create trigger chat_session_guard_held_alert
  before insert or update of chat_session_alert_held_since
  on public.chat_session
  for each row
  execute function public.chat_session_guard_held_alert();

-- ---------------------------------------------------------------------------
-- Holding an alert
-- ---------------------------------------------------------------------------
-- Returns 'held', 'already_held' (an earlier reply's alert is still waiting;
-- nobody is told twice) or 'delivered' (the patient's doctor turned out to
-- be active, and has it).
--
-- The doctor's row and then the patient's are locked, in the order D8's move
-- takes them, so a hold and a hand-over at the same moment wait for each
-- other rather than miss each other: either the hold is committed before the
-- hand-over looks for it, or the hold sees the active doctor afterwards. A
-- patient moved between the two reads is looked up again.

create or replace function public.hold_chat_alert(target_chat_session_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  the_patient uuid;
  the_doctor  uuid;
  doctor_row  record;
begin
  loop
    select s.pat_id, p.doc_id into the_patient, the_doctor
      from public.chat_session s
      join public.patient p on p.pat_id = s.pat_id
     where s.chat_session_id = target_chat_session_id;

    if not found then
      raise exception 'That conversation could not be found'
        using errcode = 'no_data_found';
    end if;

    select d.user_id, d.doc_is_active into doctor_row
      from public.doctor d
     where d.doc_id = the_doctor
       for share;

    perform 1
       from public.patient p
      where p.pat_id = the_patient
        and p.doc_id = the_doctor
        for share;
    exit when found;
  end loop;

  if doctor_row.doc_is_active then
    -- chatbot-reply's own alert, word for word (CRITICAL_ALERT_MESSAGE).
    insert into public.notification (
      user_id, chat_session_id, notification_type, notification_message
    )
    values (
      doctor_row.user_id, target_chat_session_id, 'chat_critical',
      'A patient raised a concern in the guidance chat that may need your attention.'
    );
    return 'delivered';
  end if;

  update public.chat_session
     set chat_session_alert_held_since = now()
   where chat_session_id = target_chat_session_id
     and chat_session_alert_held_since is null;

  return case when found then 'held' else 'already_held' end;
end;
$$;

comment on function public.hold_chat_alert(uuid) is
  'Modules 8.2/8.3. Holds a conversation''s critical alert while the '
  'patient''s doctor is deactivated, once per conversation, or delivers it '
  'if they are active. For chatbot-reply (service_role) only.';

revoke all on function public.hold_chat_alert(uuid) from public, anon, authenticated;
grant execute on function public.hold_chat_alert(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Delivering on hand-over
-- ---------------------------------------------------------------------------
-- Every held alert whose patient's doctor is now active goes to that doctor,
-- and its hold is cleared. Run after any change of a patient's doctor or a
-- doctor's active state, whoever makes it. Anything still deliverable is
-- delivered, so a run that finds nothing to do costs one index scan.

create or replace function app_private.deliver_held_chat_alerts()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  delivered integer;
begin
  with due as (
    select s.chat_session_id, d.user_id
      from public.chat_session s
      join public.patient p on p.pat_id = s.pat_id
      join public.doctor d on d.doc_id = p.doc_id
     where s.chat_session_alert_held_since is not null
       and d.doc_is_active
       for update of s
  ),
  released as (
    update public.chat_session s
       set chat_session_alert_held_since = null
      from due
     where s.chat_session_id = due.chat_session_id
    returning s.chat_session_id, due.user_id
  )
  -- No clinical detail, as for every chat alert: the doctor opens the
  -- conversation to read it (module 8.5).
  insert into public.notification (
    user_id, chat_session_id, notification_type, notification_message
  )
  select released.user_id, released.chat_session_id, 'chat_critical',
         'A patient raised a concern in the guidance chat while they had no active doctor. It may need your attention.'
    from released;

  get diagnostics delivered = row_count;
  return delivered;
end;
$$;

comment on function app_private.deliver_held_chat_alerts() is
  'Sends every held critical alert to the active doctor who can now open its '
  'conversation, and clears the hold. Returns how many.';

revoke all on function app_private.deliver_held_chat_alerts() from public;

create or replace function public.chat_alert_deliver_on_handover()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_private.deliver_held_chat_alerts();
  return null;
end;
$$;

comment on function public.chat_alert_deliver_on_handover() is
  'Delivers held critical alerts once a patient has an active doctor again. '
  'Run only by the patient_deliver_held_chat_alerts and '
  'doctor_deliver_held_chat_alerts triggers.';

-- Not callable directly, like every other trigger function (migration 10).
revoke all on function public.chat_alert_deliver_on_handover()
  from public, anon, authenticated;

-- A patient moved to another doctor: D8's move, or a doctor handing over one
-- patient. Migration 27 allows only an active doctor.
create trigger patient_deliver_held_chat_alerts
  after update of doc_id on public.patient
  for each statement
  execute function public.chat_alert_deliver_on_handover();

-- A doctor reactivated: their patients' held alerts are theirs again.
create trigger doctor_deliver_held_chat_alerts
  after update of doc_is_active on public.doctor
  for each statement
  execute function public.chat_alert_deliver_on_handover();

-- ---------------------------------------------------------------------------
-- What the Clinic Admin sees: a count against each doctor
-- ---------------------------------------------------------------------------
-- Beside the doctor on the Doctor accounts screen, next to "Reassign
-- patients", which is what delivers them. Counts only, like D8's; the
-- Clinic Admin learns how many alerts wait, never which conversation,
-- whose, or what it says.

create or replace function public.admin_held_chat_alert_counts()
returns table (doc_id uuid, held_alerts integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  this_clinic uuid := (select app_private.admin_clinic_id());
begin
  if this_clinic is null then
    raise exception 'Administrator privileges are required'
      using errcode = 'insufficient_privilege';
  end if;

  return query
    select d.doc_id, count(*)::integer
      from public.chat_session s
      join public.patient p on p.pat_id = s.pat_id
      join public.doctor d on d.doc_id = p.doc_id
     where s.chat_session_alert_held_since is not null
       and d.clinic_id = this_clinic
     group by d.doc_id
     order by d.doc_id;
end;
$$;

comment on function public.admin_held_chat_alert_counts() is
  'For the caller''s clinic, how many critical alerts wait on each doctor''s '
  'patients for a clinician who can open them. Counts only, for Clinic '
  'Admins only.';

-- Called over RPC, like the other administrator functions: refused to anon,
-- and it checks its caller in its own body.
revoke all on function public.admin_held_chat_alert_counts() from public, anon;
grant execute on function public.admin_held_chat_alert_counts() to authenticated;
