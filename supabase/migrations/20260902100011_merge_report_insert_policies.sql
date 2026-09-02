-- ===========================================================================
-- RecoverEase — 12. Merge the two report INSERT policies
-- ===========================================================================
-- Raised by the live performance advisor (multiple_permissive_policies).
-- `report` carried two permissive INSERT policies for `authenticated`, so
-- PostgreSQL evaluated both on every insert.
--
-- The two branches are mutually exclusive by report_type, so an OR inside a
-- single policy is exactly equivalent and evaluated once.
--
-- Nothing is widened: `user_id = auth.uid()` still applies to both branches,
-- a doctor can still only file a patient_recovery report for their own
-- patient, and an administrator can still only file a system_wide one.
-- ===========================================================================

drop policy report_insert_doctor on public.report;
drop policy report_insert_admin  on public.report;

create policy report_insert
  on public.report for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and (
      (
        report_type = 'patient_recovery'
        and (select app_private.is_my_patient(pat_id))
      )
      or (
        report_type = 'system_wide'
        and (select app_private.is_admin())
      )
    )
  );
