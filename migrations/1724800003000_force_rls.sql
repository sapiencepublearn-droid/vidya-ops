-- Up Migration
-- =====================================================================
-- ENABLE ROW LEVEL SECURITY does not apply to the table owner, and a
-- superuser bypasses it entirely. An API connecting as the owner
-- therefore sees every row and the policies are decorative.
--
-- FORCE makes the owner subject to policies too, so the only way to
-- read another employee's rows is to hold a connection role that has
-- BYPASSRLS. The application role (crm_app) has neither ownership nor
-- BYPASSRLS. Scheduled maintenance (purge_old_gps, backups) must run
-- as a superuser, which is intentional and documented in DECISIONS.md.
-- =====================================================================

ALTER TABLE attendance       FORCE ROW LEVEL SECURITY;
ALTER TABLE tasks            FORCE ROW LEVEL SECURITY;
ALTER TABLE work_submissions FORCE ROW LEVEL SECURITY;
ALTER TABLE claims           FORCE ROW LEVEL SECURITY;
ALTER TABLE attachments      FORCE ROW LEVEL SECURITY;
ALTER TABLE daily_summaries  FORCE ROW LEVEL SECURITY;
ALTER TABLE day_plans        FORCE ROW LEVEL SECURITY;
ALTER TABLE notifications    FORCE ROW LEVEL SECURITY;

-- Views run with the privileges of their owner by default, which would
-- re-open the hole. security_invoker makes v_tasks respect the caller's
-- policies instead of the view owner's.
ALTER VIEW v_tasks SET (security_invoker = true);
ALTER VIEW v_today_board SET (security_invoker = true);

-- Down Migration
ALTER VIEW v_today_board SET (security_invoker = false);
ALTER VIEW v_tasks SET (security_invoker = false);
ALTER TABLE notifications    NO FORCE ROW LEVEL SECURITY;
ALTER TABLE day_plans        NO FORCE ROW LEVEL SECURITY;
ALTER TABLE daily_summaries  NO FORCE ROW LEVEL SECURITY;
ALTER TABLE attachments      NO FORCE ROW LEVEL SECURITY;
ALTER TABLE claims           NO FORCE ROW LEVEL SECURITY;
ALTER TABLE work_submissions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE tasks            NO FORCE ROW LEVEL SECURITY;
ALTER TABLE attendance       NO FORCE ROW LEVEL SECURITY;
