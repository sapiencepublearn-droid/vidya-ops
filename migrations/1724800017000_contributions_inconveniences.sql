-- Employee Contributions / Inconveniences
-- Records additional work done for the company and invoices made for the company.
-- This is separate from reimbursement claims.

CREATE TABLE employee_contributions (
  contribution_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES employees(employee_id) ON DELETE RESTRICT,
  work_date date NOT NULL DEFAULT ist_today(),
  entry_type text NOT NULL CHECK (entry_type IN ('Additional Work', 'Invoice')),
  title text NOT NULL CHECK (length(trim(title)) > 0),
  description text NOT NULL CHECK (length(trim(description)) > 0),
  invoice_number text,
  amount_paise bigint CHECK (amount_paise IS NULL OR amount_paise > 0),
  status text NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Replied')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX employee_contributions_employee_date_idx
  ON employee_contributions (employee_id, work_date DESC, created_at DESC);
CREATE INDEX employee_contributions_status_idx
  ON employee_contributions (status, work_date DESC);

CREATE TABLE contribution_replies (
  reply_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contribution_id uuid NOT NULL REFERENCES employee_contributions(contribution_id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(employee_id) ON DELETE RESTRICT,
  message text NOT NULL CHECK (length(trim(message)) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX contribution_replies_contribution_idx
  ON contribution_replies (contribution_id, created_at);

ALTER TABLE employee_contributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_contributions FORCE ROW LEVEL SECURITY;
CREATE POLICY contribution_read ON employee_contributions FOR SELECT
  USING (current_is_admin() OR employee_id = current_actor());
CREATE POLICY contribution_insert ON employee_contributions FOR INSERT
  WITH CHECK (employee_id = current_actor());
CREATE POLICY contribution_update_admin ON employee_contributions FOR UPDATE
  USING (current_is_admin()) WITH CHECK (current_is_admin());

ALTER TABLE contribution_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE contribution_replies FORCE ROW LEVEL SECURITY;
CREATE POLICY contribution_reply_read ON contribution_replies FOR SELECT
  USING (current_is_admin() OR employee_id = current_actor() OR EXISTS (
    SELECT 1 FROM employee_contributions c
    WHERE c.contribution_id = contribution_replies.contribution_id
      AND c.employee_id = current_actor()
  ));
CREATE POLICY contribution_reply_insert ON contribution_replies FOR INSERT
  WITH CHECK (current_is_admin() AND employee_id = current_actor());

GRANT SELECT, INSERT, UPDATE ON employee_contributions TO crm_app;
GRANT SELECT, INSERT ON contribution_replies TO crm_app;

-- Keep testing reset complete when these records exist.
CREATE OR REPLACE FUNCTION reset_test_data()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  TRUNCATE TABLE
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
