-- ===========================================================================
-- STAGING ONLY. Synthetic records for PayMongo sandbox testing.
-- ===========================================================================
-- After every migration production has (all but 34) is applied to the
-- staging project, and after the auth user below exists
-- (Authentication -> Users -> Add user, email exactly as below, a password
-- you choose; never a real person's address):
--
--   * migration 29's clinic is renamed "Staging Synthetic Clinic", so nothing
--     on staging can be mistaken for Harborview (production's clinic has a
--     different id in a different project);
--   * that auth user becomes its Clinic Admin. Migration 68's trigger and
--     backfill have already put the clinic on Free.
--
-- No doctor, patient or clinical record is created: billing needs none.
--
-- It refuses to touch any database that already has a patient, a doctor, an
-- account other than this one, more than one clinic, or a live payment - so
-- it can never run against production (which has all of those). Running it
-- twice changes nothing more.
-- ===========================================================================

do $$
declare
  v_email constant text := 'staging.clinic.admin@recoverease.test';
  v_user uuid;
  v_clinic uuid;
begin
  if exists (select 1 from public.patient)
     or exists (select 1 from public.doctor)
     or exists (select 1 from public.user_account where user_email <> v_email)
     or exists (select 1 from public.subscription_payment where payment_livemode) then
    raise exception 'This database has real-looking records. The staging seed runs only on an empty staging project. Nothing was changed.';
  end if;

  if (select count(*) from public.clinic) <> 1 then
    raise exception 'Expected exactly one clinic (migration 29). Nothing was changed.';
  end if;

  select id into v_user from auth.users where lower(email) = v_email;
  if v_user is null then
    raise exception 'Create the auth user % first (Authentication -> Users). Nothing was changed.', v_email;
  end if;

  select clinic_id into v_clinic from public.clinic;

  update public.clinic
     set clinic_name = 'Staging Synthetic Clinic'
   where clinic_id = v_clinic
     and clinic_name <> 'Staging Synthetic Clinic';

  insert into public.user_account (user_id, user_email, user_role)
  values (v_user, v_email, 'admin')
  on conflict do nothing;

  insert into public.admin (user_id, admin_first_name, admin_last_name, clinic_id)
  values (v_user, 'Staging', 'Admin', v_clinic)
  on conflict do nothing;
end
$$;
