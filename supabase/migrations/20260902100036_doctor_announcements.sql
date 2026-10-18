-- ===========================================================================
-- RecoverEase — 29. Doctors write announcements for their own patients
-- ===========================================================================
-- A doctor can now write an announcement for their own patients: once
-- published it reaches the patients currently assigned to them, and only
-- while the doctor is active. A Clinic Admin's announcement still reaches
-- their whole clinic, and a platform announcement everyone; those stay their
-- authors' alone.
--
--   * `announcement.doc_id`: the doctor who wrote it. An announcement still
--     has exactly one author - a Clinic Admin, a doctor or a Super Admin -
--     and its clinic still follows from that author, set by the database
--     (`announcement_assign_clinic`), never taken from the request: a
--     doctor's is their clinic's, which keeps it under that clinic's Clinic
--     Admin.
--   * Who reads a doctor's announcement once published: the patients whose
--     assigned doctor it is, now (`app_private.current_assigned_doctor_id()`,
--     NULL unless the caller is a patient whose doctor is active) - so the
--     audience follows reassignment, and a deactivated doctor's announcements
--     leave their patients' feeds even before the patients are moved. Not
--     the doctor's colleagues, and no one in another clinic.
--   * A doctor writes only as themselves, and only while active
--     (`app_private.current_doctor_id()` is NULL for a deactivated doctor),
--     into their own clinic. They read their own, drafts included, and
--     publish, withdraw, edit or delete only their own announcements - never
--     a Clinic Admin's, another doctor's, another clinic's or a platform one.
--     Who wrote an announcement and whose clinic it is still never change
--     (`announcement_guard_author`, now covering `doc_id` too).
--   * What does not change: a Clinic Admin keeps the access to every
--     announcement of their clinic that they already had - reading,
--     publishing, withdrawing and deleting it, a doctor's included; a
--     platform announcement is still changed only through the Super Admin's
--     own functions, which refuse anything that is not one; a Clinic Admin's
--     and a platform announcement reach exactly whom they reached before.
--     Each is audited by the existing announcement trigger, as an
--     administration entry of its clinic.
--
-- The four policies are replaced by ones that keep each Clinic Admin
-- condition word for word and add the doctor's and the patient's beside it,
-- so each role and action still has a single policy.
--
-- Independent of migrations 34 and 35: it touches nothing either does
-- (tests/db/doctor-announcements.test.ts applies it after 33 and 35 without
-- 34, as production has them, and compares the schema once 34 follows).
--
-- Rollback, should it be needed:
-- supabase/rollbacks/20260902100036_doctor_announcements.down.sql, applied as
-- a new migration with approval. It refuses while a doctor's announcement
-- exists: it would have no author to go back to.
-- ===========================================================================

-- Migration 33's announcement authors must be there, and this not yet.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'announcement' and column_name = 'super_admin_id'
  ) then
    raise exception 'Migration 36 needs migration 33 first. Nothing was applied.';
  end if;

  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'announcement' and column_name = 'doc_id'
  ) then
    raise exception 'Migration 36 has already been applied. Nothing was changed.';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- A doctor as an announcement's author
-- ---------------------------------------------------------------------------

alter table public.announcement
  add column doc_id uuid
    references public.doctor (doc_id)
    on delete restrict;

comment on column public.announcement.doc_id is
  'The doctor who wrote a clinic announcement; empty for a Clinic Admin''s and for a platform one.';

create index announcement_doc_id_idx
  on public.announcement (doc_id)
  where doc_id is not null;

alter table public.announcement drop constraint announcement_one_author;
alter table public.announcement
  add constraint announcement_one_author
    check (num_nonnulls(admin_id, doc_id, super_admin_id) = 1);

alter table public.announcement drop constraint announcement_clinic_follows_author;
alter table public.announcement
  add constraint announcement_clinic_follows_author
    check (
      (admin_id is not null and clinic_id is not null)
      or (doc_id is not null and clinic_id is not null)
      or (super_admin_id is not null and clinic_id is null)
    );

