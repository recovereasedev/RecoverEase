-- ===========================================================================
-- RecoverEase — 53. Web Push: a patient's phone is told a reminder is waiting
-- ===========================================================================
-- Until now a reminder reached a patient only while RecoverEase was open:
-- the bell and the reminder tray ask the server every minute. This lets an
-- Android phone with RecoverEase installed show a notification while the app
-- is closed. It adds:
--
--   * `push_subscription` - one row per device a patient switched push on
--     for: the browser's push endpoint and its two public keys. A patient
--     reads their own rows; every write goes through the two functions
--     below, never the table.
--   * `push_delivery` - the queue. One row per (notification, device),
--     unique, so one reminder is pushed to one device at most once however
--     often anything runs. Retries, back-off and give-up live here.
--   * a trigger on `notification`: when a medication or appointment
--     notification is stored for a patient, one delivery is queued for each
--     of that patient's devices. Every reminder job (migrations 08, 18, 37,
--     42, 48) already ends with that insert, so no job is changed.
--   * the functions the `send-push` Edge Function calls with the service
--     role: claim due deliveries, record each outcome.
--   * `app_private.request_push_dispatch()`, which asks pg_net to call
--     `send-push`. It does nothing - and says so - until pg_net is installed
--     and the two Vault secrets exist.
--
-- What it deliberately does NOT do:
--
--   * Schedule anything. No pg_cron job is created and pg_net is not
--     installed: applying this migration sends no push. Turning delivery on
--     is a separate, approved step (docs/deployment.md, "Web Push",
--     supabase/manual/web_push_activate.sql).
--   * Put clinical words on a lock screen. The queue holds only the kind of
--     reminder; the notification's own text (which names the medicine and
--     the dose) is never read by the push path. The Edge Function sends a
--     fixed sentence.
--   * Push doctors, admins or anyone but a patient, or any notification
--     type but `medication` and `appointment`. Guidance Chat's alerts are
--     untouched.
--   * Ever stop a reminder being stored. Queueing failures are caught and
--     logged as a warning; the notification insert always succeeds.
--
-- Rollback: supabase/rollbacks/20260902100053_web_push_notifications.down.sql
-- ===========================================================================

do $$
begin
  if to_regclass('public.notification') is null
     or to_regclass('public.patient') is null
     or to_regprocedure('public.notification_assign_created_at()') is null then
    raise exception 'Migration 53 needs migration 44 first. Nothing was applied.';
  end if;
end
$$;

-- Adding the trigger locks `notification`, which the reminder jobs write -
-- the pre-dose job every minute. Waiting at most 3 seconds for that lock, the
-- migration fails rather than holding the website up behind it
-- (docs/deployment.md, "Migration timing and run history"). A plain SET, not
-- SET LOCAL; it is reset at the end.
set lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- push_subscription
-- ---------------------------------------------------------------------------

create table public.push_subscription (
  subscription_id         uuid primary key default gen_random_uuid(),
  user_id                 uuid not null
                            references public.user_account (user_id)
                            on delete cascade,
  push_endpoint           text not null,
  push_p256dh             text not null,
  push_auth               text not null,
  push_user_agent         text,
  push_created_at         timestamptz not null default now(),
  push_last_success_at    timestamptz,

  constraint push_subscription_endpoint_unique unique (push_endpoint),
  constraint push_subscription_endpoint_https
    check (push_endpoint ~ '^https://[^\s]+$' and char_length(push_endpoint) <= 2048),
  -- base64url, no padding: a P-256 public key is 65 bytes (87 characters),
  -- the auth secret 16 bytes (22 characters).
  constraint push_subscription_p256dh_shape
    check (push_p256dh ~ '^[A-Za-z0-9_-]{80,100}$'),
  constraint push_subscription_auth_shape
    check (push_auth ~ '^[A-Za-z0-9_-]{16,44}$'),
  constraint push_subscription_user_agent_length
    check (push_user_agent is null or char_length(push_user_agent) <= 512)
);

