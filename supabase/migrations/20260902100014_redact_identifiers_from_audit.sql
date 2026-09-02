-- ===========================================================================
-- RecoverEase — 15. Keep patient identifiers out of the audit trail
-- ===========================================================================
-- Found while verifying the live claim that the audit trail does not expose
-- PHI. It mostly does not. This is the gap.
--
-- `audit_row_change` takes a disclosure mode. Patient-touching tables use
-- `keys_only`, which records column names and never values — that part works
-- and was verified live. Four tables were classified as administrative and
-- given `values`: doctor, announcement, system_setting and **user_account**.
--
-- The first three hold no patient rows. `user_account` holds one for every
-- patient, so its audit entries looked like this:
--
--   {"record": {"user_id": "...", "user_role": "patient",
--               "user_email": "patient@example.com", ...}}
--
-- An administrator has SELECT on `audit_log`. So although the audit screen
-- never renders that payload, an administrator could read the email address
-- of every patient in the system straight from /rest/v1/audit_log. The UI not
-- showing it is not a boundary — that is the premise the whole authorization
-- model is built on.
--
-- It also contradicted the codebase's own stated intent: `create-account`
-- writes its audit entry with the comment "Deliberately no name, email or
-- clinical detail: administrators can read audit_log and must not learn
-- patient identities from it". The Edge Function honoured that. The trigger
-- on the same table did not.
--
-- An email address is not a diagnosis, but it identifies a person, and
-- "this identified person is a patient of this clinic" is health information.
--
-- Fix: a fourth trigger argument listing columns to omit from disclosure.
-- `user_account` keeps `values` mode — an administrator reviewing account
-- provisioning still sees the role and the account id, which is what makes
-- the entry useful — and loses only the identifier.
--
-- Redaction is applied to both shapes: the whole-record form used on insert
-- and delete, and the before/after form used on update.
-- ===========================================================================

create or replace function public.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  entity_name     text := tg_argv[0];
  id_column       text := tg_argv[1];
  disclosure_mode text := coalesce(tg_argv[2], 'keys_only');
  -- Comma separated, optional. Columns named here never have their values
  -- recorded, in any mode. Column *names* are still recorded: knowing that
  -- an email changed is useful and harmless; knowing the address is not.
  redacted        text[] := string_to_array(coalesce(tg_argv[3], ''), ',');
  row_json        jsonb;
  old_json        jsonb;
  target_id       uuid;
  details         jsonb;
  changed_keys    text[];
begin
  row_json := to_jsonb(coalesce(new, old));
  target_id := (row_json ->> id_column)::uuid;

  if tg_op = 'UPDATE' then
    old_json := to_jsonb(old);

    select coalesce(array_agg(key order by key), '{}')
      into changed_keys
      from jsonb_each(row_json) as each_new(key, value)
     where value is distinct from (old_json -> each_new.key);

    -- Nothing actually changed; do not manufacture an audit entry.
    if cardinality(changed_keys) = 0 then
      return coalesce(new, old);
    end if;

    if disclosure_mode = 'values' then
      details := jsonb_build_object(
        'changed_columns', to_jsonb(changed_keys),
        'before', (select jsonb_object_agg(k, old_json -> k)
                     from unnest(changed_keys) as k
                    where not (k = any (redacted))),
        'after',  (select jsonb_object_agg(k, row_json -> k)
                     from unnest(changed_keys) as k
                    where not (k = any (redacted)))
      );
    else
      details := jsonb_build_object('changed_columns', to_jsonb(changed_keys));
    end if;

  elsif disclosure_mode = 'values' then
    details := jsonb_build_object(
      'record', (select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
                   from jsonb_each(row_json)
                  where not (key = any (redacted)))
    );
  else
    details := jsonb_build_object(
      'columns', to_jsonb(array(select jsonb_object_keys(row_json) order by 1))
    );
  end if;

  insert into public.audit_log (
    user_id, audit_log_action, audit_log_entity,
    audit_log_entity_id, audit_log_details
  )
  values (
    (select auth.uid()), lower(tg_op), entity_name, target_id, details
  );

  return coalesce(new, old);
end;
$$;

comment on function public.audit_row_change() is
  'Generic audit trigger. Arguments: entity name, primary key column, '
  'disclosure mode (''values'' or ''keys_only''), and an optional comma '
  'separated list of columns whose values must never be recorded. '
  'Patient-touching tables must use ''keys_only'': administrators can read '
  'audit_log but not patient records, so recording values there would leak '
  'PHI through the audit trail. `user_account` spans both worlds — it holds '
  'a row for every patient — so it discloses values with the email redacted.';

drop trigger if exists user_account_audit on public.user_account;
create trigger user_account_audit
  after insert or update or delete on public.user_account
  for each row execute function
    public.audit_row_change('user_account', 'user_id', 'values', 'user_email');

-- CREATE OR REPLACE resets EXECUTE to PUBLIC, which would republish this as
-- /rest/v1/rpc/audit_row_change. Migration 11 exists to close exactly that.
revoke all on function public.audit_row_change() from public, anon, authenticated;
