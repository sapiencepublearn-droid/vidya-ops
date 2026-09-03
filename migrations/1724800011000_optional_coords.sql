-- Up Migration
-- =====================================================================
-- Schools can now be recorded before anyone has stood at the gate with a
-- phone. An admin knows the name, zone, address and contact long before
-- the coordinates are verified, and being unable to enter that means the
-- directory does not get filled in.
--
-- Coordinates stay NOT NULL for the office, because office matching is
-- the first step of every punch and there is exactly one office.
--
-- A school without coordinates simply cannot be matched: the server has
-- nothing to measure against. It is not a weaker check, it is an absent
-- one, and the punch is refused as "outside an approved location". The
-- employee reports it, the GPS evidence lands on the incident, and an
-- admin confirms it explicitly. Nothing is adopted silently.
--
-- Additive. No row is deleted, no existing value is altered.
-- =====================================================================

ALTER TABLE locations ALTER COLUMN latitude  DROP NOT NULL;
ALTER TABLE locations ALTER COLUMN longitude DROP NOT NULL;

-- The office must always have a position, or office-priority matching
-- silently stops working for everyone.
ALTER TABLE locations ADD CONSTRAINT chk_office_has_coords
  CHECK (kind <> 'office' OR (latitude IS NOT NULL AND longitude IS NOT NULL));

-- Half a coordinate is worse than none: it would look set but match nothing.
ALTER TABLE locations ADD CONSTRAINT chk_coords_both_or_neither
  CHECK (num_nonnulls(latitude, longitude) <> 1);

ALTER TABLE locations ADD COLUMN IF NOT EXISTS contact_person      text;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS contact_designation text;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS contact_phone       text;

ALTER TABLE locations ADD CONSTRAINT chk_contact_len CHECK (
  (contact_person      IS NULL OR length(contact_person)      <= 120) AND
  (contact_designation IS NULL OR length(contact_designation) <= 120) AND
  (contact_phone       IS NULL OR length(contact_phone)       <= 30)
);

-- Records who confirmed a location and when, so a coordinate that came
-- from a trainer's punch is always traceable to the admin who accepted it.
ALTER TABLE locations ADD COLUMN IF NOT EXISTS location_set_by uuid REFERENCES employees(employee_id);
ALTER TABLE locations ADD COLUMN IF NOT EXISTS location_set_at timestamptz;

-- Matching only ever reads locations that have a position.
CREATE INDEX IF NOT EXISTS locations_matchable_idx
  ON locations (kind) WHERE is_active AND latitude IS NOT NULL;

-- Down Migration
DROP INDEX IF EXISTS locations_matchable_idx;
ALTER TABLE locations DROP COLUMN IF EXISTS location_set_at;
ALTER TABLE locations DROP COLUMN IF EXISTS location_set_by;
ALTER TABLE locations DROP CONSTRAINT IF EXISTS chk_contact_len;
ALTER TABLE locations DROP COLUMN IF EXISTS contact_phone;
ALTER TABLE locations DROP COLUMN IF EXISTS contact_designation;
ALTER TABLE locations DROP COLUMN IF EXISTS contact_person;
ALTER TABLE locations DROP CONSTRAINT IF EXISTS chk_coords_both_or_neither;
ALTER TABLE locations DROP CONSTRAINT IF EXISTS chk_office_has_coords;
UPDATE locations SET latitude = 0 WHERE latitude IS NULL;
UPDATE locations SET longitude = 0 WHERE longitude IS NULL;
ALTER TABLE locations ALTER COLUMN latitude  SET NOT NULL;
ALTER TABLE locations ALTER COLUMN longitude SET NOT NULL;