create index push_subscription_user_idx on public.push_subscription (user_id);

comment on table public.push_subscription is
  'A device a patient switched push notifications on for (migration 53). '
  'Read by its owner; written only by register_/unregister_push_subscription '
  'and by the send-push Edge Function, which removes an endpoint the push '
  'service reports gone.';

alter table public.push_subscription enable row level security;

create policy push_subscription_select_own
  on public.push_subscription for select to authenticated
  using (user_id = (select auth.uid()));

revoke all on table public.push_subscription from anon;
revoke insert, update, delete, truncate, references, trigger
  on table public.push_subscription from authenticated;
grant select on table public.push_subscription to authenticated;
grant all on table public.push_subscription to service_role;

-- ---------------------------------------------------------------------------
-- push_delivery
-- ---------------------------------------------------------------------------

create table public.push_delivery (
  delivery_id             uuid primary key default gen_random_uuid(),
  notification_id         uuid not null
                            references public.notification (notification_id)
                            on delete cascade,
  subscription_id         uuid not null
                            references public.push_subscription (subscription_id)
                            on delete cascade,
  push_kind               text not null,
  delivery_status         text not null default 'pending',
  attempt_count           integer not null default 0,
  next_attempt_at         timestamptz not null default now(),
  locked_until            timestamptz,
  last_status_code        integer,
  last_error              text,
  delivery_created_at     timestamptz not null default now(),
  delivered_at            timestamptz,

  -- The idempotency key: one reminder, one device, one row.
  constraint push_delivery_once unique (notification_id, subscription_id),
  constraint push_delivery_kind
    check (push_kind in ('medication', 'appointment')),
  constraint push_delivery_status
    check (delivery_status in ('pending', 'sending', 'sent', 'failed', 'expired')),
  constraint push_delivery_attempts check (attempt_count between 0 and 20),
  constraint push_delivery_error_length
    check (last_error is null or char_length(last_error) <= 300)
);

create index push_delivery_due_idx
  on public.push_delivery (next_attempt_at)
  where delivery_status in ('pending', 'sending');

create index push_delivery_subscription_idx
  on public.push_delivery (subscription_id);

comment on table public.push_delivery is
  'The Web Push queue (migration 53): one row per notification and device. '
  'Service role only. Holds the kind of reminder, never its text.';

-- Nobody but the service role reads or writes the queue. The one policy
-- says so explicitly - a signed-in user's read returns no row - and every
-- write privilege is withdrawn from them.
alter table public.push_delivery enable row level security;

create policy push_delivery_service_only
  on public.push_delivery for select to authenticated
  using (false);

revoke all on table public.push_delivery from anon;
revoke insert, update, delete, truncate, references, trigger
  on table public.push_delivery from authenticated;
grant select on table public.push_delivery to authenticated;
grant all on table public.push_delivery to service_role;

-- ---------------------------------------------------------------------------
-- Registering and removing this device
-- ---------------------------------------------------------------------------
-- A browser gives one endpoint per installed app, so the endpoint is the
-- device. If another account signed in on the same phone registered it
-- before, it moves to the caller - and anything still queued for the
-- previous account on it is dropped, so nobody's reminder reaches the next
-- person to use the phone.

