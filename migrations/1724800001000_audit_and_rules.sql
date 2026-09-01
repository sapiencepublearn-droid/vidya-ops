-- Up Migration
-- =====================================================================
-- The previous write_audit() referenced NEW.attendance_id on every
-- table, which raises `record "new" has no field "attendance_id"` on
-- any table that lacks it. The PK column is now passed as TG_ARGV[0]
-- and read through to_jsonb(), which works for any row type.
-- =====================================================================

CREATE OR REPLACE FUNCTION write_audit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    actor uuid;
    rec   uuid;
    newj  jsonb;
    oldj  jsonb;
BEGIN
    BEGIN
        actor := nullif(current_setting('app.actor_id', true), '')::uuid;
    EXCEPTION WHEN others THEN
        actor := NULL;
    END;

    IF TG_OP = 'DELETE' THEN
        oldj := to_jsonb(OLD);
        rec  := (oldj ->> TG_ARGV[0])::uuid;
    ELSE
        newj := to_jsonb(NEW);
        rec  := (newj ->> TG_ARGV[0])::uuid;
        IF TG_OP = 'UPDATE' THEN oldj := to_jsonb(OLD); END IF;
    END IF;

    -- Never let a password hash reach the audit table.
    IF newj ? 'password_hash' THEN newj := newj - 'password_hash'; END IF;
    IF oldj ? 'password_hash' THEN oldj := oldj - 'password_hash'; END IF;

    INSERT INTO audit_log (actor_id, action, entity, record_id, before_data, after_data)
    VALUES (actor, lower(TG_OP), TG_TABLE_NAME, rec, oldj, newj);

    RETURN NULL; -- AFTER trigger, return value ignored
END $$;

CREATE TRIGGER trg_audit_attendance  AFTER INSERT OR UPDATE ON attendance
    FOR EACH ROW EXECUTE FUNCTION write_audit('attendance_id');
CREATE TRIGGER trg_audit_tasks       AFTER INSERT OR UPDATE ON tasks
    FOR EACH ROW EXECUTE FUNCTION write_audit('task_id');
CREATE TRIGGER trg_audit_submissions AFTER INSERT OR UPDATE ON work_submissions
    FOR EACH ROW EXECUTE FUNCTION write_audit('submission_id');
CREATE TRIGGER trg_audit_claims      AFTER INSERT OR UPDATE ON claims
    FOR EACH ROW EXECUTE FUNCTION write_audit('claim_id');
CREATE TRIGGER trg_audit_employees   AFTER INSERT OR UPDATE ON employees
    FOR EACH ROW EXECUTE FUNCTION write_audit('employee_id');

-- ------------------------------------------- captured evidence is frozen
CREATE OR REPLACE FUNCTION freeze_attendance_capture() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.check_in_time IS NOT NULL AND OLD.gps_purged_at IS NULL AND (
        NEW.check_in_time      IS DISTINCT FROM OLD.check_in_time      OR
        NEW.check_in_latitude  IS DISTINCT FROM OLD.check_in_latitude  OR
        NEW.check_in_longitude IS DISTINCT FROM OLD.check_in_longitude OR
        NEW.check_in_accuracy  IS DISTINCT FROM OLD.check_in_accuracy) THEN
        RAISE EXCEPTION 'check-in capture is immutable once recorded'
            USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.check_out_time IS NOT NULL AND OLD.gps_purged_at IS NULL AND (
        NEW.check_out_time      IS DISTINCT FROM OLD.check_out_time      OR
        NEW.check_out_latitude  IS DISTINCT FROM OLD.check_out_latitude  OR
        NEW.check_out_longitude IS DISTINCT FROM OLD.check_out_longitude OR
        NEW.check_out_accuracy  IS DISTINCT FROM OLD.check_out_accuracy) THEN
        RAISE EXCEPTION 'check-out capture is immutable once recorded'
            USING ERRCODE = 'check_violation';
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END $$;
CREATE TRIGGER trg_freeze_attendance BEFORE UPDATE ON attendance
    FOR EACH ROW EXECUTE FUNCTION freeze_attendance_capture();

