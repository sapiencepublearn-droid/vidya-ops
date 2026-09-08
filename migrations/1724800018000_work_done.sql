-- Daily Work Done notes. Employees can add or update their own note for any
-- past/current work date; this is separate from assigned task completion.
CREATE TABLE IF NOT EXISTS employee_work_done (
  work_done_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES employees(employee_id) ON DELETE RESTRICT,
  work_date date NOT NULL,
  summary text NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 5000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, work_date)
);

CREATE INDEX IF NOT EXISTS employee_work_done_employee_date_idx
  ON employee_work_done (employee_id, work_date DESC);

ALTER TABLE employee_work_done ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_work_done FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS employee_work_done_read ON employee_work_done;
CREATE POLICY employee_work_done_read ON employee_work_done FOR SELECT
  USING (current_is_admin() OR employee_id = current_actor());
DROP POLICY IF EXISTS employee_work_done_insert ON employee_work_done;
CREATE POLICY employee_work_done_insert ON employee_work_done FOR INSERT
  WITH CHECK (employee_id = current_actor());
DROP POLICY IF EXISTS employee_work_done_update ON employee_work_done;
CREATE POLICY employee_work_done_update ON employee_work_done FOR UPDATE
  USING (current_is_admin() OR employee_id = current_actor())
  WITH CHECK (current_is_admin() OR employee_id = current_actor());

GRANT SELECT, INSERT, UPDATE ON employee_work_done TO crm_app;

-- Keep the testing reset complete when daily work-done records exist.
CREATE OR REPLACE FUNCTION reset_test_data()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  TRUNCATE TABLE
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