-- The clinic comes from the author, whatever the request says.
create or replace function public.announcement_assign_clinic()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.admin_id is not null then
    new.clinic_id := (select a.clinic_id from public.admin a
                       where a.admin_id = new.admin_id);
  elsif new.doc_id is not null then
    -- A doctor's announcement is their clinic's.
    new.clinic_id := (select d.clinic_id from public.doctor d
                       where d.doc_id = new.doc_id);
  else
    -- A platform announcement belongs to no clinic.
    new.clinic_id := null;
  end if;
  return new;
end;
$$;

create or replace function public.announcement_guard_author()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.admin_id is distinct from old.admin_id
     or new.doc_id is distinct from old.doc_id
     or new.super_admin_id is distinct from old.super_admin_id
     or new.clinic_id is distinct from old.clinic_id then
    raise exception 'An announcement keeps the author and clinic it was written with'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

comment on function public.announcement_guard_author() is
  'Refuses any change to an announcement''s author or clinic - a Clinic '
  'Admin''s, a doctor''s or a platform one. Run only by the '
  'announcement_author_is_fixed trigger.';

drop trigger if exists announcement_author_is_fixed on public.announcement;
create trigger announcement_author_is_fixed
  before update of admin_id, doc_id, super_admin_id, clinic_id on public.announcement
  for each row execute function public.announcement_guard_author();

-- ---------------------------------------------------------------------------
-- A patient's doctor, while active
-- ---------------------------------------------------------------------------
-- `app_private.is_my_doctor` (migration 05) answers for one doctor and does
-- not ask whether they are active; a doctor's announcement needs both, and
-- once per query rather than once per row.

create or replace function app_private.current_assigned_doctor_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select d.doc_id
    from public.patient p
    join public.doctor d on d.doc_id = p.doc_id
   where p.user_id = (select auth.uid())
     and d.doc_is_active;
$$;

comment on function app_private.current_assigned_doctor_id() is
  'The doctor the calling patient is assigned to now, if that doctor is '
  'active; NULL for anyone else. Who reads a doctor''s announcements.';

revoke all on function app_private.current_assigned_doctor_id() from public;
grant execute on function app_private.current_assigned_doctor_id()
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Who reads and writes what
-- ---------------------------------------------------------------------------
-- Migration 30's policies, each Clinic Admin condition unchanged, with the
-- doctor's and the patient's added beside it. A platform announcement has no
-- clinic and no doctor, so it matches neither.

-- Published: a platform one everyone; a Clinic Admin's their clinic's
-- members; a doctor's their assigned patients while the doctor is active -
-- not their colleagues. Drafts: the clinic's Clinic Admin, and a doctor
-- their own.
drop policy if exists announcement_select_published on public.announcement;
create policy announcement_select_published
  on public.announcement for select to authenticated
  using (
    (
      announcement_published_at is not null
      and (
        clinic_id is null
        or (doc_id is null and clinic_id = (select app_private.current_clinic_id()))
        or doc_id = (select app_private.current_assigned_doctor_id())
      )
    )
    or clinic_id = (select app_private.admin_clinic_id())
    or doc_id = (select app_private.current_doctor_id())
  );

drop policy if exists announcement_insert_admin on public.announcement;
create policy announcement_insert_author
  on public.announcement for insert to authenticated
  with check (
    (
      clinic_id = (select app_private.admin_clinic_id())
      and admin_id = (select app_private.current_admin_id())
    )
    or (
      doc_id = (select app_private.current_doctor_id())
      and clinic_id = (select app_private.current_clinic_id())
    )
  );

drop policy if exists announcement_update_admin on public.announcement;
create policy announcement_update_author
  on public.announcement for update to authenticated
  using (
    clinic_id = (select app_private.admin_clinic_id())
    or doc_id = (select app_private.current_doctor_id())
  )
  with check (
    clinic_id = (select app_private.admin_clinic_id())
    or doc_id = (select app_private.current_doctor_id())
  );

drop policy if exists announcement_delete_admin on public.announcement;
create policy announcement_delete_author
  on public.announcement for delete to authenticated
  using (
    clinic_id = (select app_private.admin_clinic_id())
    or doc_id = (select app_private.current_doctor_id())
  );
