-- School history fields follow the supplied 2025-2026 School History workbook.
ALTER TABLE locations ADD COLUMN IF NOT EXISTS school_history jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS attendance_reminder_runs (
  run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reminder_date date NOT NULL,
  reminder_type text NOT NULL CHECK (reminder_type IN ('check_in','check_out')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reminder_date, reminder_type)
);

GRANT SELECT, INSERT ON attendance_reminder_runs TO crm_app;
ALTER TABLE attendance_reminder_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_reminder_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY attendance_reminder_runs_admin ON attendance_reminder_runs FOR SELECT USING (current_is_admin());
CREATE POLICY attendance_reminder_runs_insert ON attendance_reminder_runs FOR INSERT WITH CHECK (current_is_admin());
