-- Allow School Master zone to remain blank until Admin enters it.
-- LOCATION from Excel is an address, not a zone.
ALTER TABLE locations DROP CONSTRAINT IF EXISTS chk_school_zone;

-- Clear placeholder/imported zones once. Future manual edits are preserved.
UPDATE locations SET zone = NULL WHERE kind = 'school';

-- Permit permanent deletion only when the school has no operational records.
-- This lets an Admin remove a bad Excel import and upload it again, while
-- protecting attendance, school visits and assignment history.
DROP TRIGGER IF EXISTS trg_no_delete_locations ON locations;
CREATE OR REPLACE FUNCTION block_delete_locations() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.kind = 'school' THEN
    IF EXISTS (SELECT 1 FROM attendance WHERE check_in_location_id=OLD.location_id OR check_out_location_id=OLD.location_id)
       OR EXISTS (SELECT 1 FROM school_visits WHERE location_id=OLD.location_id)
       OR EXISTS (SELECT 1 FROM trainer_assignments WHERE location_id=OLD.location_id) THEN
      RAISE EXCEPTION 'school_has_history' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'location_delete_blocked' USING ERRCODE='23514';
END; $$;

CREATE TRIGGER trg_no_delete_locations BEFORE DELETE ON locations
  FOR EACH ROW EXECUTE FUNCTION block_delete_locations();

COMMENT ON COLUMN locations.zone IS 'Optional admin-entered zone. Excel school LOCATION is stored in address, not zone.';
