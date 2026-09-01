-- Up Migration
-- =====================================================================
-- Defence in depth. The API already filters by owner on every query;
-- RLS makes a forgotten WHERE clause harmless instead of a data leak.
-- The API connects as crm_app (no BYPASSRLS), and sets app.actor_id +
-- app.is_admin per transaction.
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_app') THEN
    CREATE ROLE crm_app LOGIN PASSWORD 'change-me-in-deploy';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO crm_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO crm_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO crm_app;
-- Deliberately no DELETE and no DDL: the app cannot drop or truncate.
REVOKE DELETE ON ALL TABLES IN SCHEMA public FROM crm_app;

CREATE OR REPLACE FUNCTION current_actor() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.actor_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION current_is_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('app.is_admin', true), '')::boolean, false)
$$;

ALTER TABLE attendance      ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks           ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE claims          ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachments     ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE day_plans       ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications   ENABLE ROW LEVEL SECURITY;

-- Owner-or-admin read, owner-only write, on every employee-scoped table.
CREATE POLICY att_rw ON attendance
  USING (current_is_admin() OR employee_id = current_actor())
  WITH CHECK (employee_id = current_actor());

CREATE POLICY task_read ON tasks FOR SELECT
  USING (current_is_admin() OR assigned_to = current_actor());
CREATE POLICY task_write ON tasks FOR UPDATE
  USING (current_is_admin() OR assigned_to = current_actor())
  WITH CHECK (current_is_admin() OR assigned_to = current_actor());
CREATE POLICY task_insert ON tasks FOR INSERT
  WITH CHECK (current_is_admin());

CREATE POLICY sub_read ON work_submissions FOR SELECT
  USING (current_is_admin() OR employee_id = current_actor());
CREATE POLICY sub_insert ON work_submissions FOR INSERT
  WITH CHECK (employee_id = current_actor());
CREATE POLICY sub_update ON work_submissions FOR UPDATE
  USING (current_is_admin()) WITH CHECK (current_is_admin());

CREATE POLICY claim_read ON claims FOR SELECT
  USING (current_is_admin() OR employee_id = current_actor());
CREATE POLICY claim_insert ON claims FOR INSERT
  WITH CHECK (employee_id = current_actor());
CREATE POLICY claim_update ON claims FOR UPDATE
  USING (current_is_admin()) WITH CHECK (current_is_admin());

CREATE POLICY att_file ON attachments
  USING (current_is_admin() OR uploaded_by = current_actor())
  WITH CHECK (uploaded_by = current_actor());

CREATE POLICY sum_rw ON daily_summaries
  USING (current_is_admin() OR employee_id = current_actor())
  WITH CHECK (employee_id = current_actor());

CREATE POLICY plan_rw ON day_plans
  USING (current_is_admin() OR employee_id = current_actor())
  WITH CHECK (employee_id = current_actor());

CREATE POLICY notif_read ON notifications FOR SELECT
  USING (recipient_id = current_actor() OR (recipient_id IS NULL AND current_is_admin()));
CREATE POLICY notif_insert ON notifications FOR INSERT WITH CHECK (true);

-- ------------------------------------------------------- GPS retention
-- Coordinates answer "was this check-in genuine". That question is dead
-- after the payroll month closes, so the coordinates are purged at 90
-- days while the attendance fact is retained.
CREATE OR REPLACE FUNCTION purge_old_gps(retain_days integer DEFAULT 90)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
    UPDATE attendance
       SET check_in_latitude = NULL, check_in_longitude = NULL, check_in_accuracy = NULL,
           check_in_device = NULL, check_out_latitude = NULL, check_out_longitude = NULL,
           check_out_accuracy = NULL, check_out_device = NULL, gps_purged_at = now()
     WHERE work_date < ist_today() - retain_days
       AND gps_purged_at IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END $$;

-- Down Migration
DROP FUNCTION IF EXISTS purge_old_gps(integer);
DROP POLICY IF EXISTS notif_insert ON notifications;
DROP POLICY IF EXISTS notif_read ON notifications;
DROP POLICY IF EXISTS plan_rw ON day_plans;
DROP POLICY IF EXISTS sum_rw ON daily_summaries;
DROP POLICY IF EXISTS att_file ON attachments;
DROP POLICY IF EXISTS claim_update ON claims;
DROP POLICY IF EXISTS claim_insert ON claims;
DROP POLICY IF EXISTS claim_read ON claims;
DROP POLICY IF EXISTS sub_update ON work_submissions;
DROP POLICY IF EXISTS sub_insert ON work_submissions;
DROP POLICY IF EXISTS sub_read ON work_submissions;
DROP POLICY IF EXISTS task_insert ON tasks;
DROP POLICY IF EXISTS task_write ON tasks;
DROP POLICY IF EXISTS task_read ON tasks;
DROP POLICY IF EXISTS att_rw ON attendance;
DROP FUNCTION IF EXISTS current_is_admin, current_actor;
