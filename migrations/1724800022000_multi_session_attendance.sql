-- Multiple attendance sessions per business day.
-- A day remains one reporting bucket; each Punch In/End Day pair is a session.
ALTER TABLE attendance DROP CONSTRAINT IF EXISTS attendance_employee_id_work_date_key;

CREATE INDEX IF NOT EXISTS attendance_open_session_idx
  ON attendance (employee_id, work_date, check_in_time)
  WHERE check_in_time IS NOT NULL AND check_out_time IS NULL;

-- Exactly one active session at a time; closed sessions may repeat on the same day.
CREATE UNIQUE INDEX IF NOT EXISTS attendance_one_open_session_idx
  ON attendance (employee_id, work_date)
  WHERE check_in_time IS NOT NULL AND check_out_time IS NULL;

-- Keep the daily admin board useful after attendance becomes session-based.
DROP VIEW IF EXISTS v_today_board;
CREATE VIEW v_today_board AS
SELECT e.employee_id, e.employee_code, e.name, e.role,
       COALESCE((SELECT a.status FROM attendance a
                 WHERE a.employee_id=e.employee_id AND a.work_date=ist_today()
                 ORDER BY a.check_in_time DESC LIMIT 1), 'Absent')::text AS attendance_status,
       (SELECT a.check_in_time FROM attendance a
        WHERE a.employee_id=e.employee_id AND a.work_date=ist_today()
        ORDER BY a.check_in_time ASC LIMIT 1) AS check_in_time,
       (SELECT a.check_out_time FROM attendance a
        WHERE a.employee_id=e.employee_id AND a.work_date=ist_today()
        ORDER BY a.check_in_time DESC LIMIT 1) AS check_out_time,
       (SELECT COUNT(*) FROM attendance a
        WHERE a.employee_id=e.employee_id AND a.work_date=ist_today()) AS attendance_sessions,
       (SELECT COUNT(*) FROM attendance a
        WHERE a.employee_id=e.employee_id AND a.work_date=ist_today()
          AND a.check_out_time IS NULL AND a.check_in_time IS NOT NULL) AS open_sessions,
       COUNT(t.task_id) AS tasks_assigned,
       COUNT(*) FILTER (WHERE t.effective_status = 'Completed') AS completed,
       COUNT(*) FILTER (WHERE t.effective_status = 'In Progress') AS in_progress,
       COUNT(*) FILTER (WHERE t.effective_status = 'Submitted') AS submitted,
       COUNT(*) FILTER (WHERE t.effective_status IN ('Not Started','Returned')) AS pending,
       COUNT(*) FILTER (WHERE t.effective_status = 'Overdue') AS overdue
FROM employees e
LEFT JOIN v_tasks t ON t.assigned_to=e.employee_id AND t.due_date=ist_today()
WHERE e.status='Active'
GROUP BY e.employee_id, e.employee_code, e.name, e.role;
