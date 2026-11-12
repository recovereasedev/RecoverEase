-- ===========================================================================
-- RecoverEase — 53. Web Push: a patient's phone is told a reminder is waiting
-- ===========================================================================
-- Until now a reminder reached a patient only while RecoverEase was open:
-- the bell and the reminder tray ask the server every minute. This lets an
-- Android phone with RecoverEase installed show a notification while the app
-- is closed.
--
-- Four parts:
--
--   1. Where a notification came from, as data. `notification` gains
--      `notification_source` (which job or event wrote it),
--      `notification_purpose` ('reminder' or 'update') and the dose or
--      appointment it is about. The four functions that write a patient's
--      reminder or cancellation notice (08/23/31/48's follow-up, 37/48's
--      pre-dose, 18/31/42's appointment, 20/31's cancellation) are redefined
--      here, word for word as they stand, with only those columns added. The
--      message text, who is notified and when are unchanged. Nothing ever
--      parses a message to learn what it is about.
--
--   2. Devices and the queue, in `app_private` - a schema the API does not
--      expose. A browser never reads a stored endpoint or key: it registers
--      its own subscription, asks "is this device registered to me?"
--      (true/false) and removes it, through three functions. The queue holds
--      one row per (notification, device), unique, and never the message.
--
--   3. Checked at send time, not only when queued. Just before a push is
--      sent, the dose or appointment is read again: a cancelled or moved
--      appointment, a dose already recorded, a course that ended, a patient
--      who turned reminders off, or a device that changed hands - and the
--      push is skipped. A cancellation is pushed as an appointment *update*,
--      never as a reminder.
--
--   4. Endpoints: only Google's push service, as Chrome on Android issues
--      them (https://fcm.googleapis.com/fcm/send/... or /wp/...), checked
--      when a device registers and again before every send.
--
-- What it deliberately does NOT do:
--
--   * Schedule anything or install pg_net: applying it sends no push.
--     Delivery is turned on separately, with approval
--     (supabase/manual/web_push_activate.sql, docs/deployment.md "Web Push").
--   * Put clinical words on a lock screen. The Edge Function and the service
--     worker show one of two fixed sentences.
--   * Push anyone but a patient. Doctors' notifications - their appointment
--     reminders, cancellations, conflict alerts and Guidance Chat's alerts -
--     are never queued.
--   * Ever stop a notification being stored. Queueing failures are caught
--     and logged as a warning.
--
-- Rollback: supabase/rollbacks/20260902100053_web_push_notifications.down.sql
-- ===========================================================================

do $$
begin
  if to_regclass('public.notification') is null
     or to_regprocedure('public.notification_assign_created_at()') is null
     or to_regprocedure('public.dispatch_medication_conflict_alerts()') is null then
    raise exception 'Migration 53 needs migrations 44 and 48 first. Nothing was applied.';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'notification'
                and column_name = 'notification_source') then
    raise exception 'Migration 53 has already been applied. Nothing was changed.';
  end if;
end
$$;

-- Altering `notification` locks it, and the reminder jobs write it every
-- minute. Waiting at most 3 seconds for that lock, the migration fails
-- rather than holding the website up behind it (docs/deployment.md,
-- "Migration timing and run history"). A plain SET; reset at the end.
set lock_timeout = '3s';

-- ===========================================================================
-- 1. Where a notification came from
-- ===========================================================================
-- Soft references, deliberately without foreign keys: a dose slot is deleted
-- when a course ends early, and an appointment with its patient. A foreign
-- key would either block those deletes or rewrite history rows; here a
-- missing dose or appointment simply makes a queued push stale. Null for
-- every notification written before 53, and for doctors' general messages.

alter table public.notification
  add column notification_source             text,
  add column notification_purpose            text,
  add column notification_medication_log_id  uuid,
  add column notification_appointment_id     uuid,
  add constraint notification_source_known check (
    notification_source is null
    or notification_source in (
      'medication_pre_dose', 'medication_follow_up',
      'appointment_reminder', 'appointment_cancellation'
    )
  ),
  add constraint notification_source_shape check (
    (notification_source is null
       and notification_purpose is null
       and notification_medication_log_id is null
       and notification_appointment_id is null)
    or (notification_source in ('medication_pre_dose', 'medication_follow_up')
       and notification_purpose = 'reminder'
       and notification_appointment_id is null)
    or (notification_source = 'appointment_reminder'
       and notification_purpose = 'reminder'
       and notification_medication_log_id is null)
    or (notification_source = 'appointment_cancellation'
       and notification_purpose = 'update'
       and notification_medication_log_id is null)
  );

comment on column public.notification.notification_source is
  'Which job or event wrote this notification (migration 53); null for '
  'messages and for notifications written before 53.';
