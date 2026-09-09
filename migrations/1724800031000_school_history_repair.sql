-- Repair historical school imports without deleting or rewriting attendance.
-- This migration only normalizes school directory metadata/history that was
-- previously parsed incorrectly from the supplied Excel template.

-- Excel LOCATION is the School Master address. Keep the historical field too,
-- but populate Address where it is currently empty.
UPDATE locations
SET address = NULLIF(trim(school_history->>'location'), '')
WHERE kind = 'school'
  AND (address IS NULL OR trim(address) = '')
  AND school_history IS NOT NULL
  AND NULLIF(trim(school_history->>'location'), '') IS NOT NULL;

-- Older imports could accidentally put the next labelled field (for example
-- CATEGORY: A) into a blank VINTAGE/BOOKS field. Repair only that exact shape.
UPDATE locations
SET school_history = jsonb_set(school_history, '{vintage}', 'null'::jsonb, true)
WHERE kind = 'school'
  AND school_history IS NOT NULL
  AND coalesce(school_history->>'vintage','') ~* '^ *CATEGORY *[:：]';

UPDATE locations
SET school_history = jsonb_set(school_history, '{books}', 'null'::jsonb, true)
WHERE kind = 'school'
  AND school_history IS NOT NULL
  AND coalesce(school_history->>'books','') ~* '^ *CATEGORY *[:：]';

UPDATE locations
SET school_history = jsonb_set(
  school_history,
  '{category}',
  to_jsonb(regexp_replace(school_history->>'category', '^ *CATEGORY *[:：] *', '', 'i')),
  true)
WHERE kind = 'school'
  AND school_history IS NOT NULL
  AND coalesce(school_history->>'category','') ~* '^ *CATEGORY *[:：]';

-- The supplied template has legacy comment labels that are one cycle ahead:
-- ATU 1 is followed by "ATU 2 COMMENTS" and SIM 1 by "SIM 2 COMMENTS".
-- Move those comments only when the first service has a value, its comment is
-- empty, and the second service/comment is empty. This is conservative and
-- preserves intentionally populated later-cycle data.
UPDATE locations
SET school_history = jsonb_set(
  jsonb_set(
    school_history,
    '{services,atu1Comments}',
    to_jsonb(school_history #>> '{services,atu2Comments}'),
    true),
  '{services,atu2Comments}', 'null'::jsonb, true)
WHERE kind = 'school'
  AND school_history IS NOT NULL
  AND NULLIF(trim(school_history #>> '{services,atu1}'),'') IS NOT NULL
  AND NULLIF(trim(school_history #>> '{services,atu1Comments}'),'') IS NULL
  AND NULLIF(trim(school_history #>> '{services,atu2Comments}'),'') IS NOT NULL
  AND NULLIF(trim(school_history #>> '{services,atu2}'),'') IS NULL;

UPDATE locations
SET school_history = jsonb_set(
  jsonb_set(
    school_history,
    '{services,sim1Comments}',
    to_jsonb(school_history #>> '{services,sim2Comments}'),
    true),
  '{services,sim2Comments}', 'null'::jsonb, true)
WHERE kind = 'school'
  AND school_history IS NOT NULL
  AND NULLIF(trim(school_history #>> '{services,sim1}'),'') IS NOT NULL
  AND NULLIF(trim(school_history #>> '{services,sim1Comments}'),'') IS NULL
  AND NULLIF(trim(school_history #>> '{services,sim2Comments}'),'') IS NOT NULL
  AND NULLIF(trim(school_history #>> '{services,sim2}'),'') IS NULL;

-- Zone is intentionally admin-entered and may remain blank.
ALTER TABLE locations DROP CONSTRAINT IF EXISTS chk_school_zone;
UPDATE locations SET zone = NULL WHERE kind = 'school' AND (zone = 'Unassigned' OR trim(zone) = '');
