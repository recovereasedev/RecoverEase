-- ===========================================================================
-- Turn Web Push delivery OFF. NOT a migration. Safe to run more than once.
-- ===========================================================================
-- Stops the job that wakes send-push. Reminders keep being stored and shown
-- in the app; deliveries already queued simply expire after six hours.
-- Saved devices are kept, so turning delivery back on needs nothing from
-- patients. pg_net is left installed (removing an extension other projects
-- may use is a separate decision); the Vault secrets are removed.
-- ===========================================================================

select cron.unschedule(jobid)
  from cron.job
 where jobname = 'recoverease-push-deliveries';

delete from vault.secrets
 where name in ('push_dispatch_url', 'push_dispatch_secret');
