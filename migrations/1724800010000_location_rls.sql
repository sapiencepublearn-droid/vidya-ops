-- Up Migration
-- =====================================================================
-- The API already restricts school management to admins, but `locations`
-- had no row-level security. A test that tried to insert a school
-- directly as an employee succeeded, which means the database was not
-- backing up the application check.
--
-- That matters more here than elsewhere: a fake location with a large
-- radius would let someone punch in from anywhere, which defeats the
-- whole attendance model.
--
-- Additive. No data is altered.
-- =====================================================================

ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE locations FORCE ROW LEVEL SECURITY;

-- Everyone signed in may read the directory: employees need to see the
-- school they are visiting, and matching runs on the employee's behalf.
CREATE POLICY location_read ON locations FOR SELECT USING (true);

-- Only an admin may create, move, resize or deactivate a location.
CREATE POLICY location_insert ON locations FOR INSERT
  WITH CHECK (current_is_admin());
CREATE POLICY location_update ON locations FOR UPDATE
  USING (current_is_admin()) WITH CHECK (current_is_admin());

-- Same for who may punch in where: an employee must not be able to
-- assign themselves to a school.
ALTER TABLE trainer_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE trainer_assignments FORCE ROW LEVEL SECURITY;

CREATE POLICY assignment_read ON trainer_assignments FOR SELECT
  USING (current_is_admin() OR employee_id = current_actor());
CREATE POLICY assignment_write ON trainer_assignments FOR INSERT
  WITH CHECK (current_is_admin());
CREATE POLICY assignment_update ON trainer_assignments FOR UPDATE
  USING (current_is_admin()) WITH CHECK (current_is_admin());

-- Down Migration
DROP POLICY IF EXISTS assignment_update ON trainer_assignments;
DROP POLICY IF EXISTS assignment_write ON trainer_assignments;
DROP POLICY IF EXISTS assignment_read ON trainer_assignments;
ALTER TABLE trainer_assignments NO FORCE ROW LEVEL SECURITY;
ALTER TABLE trainer_assignments DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS location_update ON locations;
DROP POLICY IF EXISTS location_insert ON locations;
DROP POLICY IF EXISTS location_read ON locations;
ALTER TABLE locations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE locations DISABLE ROW LEVEL SECURITY;
