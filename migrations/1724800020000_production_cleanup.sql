-- Production cleanup: Contributions / Inconveniences are informational only.
-- They are not invoices, claims, reimbursements, or monetary records.
ALTER TABLE employee_contributions
  DROP COLUMN IF EXISTS invoice_number,
  DROP COLUMN IF EXISTS amount_paise;

COMMENT ON TABLE employee_contributions IS
  'Employee-reported contributions and inconveniences. No monetary or invoice fields.';

COMMENT ON COLUMN employee_contributions.entry_type IS
  'Contribution or Inconvenience.';

-- Audit the newer operational records as well. This keeps employee reports,
-- school visits, replies, and daily work edits traceable without exposing
-- passwords or changing the immutable attendance evidence.
DROP TRIGGER IF EXISTS trg_audit_school_visits ON school_visits;
CREATE TRIGGER trg_audit_school_visits
  AFTER INSERT OR UPDATE ON school_visits
  FOR EACH ROW EXECUTE FUNCTION write_audit('visit_id');

DROP TRIGGER IF EXISTS trg_audit_employee_contributions ON employee_contributions;
CREATE TRIGGER trg_audit_employee_contributions
  AFTER INSERT OR UPDATE ON employee_contributions
  FOR EACH ROW EXECUTE FUNCTION write_audit('contribution_id');

DROP TRIGGER IF EXISTS trg_audit_contribution_replies ON contribution_replies;
CREATE TRIGGER trg_audit_contribution_replies
  AFTER INSERT OR UPDATE ON contribution_replies
  FOR EACH ROW EXECUTE FUNCTION write_audit('reply_id');

DROP TRIGGER IF EXISTS trg_audit_employee_work_done ON employee_work_done;
CREATE TRIGGER trg_audit_employee_work_done
  AFTER INSERT OR UPDATE ON employee_work_done
  FOR EACH ROW EXECUTE FUNCTION write_audit('work_done_id');
