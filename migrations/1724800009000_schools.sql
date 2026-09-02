-- Up Migration
-- =====================================================================
-- School directory support.
--
-- The existing `locations` table already holds kind, name, latitude,
-- longitude, radius_metres and is_active, and `attendance` already
-- references it through check_in_location_id / check_out_location_id.
-- So there is no second schools table: this migration only adds the
-- fields that were genuinely missing.
--
-- Additive only. No column is dropped or retyped, no row is touched.
-- =====================================================================

ALTER TABLE locations ADD COLUMN IF NOT EXISTS zone       text;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS address    text;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE locations ADD CONSTRAINT chk_zone_len
  CHECK (zone IS NULL OR length(trim(zone)) BETWEEN 1 AND 80);
ALTER TABLE locations ADD CONSTRAINT chk_address_len
  CHECK (address IS NULL OR length(address) <= 400);

-- Backfill BEFORE the constraint: existing school rows predate the zone
-- column, and adding the constraint first would fail against real data.
-- 'Unassigned' is a placeholder the admin must correct, which is better
-- than blocking the migration or inventing a zone.
UPDATE locations SET zone = 'Unassigned' WHERE kind = 'school' AND zone IS NULL;

-- A zone only means something for a school; the office does not need one.
ALTER TABLE locations ADD CONSTRAINT chk_school_zone
  CHECK (kind <> 'school' OR zone IS NOT NULL);

-- Two active locations of the same kind should not share a name, or an
-- admin cannot tell them apart in a list of 140 schools.
CREATE UNIQUE INDEX IF NOT EXISTS locations_active_name_idx
  ON locations (kind, lower(trim(name))) WHERE is_active;

-- Matching reads active locations on every punch. At ~140 schools this
-- keeps it to an index scan rather than a full table read.
CREATE INDEX IF NOT EXISTS locations_active_kind_idx ON locations (kind) WHERE is_active;
CREATE INDEX IF NOT EXISTS locations_zone_idx ON locations (zone) WHERE is_active AND kind = 'school';

CREATE TRIGGER trg_touch_locations BEFORE UPDATE ON locations
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Admin changes to a school are auditable through the existing system.
CREATE TRIGGER trg_audit_locations AFTER INSERT OR UPDATE ON locations
    FOR EACH ROW EXECUTE FUNCTION write_audit('location_id');

-- Deactivate, never delete: historical attendance references these rows.
CREATE TRIGGER trg_no_delete_locations BEFORE DELETE ON locations
    FOR EACH ROW EXECUTE FUNCTION block_delete();

GRANT SELECT, INSERT, UPDATE ON locations TO crm_app;

-- Down Migration
DROP TRIGGER IF EXISTS trg_no_delete_locations ON locations;
DROP TRIGGER IF EXISTS trg_audit_locations ON locations;
DROP TRIGGER IF EXISTS trg_touch_locations ON locations;
DROP INDEX IF EXISTS locations_zone_idx;
DROP INDEX IF EXISTS locations_active_kind_idx;
DROP INDEX IF EXISTS locations_active_name_idx;
ALTER TABLE locations DROP CONSTRAINT IF EXISTS chk_school_zone;
ALTER TABLE locations DROP CONSTRAINT IF EXISTS chk_address_len;
ALTER TABLE locations DROP CONSTRAINT IF EXISTS chk_zone_len;
ALTER TABLE locations DROP COLUMN IF EXISTS updated_at;
ALTER TABLE locations DROP COLUMN IF EXISTS address;
ALTER TABLE locations DROP COLUMN IF EXISTS zone;
