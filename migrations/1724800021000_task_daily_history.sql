-- Preserve the day-by-day work history when unfinished tasks are carried
-- forward. The task's current due_date can move; this immutable daily log
-- keeps the original day's outcome for reporting and audit.
CREATE TABLE task_daily_log (
  log_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
  employee_id uuid NOT NULL REFERENCES employees(employee_id) ON DELETE RESTRICT,
  work_date date NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('Pending', 'Completed')),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, work_date)
);

CREATE INDEX task_daily_log_employee_date_idx
  ON task_daily_log (employee_id, work_date DESC);

ALTER TABLE task_daily_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_daily_log FORCE ROW LEVEL SECURITY;
CREATE POLICY task_daily_log_read ON task_daily_log FOR SELECT
  USING (current_is_admin() OR employee_id = current_actor());
CREATE POLICY task_daily_log_insert ON task_daily_log FOR INSERT
  WITH CHECK (current_is_admin() OR employee_id = current_actor());
GRANT SELECT, INSERT ON task_daily_log TO crm_app;

DROP TRIGGER IF EXISTS trg_audit_task_daily_log ON task_daily_log;
CREATE TRIGGER trg_audit_task_daily_log
  AFTER INSERT OR UPDATE ON task_daily_log
  FOR EACH ROW EXECUTE FUNCTION write_audit('log_id');

-- Keep the testing reset complete.
CREATE OR REPLACE FUNCTION reset_test_data()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  TRUNCATE TABLE
    task_daily_log,
    employee_work_done,
    contribution_replies,
    employee_contributions,
    broadcast_reads,
    broadcasts,
    notifications,
    audit_log,
    idempotency_keys,
    password_reset_tokens,
    lat_answers,
    lat_attempts,
    lat_words,
    lat_sets,
    day_plan_items,
    day_plans,
    daily_summaries,
    attendance_incidents,
    work_submissions,
    attendance,
    revoked_tokens,
    attachments,
    file_blobs,
    claims,
    claim_cycles,
    tasks
  RESTART IDENTITY CASCADE;

  RETURN jsonb_build_object(
    'resetAt', now(),
    'preserved', jsonb_build_array('employees', 'locations', 'trainer_assignments')
  );
END;
$$;

REVOKE ALL ON FUNCTION reset_test_data() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reset_test_data() TO crm_app;

-- Keep the admin Today board historically accurate after pending work is
-- carried to tomorrow.
CREATE OR REPLACE VIEW v_today_board AS
WITH today_tasks AS (
  SELECT l.employee_id, l.task_id, l.outcome AS effective_status
    FROM task_daily_log l
   WHERE l.work_date = ist_today()
  UNION ALL
  SELECT t.assigned_to, t.task_id, t.effective_status
    FROM v_tasks t
   WHERE t.due_date = ist_today()
     AND NOT EXISTS (
       SELECT 1 FROM task_daily_log l
        WHERE l.task_id=t.task_id AND l.work_date=t.due_date
     )
)
SELECT e.employee_id, e.employee_code, e.name, e.role,
       COALESCE(at.status,'Absent')::text AS attendance_status,
       at.check_in_time, at.check_out_time,
       COUNT(tt.task_id) AS tasks_assigned,
       COUNT(*) FILTER (WHERE tt.effective_status = 'Completed') AS completed,
       COUNT(*) FILTER (WHERE tt.effective_status = 'In Progress') AS in_progress,
       COUNT(*) FILTER (WHERE tt.effective_status = 'Submitted') AS submitted,
       COUNT(*) FILTER (WHERE tt.effective_status IN ('Not Started','Returned','Pending')) AS pending,
       COUNT(*) FILTER (WHERE tt.effective_status = 'Overdue') AS overdue
  FROM employees e
  LEFT JOIN attendance at
    ON at.employee_id=e.employee_id AND at.work_date=ist_today()
  LEFT JOIN today_tasks tt ON tt.employee_id=e.employee_id
 WHERE e.status='Active'
 GROUP BY e.employee_id, e.employee_code, e.name, e.role,
          at.status, at.check_in_time, at.check_out_time;