-- Append-only tables. Tasks use soft delete instead (see DECISIONS.md),
-- so there is no longer a cascade fighting a delete guard.
CREATE OR REPLACE FUNCTION block_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'rows in % are append-only', TG_TABLE_NAME
  USING ERRCODE = 'check_violation'; END $$;

CREATE TRIGGER trg_no_delete_attendance  BEFORE DELETE ON attendance
    FOR EACH ROW EXECUTE FUNCTION block_delete();
CREATE TRIGGER trg_no_delete_submissions BEFORE DELETE ON work_submissions
    FOR EACH ROW EXECUTE FUNCTION block_delete();
CREATE TRIGGER trg_no_delete_audit       BEFORE DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION block_delete();

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
CREATE TRIGGER trg_touch_tasks     BEFORE UPDATE ON tasks     FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_touch_claims    BEFORE UPDATE ON claims    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_touch_employees BEFORE UPDATE ON employees FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ------------------------------------------------------------------ views
-- Overdue is derived at read time so it can never go stale.
CREATE VIEW v_tasks AS
SELECT t.*,
       ((t.due_date + t.due_time) AT TIME ZONE 'Asia/Kolkata') AS due_at,
       CASE
         WHEN t.status IN ('Completed','Submitted') THEN t.status::text
         WHEN ((t.due_date + t.due_time) AT TIME ZONE 'Asia/Kolkata') < now() THEN 'Overdue'
         ELSE t.status::text
       END AS effective_status,
       e.name AS assignee_name, e.employee_code, a.name AS assigner_name
FROM tasks t
JOIN employees e ON e.employee_id = t.assigned_to
JOIN employees a ON a.employee_id = t.assigned_by
WHERE t.deleted_at IS NULL;

CREATE VIEW v_today_board AS
SELECT e.employee_id, e.employee_code, e.name, e.role,
       COALESCE(at.status,'Absent')::text AS attendance_status,
       at.check_in_time, at.check_out_time,
       COUNT(t.task_id) AS tasks_assigned,
       COUNT(*) FILTER (WHERE t.effective_status = 'Completed')   AS completed,
       COUNT(*) FILTER (WHERE t.effective_status = 'In Progress') AS in_progress,
       COUNT(*) FILTER (WHERE t.effective_status = 'Submitted')   AS submitted,
       COUNT(*) FILTER (WHERE t.effective_status IN ('Not Started','Returned')) AS pending,
       COUNT(*) FILTER (WHERE t.effective_status = 'Overdue')     AS overdue
FROM employees e
LEFT JOIN attendance at ON at.employee_id = e.employee_id AND at.work_date = ist_today()
LEFT JOIN v_tasks    t  ON t.assigned_to  = e.employee_id AND t.due_date   = ist_today()
WHERE e.status = 'Active'
GROUP BY e.employee_id, e.employee_code, e.name, e.role, at.status, at.check_in_time, at.check_out_time;

-- Down Migration
DROP VIEW IF EXISTS v_today_board, v_tasks;
DROP TRIGGER IF EXISTS trg_touch_employees ON employees;
DROP TRIGGER IF EXISTS trg_touch_claims ON claims;
DROP TRIGGER IF EXISTS trg_touch_tasks ON tasks;
DROP TRIGGER IF EXISTS trg_no_delete_audit ON audit_log;
DROP TRIGGER IF EXISTS trg_no_delete_submissions ON work_submissions;
DROP TRIGGER IF EXISTS trg_no_delete_attendance ON attendance;
DROP TRIGGER IF EXISTS trg_freeze_attendance ON attendance;
DROP TRIGGER IF EXISTS trg_audit_employees ON employees;
DROP TRIGGER IF EXISTS trg_audit_claims ON claims;
DROP TRIGGER IF EXISTS trg_audit_submissions ON work_submissions;
DROP TRIGGER IF EXISTS trg_audit_tasks ON tasks;
DROP TRIGGER IF EXISTS trg_audit_attendance ON attendance;
DROP FUNCTION IF EXISTS touch_updated_at, block_delete, freeze_attendance_capture, write_audit CASCADE;