create or replace function public.register_push_subscription(
  endpoint   text,
  p256dh     text,
  auth_key   text,
  user_agent text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  existing public.push_subscription;
  saved uuid;
begin
  if caller is null then
    raise exception 'Sign in to turn on notifications.' using errcode = '42501';
  end if;

  if not exists (select 1 from public.patient where user_id = caller) then
    raise exception 'Push notifications are for patients.' using errcode = '42501';
  end if;

  select * into existing
    from public.push_subscription
   where push_endpoint = endpoint
   for update;

  if found and existing.user_id <> caller then
    delete from public.push_delivery
     where subscription_id = existing.subscription_id
       and delivery_status in ('pending', 'sending');
  end if;

  insert into public.push_subscription
    (user_id, push_endpoint, push_p256dh, push_auth, push_user_agent)
  values
    (caller, endpoint, p256dh, auth_key, left(nullif(btrim(user_agent), ''), 512))
  on conflict (push_endpoint) do update
     set user_id         = excluded.user_id,
         push_p256dh     = excluded.push_p256dh,
         push_auth       = excluded.push_auth,
         push_user_agent = excluded.push_user_agent
  returning subscription_id into saved;

  -- At most ten devices per person: the oldest beyond that are forgotten.
  delete from public.push_subscription
   where subscription_id in (
     select subscription_id
       from public.push_subscription
      where user_id = caller
      order by push_created_at desc, subscription_id
     offset 10
   );

  return saved;
end;
$$;

comment on function public.register_push_subscription(text, text, text, text) is
  'Saves this device''s push subscription for the signed-in patient '
  '(migration 53). Moves an endpoint another account registered, dropping '
  'what was queued for that account on it.';

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
    return false;
  end if;

  delete from public.push_subscription
   where push_endpoint = endpoint
     and user_id = auth.uid();
  get diagnostics removed = row_count;
  return removed > 0;
end;
$$;

comment on function public.unregister_push_subscription(text) is
  'Removes this device''s push subscription, if the caller owns it '
  '(migration 53). Its queued deliveries go with it.';

revoke all on function public.register_push_subscription(text, text, text, text) from public, anon;
revoke all on function public.unregister_push_subscription(text) from public, anon;
grant execute on function public.register_push_subscription(text, text, text, text) to authenticated;
grant execute on function public.unregister_push_subscription(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Queueing: one delivery per device when a patient's reminder is stored
-- ---------------------------------------------------------------------------

create or replace function app_private.enqueue_push_deliveries()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    insert into public.push_delivery (notification_id, subscription_id, push_kind)
    select new.notification_id, subscription.subscription_id, new.notification_type::text
      from public.push_subscription subscription
     where subscription.user_id = new.user_id
       and exists (select 1 from public.patient where patient.user_id = new.user_id)
    on conflict (notification_id, subscription_id) do nothing;
  exception when others then
    -- A reminder that cannot be pushed is still a reminder: never undo the
    -- notification (or the job that stored it) over the queue.
    raise warning 'RecoverEase: push delivery not queued for notification %: %',
      new.notification_id, sqlerrm;
  end;
  return null;
end;
$$;

comment on function app_private.enqueue_push_deliveries() is
  'Queues one push delivery per device of a patient whose medication or '
  'appointment notification was just stored (migration 53). Never fails '
  'the insert.';

revoke all on function app_private.enqueue_push_deliveries() from public, anon, authenticated;

drop trigger if exists notification_enqueue_push on public.notification;
create trigger notification_enqueue_push
  after insert on public.notification
  for each row
  when (new.notification_type in ('medication', 'appointment'))
  execute function app_private.enqueue_push_deliveries();

-- ---------------------------------------------------------------------------
-- The worker's side: claim, then record the outcome
-- ---------------------------------------------------------------------------
-- `send-push` calls these with the service role, once a minute when
-- delivery is switched on.
--
--   claim:   pending rows that are due, and rows a crashed run left
--            'sending' past their lock, are taken with SKIP LOCKED, so two
--            overlapping runs never take the same row. Each claim counts as
--            an attempt.
--   expire:  a reminder still unsent six hours on is no longer a reminder;
--            it is marked 'expired' instead of arriving late.
--   prune:   finished rows older than 30 days are deleted.
--   outcome: only a row still 'sending' is updated, so recording the same
--            outcome twice changes nothing.
--
-- Back-off after a retryable failure: 30 s, 1, 2, 4 minutes ... at most 15,
-- or the push service's Retry-After if longer (at most an hour). After the
-- fifth attempt the row is 'failed'.

create or replace function public.claim_push_deliveries(batch_size integer default 50)
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
set search_path = ''
as $$
#variable_conflict use_column
begin
  update public.push_delivery d
     set delivery_status = 'expired',
         locked_until    = null
   where d.delivery_status in ('pending', 'sending')
     and d.delivery_created_at < now() - interval '6 hours'
     and (d.delivery_status = 'pending' or d.locked_until < now());

  update public.push_delivery d
     set delivery_status = 'failed',
         locked_until    = null,
         last_error      = coalesce(d.last_error, 'gave up after 5 attempts')
   where d.delivery_status = 'sending'
     and d.locked_until < now()
     and d.attempt_count >= 5;

  delete from public.push_delivery d
   where d.delivery_status in ('sent', 'failed', 'expired')
     and d.delivery_created_at < now() - interval '30 days';

  return query
  with due as (
    select d.delivery_id
      from public.push_delivery d
     where (d.delivery_status = 'pending' and d.next_attempt_at <= now())
        or (d.delivery_status = 'sending' and d.locked_until < now())
     order by d.next_attempt_at
     limit greatest(1, least(coalesce(batch_size, 50), 200))
     for update skip locked
  ), claimed as (
    update public.push_delivery d
       set delivery_status = 'sending',
           attempt_count   = d.attempt_count + 1,
           locked_until    = now() + interval '2 minutes'
      from due
     where d.delivery_id = due.delivery_id
    returning d.delivery_id, d.notification_id, d.push_kind, d.attempt_count, d.subscription_id
  )
  select claimed.delivery_id, claimed.notification_id, claimed.push_kind,
         claimed.attempt_count, s.push_endpoint, s.push_p256dh, s.push_auth
    from claimed
    join public.push_subscription s on s.subscription_id = claimed.subscription_id;
end;
$$;

create or replace function public.complete_push_delivery(
  target_delivery_id  uuid,
  outcome             text,
  status_code         integer default null,
  error_text          text default null,
  retry_after_seconds integer default null
)
returns text
language plpgsql
set search_path = ''
as $$
declare
  delivery public.push_delivery;
  backoff interval;
begin
  if outcome not in ('sent', 'retry', 'failed', 'gone') then
    raise exception 'Unknown push outcome %', outcome using errcode = '22023';
  end if;

  select * into delivery
    from public.push_delivery
   where delivery_id = target_delivery_id
     and delivery_status = 'sending'
   for update;

  if not found then
    return 'ignored';
  end if;

  if outcome = 'sent' then
    update public.push_delivery
       set delivery_status = 'sent', delivered_at = now(), locked_until = null,
           last_status_code = status_code, last_error = null
     where delivery_id = delivery.delivery_id;
    update public.push_subscription
       set push_last_success_at = now()
     where subscription_id = delivery.subscription_id;
    return 'sent';
  end if;

  if outcome = 'gone' then
    -- The push service says the device unsubscribed or the endpoint
    -- expired (404/410): forget it. Its deliveries, this one included, go
    -- with it.
    delete from public.push_subscription where subscription_id = delivery.subscription_id;
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
    update public.push_delivery
       set delivery_status = 'pending', next_attempt_at = now() + backoff,
           locked_until = null, last_status_code = status_code,
           last_error = left(error_text, 300)
     where delivery_id = delivery.delivery_id;
    return 'retry';
  end if;

  update public.push_delivery
     set delivery_status = 'failed', locked_until = null,
         last_status_code = status_code,
         last_error = left(coalesce(error_text, 'gave up after 5 attempts'), 300)
   where delivery_id = delivery.delivery_id;
  return 'failed';
end;
$$;

comment on function public.claim_push_deliveries(integer) is
  'send-push: expire stale, prune old, then claim due deliveries with SKIP '
  'LOCKED (migration 53). Service role only.';
comment on function public.complete_push_delivery(uuid, text, integer, text, integer) is
  'send-push: record one delivery''s outcome - sent, retry (with back-off), '
  'failed, or gone (removes the device) (migration 53). Service role only.';

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
    select 1 from public.push_delivery
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
