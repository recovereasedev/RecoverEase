-- ===========================================================================
-- Turn Web Push delivery ON (after migration 53). NOT a migration.
-- ===========================================================================
-- Run by hand in the SQL editor, only with Kean's approval, after:
--   1. migration 53 is applied;
--   2. the send-push Edge Function is deployed (--no-verify-jwt) and its
--      secrets are set: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT,
--      PUSH_DISPATCH_SECRET (docs/deployment.md, "Web Push").
--
-- Replace the two placeholders below. The secret must be the SAME value as
-- the Edge Function's PUSH_DISPATCH_SECRET. Both go into Supabase Vault, so
-- neither appears in cron.job or in any log of this job.
--
-- This installs pg_net (an extension). That is a production change.
-- ===========================================================================

create extension if not exists pg_net;

select vault.create_secret(
  'https://<project-ref>.supabase.co/functions/v1/send-push',
  'push_dispatch_url',
  'RecoverEase send-push URL (migration 53)'
);

select vault.create_secret(
  '<the same value as the PUSH_DISPATCH_SECRET Edge Function secret>',
  'push_dispatch_secret',
  'RecoverEase send-push shared secret (migration 53)'
);

-- Every minute. When nothing is due the function returns at once without
-- calling anything.
select cron.schedule(
  'recoverease-push-deliveries',
  '* * * * *',
  $job$ select app_private.request_push_dispatch() $job$
);

-- Check: should say 'nothing due' (or 'requested' if a delivery is queued).
select app_private.request_push_dispatch();
