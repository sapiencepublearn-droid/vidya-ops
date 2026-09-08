-- Field attendance: Trainers and Technical Support may punch in/out from any location.
-- Trainers additionally record assigned-school visit check-in/out.
ALTER TYPE employee_role ADD VALUE IF NOT EXISTS 'Technical Support';

CREATE TABLE IF NOT EXISTS school_visits (
  visit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES employees(employee_id),
  work_date date NOT NULL DEFAULT ist_today(),
  location_id uuid NOT NULL REFERENCES locations(location_id),
  check_in_time timestamptz NOT NULL DEFAULT now(),
  check_in_latitude numeric(9,6) NOT NULL,
  check_in_longitude numeric(9,6) NOT NULL,
  check_in_accuracy numeric(6,1) NOT NULL,
  check_in_distance_m integer NOT NULL,
  check_out_time timestamptz,
  check_out_latitude numeric(9,6),
  check_out_longitude numeric(9,6),
  check_out_accuracy numeric(6,1),
  check_out_distance_m integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT school_visit_out_after_in CHECK (check_out_time IS NULL OR check_out_time >= check_in_time)
);
CREATE INDEX IF NOT EXISTS school_visits_emp_date_idx ON school_visits(employee_id, work_date DESC);
CREATE INDEX IF NOT EXISTS school_visits_location_date_idx ON school_visits(location_id, work_date DESC);

ALTER TABLE school_visits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS school_visits_rw ON school_visits;
CREATE POLICY school_visits_rw ON school_visits
  USING (current_is_admin() OR employee_id = current_actor())
  WITH CHECK (employee_id = current_actor());

COMMENT ON TABLE school_visits IS 'Trainer school visit check-in/out records. Punch in/out remains separate and is allowed anywhere for Trainers and Technical Support.';