comment on column public.notification.notification_purpose is
  '''reminder'' or ''update'' (a cancellation), from notification_source.';

-- A doctor's message to their patient carries no source (migration 41's
-- policy, with the four new columns held to null).
drop policy if exists notification_insert_doctor_to_patient on public.notification;

create policy notification_insert_doctor_to_patient
  on public.notification for insert to authenticated
  with check (
    (select app_private.is_user_my_patient(user_id))
    and notification_type = 'general'
    and chat_session_id is null
    and notification_is_read = false
    and char_length(btrim(notification_message)) between 1 and 1000
    and notification_source is null
    and notification_purpose is null
    and notification_medication_log_id is null
    and notification_appointment_id is null
  );

comment on policy notification_insert_doctor_to_patient on public.notification is
  'Module 7.1: an active doctor may send their own patient a general, unread '
  'message of up to 1,000 characters, with no source (migrations 41, 53). '
  'Every other notification is written by SECURITY DEFINER functions or the '
  'service role.';

-- The four writers, as they stood, each tagging what it wrote. ----------------

-- As migration 48 left it; only the source columns are new.
create or replace function public.dispatch_medication_reminders(
  grace_minutes integer default 30
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  dispatched integer;
begin
  with due as (
    select ml.medication_log_id,
           p.user_id,
           ms.medication_schedule_name,
           ms.medication_schedule_dosage,
           ml.medication_log_scheduled_at,
           c.clinic_timezone as zone
      from public.medication_log ml
      join public.medication_schedule ms
        on ms.medication_schedule_id = ml.medication_schedule_id
      join public.prescription pr
        on pr.prescription_id = ms.prescription_id
      join public.patient p
        on p.pat_id = pr.pat_id
      join public.doctor d
        on d.doc_id = p.doc_id
      join public.clinic c
        on c.clinic_id = d.clinic_id
     where ml.medication_log_status = 'pending'
       -- Already chased. This is the duplicate guard.
       and ml.medication_log_follow_up_sent_at is null
       -- Module 4.9 opt-out.
       and p.pat_reminder_is_enabled
       -- Give the patient a grace period to record it themselves before
       -- being chased about it.
       and ml.medication_log_scheduled_at
           <= now() - make_interval(mins => grace_minutes)
       -- Not before the hour they asked to be contacted, in their clinic's
       -- local terms rather than UTC.
       and (
         p.pat_reminder_preferred_time is null
         or ((now() at time zone c.clinic_timezone)::time) >= p.pat_reminder_preferred_time
       )
       -- The course has not ended: nothing after its end date is chased (QA-01).
       and (ms.medication_schedule_end_date is null
            or ml.medication_log_dose_date <= ms.medication_schedule_end_date)
  ),
  stamped as (
    update public.medication_log ml
       set medication_log_follow_up_sent_at = now()
      from due
     where ml.medication_log_id = due.medication_log_id
       -- Re-checked at update time, not only in the CTE snapshot. Under READ
       -- COMMITTED a second concurrent run unblocks, re-evaluates this
       -- predicate against the just-updated row, and skips it — so two
       -- schedulers firing at once cannot double-notify.
       and ml.medication_log_follow_up_sent_at is null
    returning ml.medication_log_id
  )
  insert into public.notification (
    user_id, notification_type, notification_message,
    notification_source, notification_purpose,
    notification_medication_log_id, notification_appointment_id
  )
  select due.user_id,
         'medication',
         format(
           'Have you taken your %s (%s)? It was due at %s.',
           due.medication_schedule_name,
           due.medication_schedule_dosage,
           to_char(
             due.medication_log_scheduled_at at time zone due.zone,
             'HH24:MI'
           )
         ),
         'medication_follow_up', 'reminder', due.medication_log_id, null
    from due
    -- Only notify for doses this statement actually stamped.
    join stamped on stamped.medication_log_id = due.medication_log_id;

  get diagnostics dispatched = row_count;
  return dispatched;
end;
$$;

-- As migration 48 left it; only the source columns are new.
create or replace function public.dispatch_medication_pre_dose_reminders()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  dispatched integer;
begin
  -- Each clinic's lead time, as its settings hold it: 5, 10, 15 or 30
  -- minutes, and ten for anything else. Leading zeros and spaces around the
  -- number are read past, as the grace period's are.
  with clinic_rule as (
    select c.clinic_id,
           c.clinic_timezone as zone,
           coalesce(
             (select substring(s.system_setting_value
                               from '^\s*0*(5|10|15|30)\s*$')::integer
                from public.system_setting s
               where s.clinic_id = c.clinic_id
                 and s.system_setting_key = 'medication.reminder_lead_minutes'),
             10
           ) as lead_minutes
      from public.clinic c
  ),
  due as (
    select ml.medication_log_id,
           p.user_id,
           ms.medication_schedule_name,
           ms.medication_schedule_dosage,
           ml.medication_log_scheduled_at,
           r.zone
      from public.medication_log ml
      join public.medication_schedule ms
        on ms.medication_schedule_id = ml.medication_schedule_id
      join public.prescription pr
        on pr.prescription_id = ms.prescription_id
      join public.patient p
        on p.pat_id = pr.pat_id
      join public.doctor d
        on d.doc_id = p.doc_id
      join clinic_rule r
        on r.clinic_id = d.clinic_id
     where ml.medication_log_status = 'pending'
       -- Already reminded. This is the duplicate guard.
       and ml.medication_log_pre_dose_sent_at is null
       -- Module 4.9 opt-out.
       and p.pat_reminder_is_enabled
       -- Not yet due, and due within the clinic's lead time. The half hour is
       -- the longest lead time a clinic can set: it bounds the read of
       -- medication_log_due_idx to the next 30 minutes, where the slots run
       -- 30 days ahead, on a job that runs every minute.
       and ml.medication_log_scheduled_at > now()
       and ml.medication_log_scheduled_at <= now() + interval '30 minutes'
       and ml.medication_log_scheduled_at
           <= now() + make_interval(mins => r.lead_minutes)
       -- Not before the hour they asked to be contacted, in their clinic's
       -- local terms rather than UTC.
       and (
         p.pat_reminder_preferred_time is null
         or ((now() at time zone r.zone)::time) >= p.pat_reminder_preferred_time
       )
       -- The course has not ended: nothing after its end date (QA-01).
       and (ms.medication_schedule_end_date is null
            or ml.medication_log_dose_date <= ms.medication_schedule_end_date)
  ),
  stamped as (
    update public.medication_log ml
       set medication_log_pre_dose_sent_at = now()
      from due
     where ml.medication_log_id = due.medication_log_id
       -- Re-checked at update time, not only in the CTE snapshot: a second
       -- run that overlaps this one re-reads the row it waited for and skips
       -- it, and a dose marked taken meanwhile is not reminded about.
       and ml.medication_log_pre_dose_sent_at is null
       and ml.medication_log_status = 'pending'
    returning ml.medication_log_id
  )
  insert into public.notification (
    user_id, notification_type, notification_message,
    notification_source, notification_purpose,
    notification_medication_log_id, notification_appointment_id
  )
  select due.user_id,
         'medication',
         format(
           'Your %s (%s) is due at %s.',
           due.medication_schedule_name,
           due.medication_schedule_dosage,
           to_char(
             due.medication_log_scheduled_at at time zone due.zone,
             'HH24:MI'
           )
         ),
         'medication_pre_dose', 'reminder', due.medication_log_id, null
    from due
    -- Only notify for doses this statement actually stamped.
    join stamped on stamped.medication_log_id = due.medication_log_id;

  get diagnostics dispatched = row_count;
  return dispatched;
end;
$$;

-- As migration 42 left it; only the source columns are new.
create or replace function public.dispatch_appointment_reminders(
  lead_hours integer default 24
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  dispatched integer;
begin
  -- Each message's date and time are in the clinic of the appointment's
  -- doctor - the patient's clinic too, since a patient only ever moves to a
  -- doctor in the same one.
  with due as (
    select a.appointment_id,
           a.appointment_date,
           c.clinic_timezone as zone,
           d.user_id as doctor_user_id,
           d.doc_appointment_reminder_is_enabled as doctor_wants_reminder,
           p.user_id as patient_user_id,
           p.pat_first_name,
           p.pat_last_name
      from public.appointment a
      join public.patient p on p.pat_id = a.pat_id
      join public.doctor  d on d.doc_id = a.doc_id
      join public.clinic  c on c.clinic_id = d.clinic_id
     where a.appointment_status in ('scheduled', 'confirmed')
       and a.appointment_reminder_sent_at is null
       and a.appointment_date > now()
       and a.appointment_date <= now() + make_interval(hours => lead_hours)
  ),
  stamped as (
    update public.appointment a
       set appointment_reminder_sent_at = now()
      from due
     where a.appointment_id = due.appointment_id
       and a.appointment_reminder_sent_at is null
    returning a.appointment_id
  )
  insert into public.notification (
    user_id, notification_type, notification_message,
    notification_source, notification_purpose,
    notification_medication_log_id, notification_appointment_id
  )
  select recipient.user_id, 'appointment', recipient.message,
         'appointment_reminder', 'reminder', null, due.appointment_id
    from due
    join stamped on stamped.appointment_id = due.appointment_id
    cross join lateral (
      values
        (
          -- The doctor's, unless they have turned their reminders off.
          due.doctor_wants_reminder,
          due.doctor_user_id,
          format(
            'Upcoming appointment with %s on %s at %s.',
            trim(due.pat_first_name || ' ' || due.pat_last_name),
            to_char(due.appointment_date at time zone due.zone, 'FMDay, FMDD FMMonth'),
            to_char(due.appointment_date at time zone due.zone, 'HH24:MI')
          )
        ),
        (
          -- The patient's, always.
          true,
          due.patient_user_id,
          format(
            'You have an upcoming appointment on %s at %s.',
            to_char(due.appointment_date at time zone due.zone, 'FMDay, FMDD FMMonth'),
            to_char(due.appointment_date at time zone due.zone, 'HH24:MI')
          )
        )
    ) as recipient(is_sent, user_id, message)
   where recipient.is_sent;

  get diagnostics dispatched = row_count;
  return dispatched;
end;
$$;

-- As migration 31 left it; only the source columns are new.
create or replace function public.appointment_notify_cancellation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  zone text;
begin
  zone := app_private.clinic_timezone(app_private.clinic_of_doctor(new.doc_id));

  insert into public.notification (
    user_id, notification_type, notification_message,
    notification_source, notification_purpose,
    notification_medication_log_id, notification_appointment_id
  )
  select recipient.user_id, 'appointment', recipient.message,
         'appointment_cancellation', 'update', null, new.appointment_id
    from public.patient p
    join public.doctor  d on d.doc_id = new.doc_id
    cross join lateral (
      values
        (
          d.user_id,
          format(
            'The appointment with %s on %s at %s has been cancelled.',
            trim(p.pat_first_name || ' ' || p.pat_last_name),
            to_char(new.appointment_date at time zone zone, 'FMDay, FMDD FMMonth'),
            to_char(new.appointment_date at time zone zone, 'HH24:MI')
          )
        ),
        (
          p.user_id,
          format(
            'Your appointment on %s at %s has been cancelled.',
            to_char(new.appointment_date at time zone zone, 'FMDay, FMDD FMMonth'),
            to_char(new.appointment_date at time zone zone, 'HH24:MI')
          )
        )
    ) as recipient(user_id, message)
   where p.pat_id = new.pat_id;

  return null;
end;
$$;

-- ===========================================================================
-- 2. Devices and the queue (private)
-- ===========================================================================

-- Chrome on Android subscribes through Firebase Cloud Messaging, and its
-- endpoints have one of two forms (Chromium, push_messaging_constants.cc):
--   https://fcm.googleapis.com/fcm/send/<token>
--   https://fcm.googleapis.com/wp/<token>
-- Exactly that host, port 443, no user, query or fragment, and a token of
-- the characters FCM uses. An IP address, another host, a look-alike
-- (fcm.googleapis.com.example, a trailing dot, an @), http, or a port are
-- all refused - so the server's signed request can only ever go to Google.
-- The Edge Function checks the same rule again before every send
-- (supabase/functions/_shared/push-endpoint.ts).
create or replace function app_private.push_endpoint_is_allowed(endpoint text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select endpoint is not null
     and char_length(endpoint) <= 1024
     and endpoint ~ '^https://fcm\.googleapis\.com/(fcm/send|wp)/[A-Za-z0-9_:-]{16,}$'
$$;

comment on function app_private.push_endpoint_is_allowed(text) is
  'The push endpoints RecoverEase will send to: Chrome-on-Android FCM '
  'endpoints only (migration 53).';

revoke all on function app_private.push_endpoint_is_allowed(text) from public, anon, authenticated;

create table app_private.push_subscription (
  subscription_id         uuid primary key default gen_random_uuid(),
  user_id                 uuid not null
                            references public.user_account (user_id)
                            on delete cascade,
  push_endpoint           text not null,
  push_p256dh             text not null,
  push_auth               text not null,
  push_user_agent         text,
  -- Set on every registration, including a move from another account, so
  -- the ten-device limit keeps the devices used most recently.
  push_registered_at      timestamptz not null default now(),
  push_last_success_at    timestamptz,

  constraint push_subscription_endpoint_unique unique (push_endpoint),
  constraint push_subscription_endpoint_allowed
    check (app_private.push_endpoint_is_allowed(push_endpoint)),
  -- base64url, no padding: a P-256 public key is 65 bytes (87 characters),
  -- the auth secret 16 bytes (22 characters).
  constraint push_subscription_p256dh_shape
    check (push_p256dh ~ '^[A-Za-z0-9_-]{86,88}$'),
  constraint push_subscription_auth_shape
    check (push_auth ~ '^[A-Za-z0-9_-]{21,24}$'),
  constraint push_subscription_user_agent_length
    check (push_user_agent is null or char_length(push_user_agent) <= 512)
);

create index push_subscription_user_idx on app_private.push_subscription (user_id);

comment on table app_private.push_subscription is
  'A device a patient switched phone reminders on for (migration 53). In '
  'app_private: no client role can read it; the browser goes through '
  'register_/unregister_push_subscription and push_device_registered.';

create table app_private.push_delivery (
  delivery_id             uuid primary key default gen_random_uuid(),
  notification_id         uuid not null
                            references public.notification (notification_id)
                            on delete cascade,
  subscription_id         uuid not null
                            references app_private.push_subscription (subscription_id)
                            on delete cascade,
  -- Copied from the notification when queued, so the send-time check needs
  -- nothing else: what it is, what it is about, and when that was due.
  push_kind               text not null,
  source_event            text not null,
  source_medication_log_id uuid,
  source_appointment_id   uuid,
  source_due_at           timestamptz,
  delivery_status         text not null default 'pending',
  attempt_count           integer not null default 0,
  next_attempt_at         timestamptz not null default now(),
  locked_until            timestamptz,
  last_status_code        integer,
  last_error_code         text,
  delivery_created_at     timestamptz not null default now(),
  delivered_at            timestamptz,

  -- The idempotency key: one notification, one device, one row.
  constraint push_delivery_once unique (notification_id, subscription_id),
  constraint push_delivery_kind
    check (push_kind in ('medication_reminder', 'appointment_reminder', 'appointment_update')),
  constraint push_delivery_source
    check (source_event in ('medication_pre_dose', 'medication_follow_up',
                            'appointment_reminder', 'appointment_cancellation')),
  constraint push_delivery_status
    check (delivery_status in ('pending', 'sending', 'sent', 'failed', 'expired', 'skipped')),
  constraint push_delivery_attempts check (attempt_count between 0 and 20),
  -- A category, never a message: no endpoint, no provider body, no URL.
  constraint push_delivery_error_code check (
    last_error_code is null or last_error_code in (
      'network_timeout', 'network_error', 'provider_429', 'provider_5xx',
      'provider_4xx', 'invalid_vapid', 'invalid_endpoint', 'payload_too_large',
      'unexpected_redirect', 'invalid_subscription',
      'gave_up', 'source_no_longer_valid', 'owner_changed'
    )
  )
);

create index push_delivery_due_idx
  on app_private.push_delivery (next_attempt_at)
  where delivery_status in ('pending', 'sending');

create index push_delivery_subscription_idx
  on app_private.push_delivery (subscription_id);

create index push_delivery_notification_idx
  on app_private.push_delivery (notification_id);

comment on table app_private.push_delivery is
  'The Web Push queue (migration 53): one row per notification and device. '
  'Reached only through SECURITY DEFINER functions. Never holds the text.';

-- Owner only. No grant to anon, authenticated or service_role: every read
-- and write goes through the functions below.
alter table app_private.push_subscription enable row level security;
alter table app_private.push_delivery enable row level security;
revoke all on table app_private.push_subscription from public, anon, authenticated, service_role;
revoke all on table app_private.push_delivery from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- This device: register, ask, remove
-- ---------------------------------------------------------------------------
-- A browser gives one endpoint per installed app, so the endpoint is the
-- device. Registering it again - by the same patient, or by another one
-- signed in on the same phone - is one INSERT ... ON CONFLICT, atomic under
-- the unique endpoint: two registrations at once serialise on that row and
-- the later one owns it. Whatever was queued on the device for anyone else
-- is then deleted, matched by the notification's addressee rather than by
-- who owned the row a moment ago, so it holds however the two interleave.
-- The send-time check (owner_changed) covers a delivery queued in the
-- instant between.

create or replace function public.register_push_subscription(
  endpoint   text,
  p256dh     text,
  auth_key   text,
  user_agent text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  saved  uuid;
begin
  if caller is null then
    raise exception 'Sign in to turn on phone reminders.' using errcode = '42501';
  end if;

  if not exists (select 1 from public.patient where user_id = caller) then
    raise exception 'Phone reminders are for patients.' using errcode = '42501';
  end if;

  if not app_private.push_endpoint_is_allowed(endpoint) then
    raise exception 'This browser''s push service is not supported.' using errcode = '22023';
  end if;

  insert into app_private.push_subscription
    (user_id, push_endpoint, push_p256dh, push_auth, push_user_agent, push_registered_at)
  values
    (caller, endpoint, p256dh, auth_key, left(nullif(btrim(user_agent), ''), 512), now())
  on conflict (push_endpoint) do update
     set user_id            = excluded.user_id,
         push_p256dh        = excluded.push_p256dh,
         push_auth          = excluded.push_auth,
         push_user_agent    = excluded.push_user_agent,
         push_registered_at = excluded.push_registered_at
  returning subscription_id into saved;

  -- Nothing addressed to anyone else stays queued on this device.
  delete from app_private.push_delivery d
   using public.notification n
   where d.subscription_id = saved
     and n.notification_id = d.notification_id
     and n.user_id <> caller
     and d.delivery_status in ('pending', 'sending');

  -- At most ten devices per person: the least recently registered beyond
  -- that are forgotten - never the one just registered.
  delete from app_private.push_subscription
   where subscription_id in (
     select subscription_id
       from app_private.push_subscription
      where user_id = caller
        and subscription_id <> saved
      order by push_registered_at desc, subscription_id
     offset 9
   );

  return true;
end;
$$;

comment on function public.register_push_subscription(text, text, text, text) is
  'Saves this device''s push subscription for the signed-in patient '
  '(migration 53). Returns true; never returns what is stored.';

create or replace function public.unregister_push_subscription(endpoint text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  removed integer;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;

  delete from app_private.push_subscription
   where push_endpoint = endpoint
     and user_id = auth.uid();
  get diagnostics removed = row_count;
  return removed > 0;
end;
$$;

comment on function public.unregister_push_subscription(text) is
  'Removes this device''s push subscription, if the caller owns it '
  '(migration 53). Its queued deliveries go with it.';

-- The one question a browser may ask: is the subscription I hold saved
-- under me? It already knows its own endpoint; it learns nothing else.
create or replace function public.push_device_registered(endpoint text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from app_private.push_subscription
     where push_endpoint = endpoint
       and user_id = auth.uid()
  )
$$;

comment on function public.push_device_registered(text) is
  'True when this endpoint is saved under the signed-in user (migration 53). '
  'Returns nothing else.';

revoke all on function public.register_push_subscription(text, text, text, text) from public, anon;
revoke all on function public.unregister_push_subscription(text) from public, anon;
revoke all on function public.push_device_registered(text) from public, anon;
grant execute on function public.register_push_subscription(text, text, text, text) to authenticated;
grant execute on function public.unregister_push_subscription(text) to authenticated;
grant execute on function public.push_device_registered(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Queueing
-- ---------------------------------------------------------------------------
-- Only a notification that says what it is about, addressed to a patient,
-- about that patient's own dose or appointment. Anything else - a doctor's
-- message, an alert, a notification from a writer that does not tag - is
-- never pushed.

create or replace function app_private.enqueue_push_deliveries()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  kind   text;
  due_at timestamptz;
begin
  begin
    if new.notification_source in ('medication_pre_dose', 'medication_follow_up') then
      kind := 'medication_reminder';
      select ml.medication_log_scheduled_at into due_at
        from public.medication_log ml
        join public.medication_schedule ms on ms.medication_schedule_id = ml.medication_schedule_id
        join public.prescription pr on pr.prescription_id = ms.prescription_id
        join public.patient p on p.pat_id = pr.pat_id
       where ml.medication_log_id = new.notification_medication_log_id
         and p.user_id = new.user_id;
    elsif new.notification_source in ('appointment_reminder', 'appointment_cancellation') then
      kind := case new.notification_source
                when 'appointment_reminder' then 'appointment_reminder'
                else 'appointment_update'
              end;
      select a.appointment_date into due_at
        from public.appointment a
        join public.patient p on p.pat_id = a.pat_id
       where a.appointment_id = new.notification_appointment_id
         and p.user_id = new.user_id;
    else
      return null;
    end if;

    -- Not this patient's dose or appointment (or not a patient at all).
    if due_at is null then
      return null;
    end if;

    insert into app_private.push_delivery
      (notification_id, subscription_id, push_kind, source_event,
       source_medication_log_id, source_appointment_id, source_due_at)
    select new.notification_id, s.subscription_id, kind, new.notification_source,
           new.notification_medication_log_id, new.notification_appointment_id, due_at
      from app_private.push_subscription s
     where s.user_id = new.user_id
    on conflict (notification_id, subscription_id) do nothing;
  exception when others then
    -- A notification that cannot be pushed is still a notification: never
    -- undo it (or the job that stored it) over the queue.
    raise warning 'RecoverEase: push delivery not queued for notification %: %',
      new.notification_id, sqlstate;
  end;
  return null;
end;
$$;

comment on function app_private.enqueue_push_deliveries() is
  'Queues one push per device of a patient whose own reminder or '
  'cancellation notification was just stored (migration 53). Never fails '
  'the insert.';

revoke all on function app_private.enqueue_push_deliveries() from public, anon, authenticated;

create trigger notification_enqueue_push
  after insert on public.notification
  for each row
  when (new.notification_purpose is not null)
  execute function app_private.enqueue_push_deliveries();

-- ===========================================================================
-- 3. Is it still true? Checked just before sending
-- ===========================================================================
-- True when the push should still go. The same rules the jobs used to send
-- it, read again now - from the dose or appointment itself, never from the
-- notification's text.

create or replace function app_private.push_source_is_current(
  source_event  text,
  medication_log_id uuid,
  appointment_id uuid,
  due_at        timestamptz,
  owner         uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when source_event in ('medication_pre_dose', 'medication_follow_up') then exists (
      select 1
        from public.medication_log ml
        join public.medication_schedule ms on ms.medication_schedule_id = ml.medication_schedule_id
        join public.prescription pr on pr.prescription_id = ms.prescription_id
        join public.patient p on p.pat_id = pr.pat_id
       where ml.medication_log_id = push_source_is_current.medication_log_id
         and p.user_id = owner
         -- Not yet recorded (taken, skipped or missed) ...
         and ml.medication_log_status = 'pending'
         -- ... still the dose it was about, not one moved to another time ...
         and ml.medication_log_scheduled_at = due_at
         -- ... within the course's dates ...
         and ml.medication_log_dose_date >= ms.medication_schedule_start_date
         and (ms.medication_schedule_end_date is null
              or ml.medication_log_dose_date <= ms.medication_schedule_end_date)
         -- ... and the patient still wants medication reminders.
         and p.pat_reminder_is_enabled
         -- A "due soon" reminder is pointless half an hour after the dose.
         and (push_source_is_current.source_event = 'medication_follow_up'
              or now() <= ml.medication_log_scheduled_at + interval '30 minutes')
    )
    when source_event = 'appointment_reminder' then exists (
      select 1
        from public.appointment a
        join public.patient p on p.pat_id = a.pat_id
       where a.appointment_id = push_source_is_current.appointment_id
         and p.user_id = owner
         and a.appointment_status in ('scheduled', 'confirmed')
         -- An approved reschedule moves appointment_date: the old reminder
         -- is about a time that no longer exists.
         and a.appointment_date = due_at
         and a.appointment_date > now()
    )
    when source_event = 'appointment_cancellation' then exists (
      select 1
        from public.appointment a
        join public.patient p on p.pat_id = a.pat_id
       where a.appointment_id = push_source_is_current.appointment_id
         and p.user_id = owner
         and a.appointment_status = 'cancelled'
    )
    else false
  end
$$;

revoke all on function app_private.push_source_is_current(text, uuid, uuid, timestamptz, uuid)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- The worker's side: claim, then record the outcome
-- ---------------------------------------------------------------------------
-- `send-push` calls these with the service role. Both are SECURITY DEFINER
-- and executable by service_role only; no role holds a privilege on the
-- tables themselves.
--
--   expire:  a push still unsent six hours on is dropped, not sent late.
--   give up: a row a crashed run left 'sending' after its fifth attempt.
--   prune:   finished rows older than 30 days are deleted.
--   claim:   due rows, and rows a crashed run left past their two-minute
--            lease, are taken with SKIP LOCKED - two overlapping runs never
--            take the same row. Each claim counts as an attempt. A row whose
--            dose or appointment is no longer current is 'skipped', one whose
--            device changed hands is 'skipped' (owner_changed), and one whose
--            endpoint fails the allow-list is 'failed' (invalid_endpoint),
--            before anything is sent.
--   outcome: only a row still 'sending' is updated, so recording the same
--            outcome twice changes nothing.
--
-- The lease (2 minutes) outlasts a whole run: send-push stops claiming new
-- batches at 40 seconds, every request is cut off at 10, so a run ends by
-- about 50; pg_net waits 55.
--
-- Back-off after a retryable failure: 30 s, 1, 2, 4 minutes ... at most 15,
-- or the push service's Retry-After if longer (at most an hour). After the
-- fifth attempt the row is 'failed' (gave_up).

create or replace function public.claim_push_deliveries(batch_size integer default 25)
returns table (
  delivery_id     uuid,
  notification_id uuid,
  push_kind       text,
  attempt_count   integer,
  push_endpoint   text,
  push_p256dh     text,
  push_auth       text
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  update app_private.push_delivery d
     set delivery_status = 'expired',
         locked_until    = null
   where d.delivery_status in ('pending', 'sending')
     and d.delivery_created_at < now() - interval '6 hours'
     and (d.delivery_status = 'pending' or d.locked_until < now());

  update app_private.push_delivery d
     set delivery_status = 'failed',
         locked_until    = null,
         last_error_code = 'gave_up'
   where d.delivery_status = 'sending'
     and d.locked_until < now()
     and d.attempt_count >= 5;

  delete from app_private.push_delivery d
   where d.delivery_status in ('sent', 'failed', 'expired', 'skipped')
     and d.delivery_created_at < now() - interval '30 days';

  return query
  with due as (
    select d.delivery_id
      from app_private.push_delivery d
     where (d.delivery_status = 'pending' and d.next_attempt_at <= now())
        or (d.delivery_status = 'sending' and d.locked_until < now())
     order by d.next_attempt_at
     limit greatest(1, least(coalesce(batch_size, 25), 100))
     for update skip locked
  ), checked as (
    select d.delivery_id,
           case
             when n.user_id is distinct from s.user_id then 'owner_changed'
             when not app_private.push_endpoint_is_allowed(s.push_endpoint) then 'invalid_endpoint'
             when not app_private.push_source_is_current(
                    d.source_event, d.source_medication_log_id, d.source_appointment_id,
                    d.source_due_at, s.user_id) then 'source_no_longer_valid'
           end as refusal
      from due
      join app_private.push_delivery d on d.delivery_id = due.delivery_id
      join app_private.push_subscription s on s.subscription_id = d.subscription_id
      join public.notification n on n.notification_id = d.notification_id
  ), claimed as (
    update app_private.push_delivery d
       set delivery_status = case
                               when checked.refusal is null then 'sending'
                               when checked.refusal = 'invalid_endpoint' then 'failed'
                               else 'skipped'
                             end,
           attempt_count   = d.attempt_count + case when checked.refusal is null then 1 else 0 end,
           locked_until    = case when checked.refusal is null then now() + interval '2 minutes' end,
           last_error_code = coalesce(checked.refusal, d.last_error_code)
      from checked
     where d.delivery_id = checked.delivery_id
    returning d.delivery_id, d.notification_id, d.push_kind, d.attempt_count,
              d.subscription_id, d.delivery_status
  )
  select claimed.delivery_id, claimed.notification_id, claimed.push_kind,
         claimed.attempt_count, s.push_endpoint, s.push_p256dh, s.push_auth
    from claimed
    join app_private.push_subscription s on s.subscription_id = claimed.subscription_id
   where claimed.delivery_status = 'sending';
end;
$$;

create or replace function public.complete_push_delivery(
  target_delivery_id  uuid,
  outcome             text,
  status_code         integer default null,
  error_code          text default null,
  retry_after_seconds integer default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  delivery app_private.push_delivery;
  backoff  interval;
begin
  if outcome not in ('sent', 'retry', 'failed', 'gone') then
    raise exception 'Unknown push outcome %', outcome using errcode = '22023';
  end if;

  select * into delivery
    from app_private.push_delivery
   where delivery_id = target_delivery_id
     and delivery_status = 'sending'
   for update;

  if not found then
    return 'ignored';
  end if;

  if outcome = 'sent' then
    update app_private.push_delivery
       set delivery_status = 'sent', delivered_at = now(), locked_until = null,
           last_status_code = status_code, last_error_code = null
     where delivery_id = delivery.delivery_id;
    update app_private.push_subscription
       set push_last_success_at = now()
     where subscription_id = delivery.subscription_id;
    return 'sent';
  end if;

  if outcome = 'gone' then
    -- The push service says the device unsubscribed or the endpoint
    -- expired (404/410): forget it. Its deliveries, this one included, go
    -- with it.
    delete from app_private.push_subscription where subscription_id = delivery.subscription_id;
    return 'gone';
  end if;

  if outcome = 'retry' and delivery.attempt_count < 5 then
    backoff := least(
      interval '30 seconds' * power(2, greatest(delivery.attempt_count - 1, 0)),
      interval '15 minutes'
    );
    if retry_after_seconds is not null and retry_after_seconds > 0 then
      backoff := greatest(backoff, make_interval(secs => least(retry_after_seconds, 3600)));
    end if;
    update app_private.push_delivery
       set delivery_status = 'pending', next_attempt_at = now() + backoff,
           locked_until = null, last_status_code = status_code,
           last_error_code = error_code
     where delivery_id = delivery.delivery_id;
    return 'retry';
  end if;

  update app_private.push_delivery
     set delivery_status = 'failed', locked_until = null,
         last_status_code = status_code,
         last_error_code = case when outcome = 'retry' then 'gave_up' else coalesce(error_code, 'provider_4xx') end
   where delivery_id = delivery.delivery_id;
  return 'failed';
end;
$$;

comment on function public.claim_push_deliveries(integer) is
  'send-push: expire, give up, prune, then claim due deliveries with SKIP '
  'LOCKED, skipping any no longer current (migration 53). Service role only.';
comment on function public.complete_push_delivery(uuid, text, integer, text, integer) is
  'send-push: record one delivery''s outcome - sent, retry (with back-off), '
  'failed, or gone (removes the device) - as a category, never a message '
  '(migration 53). Service role only.';

revoke all on function public.claim_push_deliveries(integer) from public, anon, authenticated;
revoke all on function public.complete_push_delivery(uuid, text, integer, text, integer) from public, anon, authenticated;
grant execute on function public.claim_push_deliveries(integer) to service_role;
grant execute on function public.complete_push_delivery(uuid, text, integer, text, integer) to service_role;

-- ---------------------------------------------------------------------------
-- Waking send-push
-- ---------------------------------------------------------------------------
-- Called by the pg_cron job that supabase/manual/web_push_activate.sql
-- creates. Reads the function's URL and shared secret from Vault, so neither
-- is in any migration or job definition. Without pg_net, or without the
-- secrets, or with nothing queued, it returns a reason and sends nothing.

create or replace function app_private.request_push_dispatch()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  dispatch_url text;
  dispatch_secret text;
begin
  if not exists (
    select 1 from app_private.push_delivery
     where (delivery_status = 'pending' and next_attempt_at <= now())
        or (delivery_status = 'sending' and locked_until < now())
  ) then
    return 'nothing due';
  end if;

  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    return 'pg_net is not installed';
  end if;

  if to_regclass('vault.decrypted_secrets') is null then
    return 'vault is not available';
  end if;

  execute $sql$
    select max(decrypted_secret) filter (where name = 'push_dispatch_url'),
           max(decrypted_secret) filter (where name = 'push_dispatch_secret')
      from vault.decrypted_secrets
     where name in ('push_dispatch_url', 'push_dispatch_secret')
  $sql$ into dispatch_url, dispatch_secret;

  if dispatch_url is null or dispatch_secret is null then
    return 'push_dispatch_url or push_dispatch_secret is not in Vault';
  end if;

  execute $sql$
    select net.http_post(
      url := $1,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-push-dispatch-secret', $2
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 55000
    )
  $sql$ using dispatch_url, dispatch_secret;

  return 'requested';
end;
$$;

comment on function app_private.request_push_dispatch() is
  'Asks pg_net to call the send-push Edge Function when deliveries are due '
  '(migration 53). Inert until pg_net and the Vault secrets exist.';

revoke all on function app_private.request_push_dispatch() from public, anon, authenticated;

reset lock_timeout;
