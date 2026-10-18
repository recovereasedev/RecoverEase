-- ===========================================================================
-- Rollback of migration 36 (doctor_announcements)
-- ===========================================================================
-- Returns the announcement table, its triggers and its policies to exactly
-- what migration 33 left (and 34 and 35, which do not touch them), and
-- removes the patient's-doctor helper 36 added, catalog
-- entry by catalog entry (tests/db/doctor-announcements.test.ts). Applied as a
-- new migration, with approval. Roll this back before 35's, 34's and 33's.
--
-- It refuses, changing nothing, while any doctor's announcement exists: it
-- would have no author to go back to. Delete or keep them first - that is a
-- decision, not something a rollback makes.
-- ===========================================================================

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'announcement' and column_name = 'doc_id'
  ) then
    raise exception 'Migration 36 is not applied. Nothing was changed.';
  end if;

  if exists (select 1 from public.announcement where doc_id is not null) then
    raise exception 'Doctors'' announcements exist, and they have no author to go back to. Nothing was changed.';
  end if;
end
$$;

drop policy announcement_insert_author on public.announcement;
drop policy announcement_update_author on public.announcement;
drop policy announcement_delete_author on public.announcement;

-- Migration 30's policies, exactly as it wrote them.
-- announcement: published ones reach the members of their clinic, and a
-- platform one (no clinic) everyone; drafts only their clinic's admins.
drop policy if exists announcement_select_published on public.announcement;
create policy announcement_select_published
  on public.announcement for select to authenticated
  using (
    (
      announcement_published_at is not null
      and (clinic_id is null or clinic_id = (select app_private.current_clinic_id()))
    )
    or clinic_id = (select app_private.admin_clinic_id())
  );

drop policy if exists announcement_insert_admin on public.announcement;
create policy announcement_insert_admin
  on public.announcement for insert to authenticated
  with check (
    clinic_id = (select app_private.admin_clinic_id())
    and admin_id = (select app_private.current_admin_id())
  );

drop policy if exists announcement_update_admin on public.announcement;
create policy announcement_update_admin
  on public.announcement for update to authenticated
  using (clinic_id = (select app_private.admin_clinic_id()))
  with check (clinic_id = (select app_private.admin_clinic_id()));

drop policy if exists announcement_delete_admin on public.announcement;
create policy announcement_delete_admin
  on public.announcement for delete to authenticated
  using (clinic_id = (select app_private.admin_clinic_id()));

-- Migration 33's authors, clinic rule, triggers and comment, exactly as it
-- wrote them.
alter table public.announcement drop constraint announcement_one_author;
alter table public.announcement drop constraint announcement_clinic_follows_author;

alter table public.announcement
  add constraint announcement_one_author
    check (num_nonnulls(admin_id, super_admin_id) = 1);

alter table public.announcement
  add constraint announcement_clinic_follows_author
    check (
      (admin_id is not null and clinic_id is not null)
      or (super_admin_id is not null and clinic_id is null)
    );

create or replace function public.announcement_assign_clinic()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.admin_id is null then
    -- A platform announcement belongs to no clinic.
    new.clinic_id := null;
  else
    new.clinic_id := (select a.clinic_id from public.admin a
                       where a.admin_id = new.admin_id);
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
     or new.super_admin_id is distinct from old.super_admin_id
     or new.clinic_id is distinct from old.clinic_id then
    raise exception 'An announcement keeps the author and clinic it was written with'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;

comment on function public.announcement_guard_author() is
  'Refuses any change to an announcement''s author or clinic, a platform '
  'announcement''s included. Run only by the announcement_author_is_fixed '
  'trigger.';

drop trigger if exists announcement_author_is_fixed on public.announcement;
create trigger announcement_author_is_fixed
  before update of admin_id, super_admin_id, clinic_id on public.announcement
  for each row execute function public.announcement_guard_author();

-- Read by migration 36's policy only, which is gone now.
drop function app_private.current_assigned_doctor_id();

drop index public.announcement_doc_id_idx;
alter table public.announcement drop column doc_id;
