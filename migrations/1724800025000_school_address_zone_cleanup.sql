-- School address/zone cleanup
--
-- Excel school-history files use LOCATION for the school's address/locality.
-- Zone is an internal field that admins will enter manually, so it is optional.

ALTER TABLE locations DROP CONSTRAINT IF EXISTS chk_school_zone;

-- Repair schools already imported by the earlier importer: copy the history
-- LOCATION into the canonical School Master address when address is empty,
-- then clear the incorrectly populated zone. Existing non-empty addresses are
-- preserved for safety.
UPDATE locations
   SET address = COALESCE(NULLIF(trim(address), ''), NULLIF(trim(school_history->>'location'), '')),
       zone = NULL
 WHERE kind = 'school';

-- Down Migration
-- Restore the old invariant safely. Any blank zone gets the old placeholder.
UPDATE locations SET zone = 'Unassigned' WHERE kind = 'school' AND zone IS NULL;
ALTER TABLE locations ADD CONSTRAINT chk_school_zone
  CHECK (kind <> 'school' OR zone IS NOT NULL);
