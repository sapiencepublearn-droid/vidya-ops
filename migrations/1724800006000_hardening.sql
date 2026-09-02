-- Up Migration
-- =====================================================================
-- Stage 1 hardening. Both tables are new; nothing existing is altered,
-- so no current data is touched by this migration.
-- =====================================================================

-- ------------------------------------------------------- idempotency
-- A trainer on a weak connection submits, loses the response, and taps
-- again. Without this the second tap files a second claim. The client
-- sends a key it generates once per user action; a repeat of the same
-- key returns the first result instead of doing the work twice.
CREATE TABLE idempotency_keys (
    key           text NOT NULL,
    employee_id   uuid NOT NULL REFERENCES employees(employee_id) ON DELETE CASCADE,
    endpoint      text NOT NULL,
    -- Hash of the request body. A repeated key carrying different data is
    -- a client bug, not a retry, and must not silently return the old answer.
    request_hash  text NOT NULL,
    status_code   integer,
    response_body jsonb,
    completed_at  timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (employee_id, key)
);
CREATE INDEX idempotency_created_idx ON idempotency_keys (created_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_keys TO crm_app;

-- Keys are only useful for as long as a client might retry. Old rows are
-- cleared on a schedule so the table cannot grow without bound.
CREATE OR REPLACE FUNCTION purge_idempotency_keys(retain_hours integer DEFAULT 48)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
    DELETE FROM idempotency_keys WHERE created_at < now() - make_interval(hours => retain_hours);
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END $$;

-- ------------------------------------------------ attendance incidents
-- When a genuine check-in fails, the employee needs a sanctioned way to
-- say so. Without one, the pressure produces an "admin override GPS"
-- button, which would destroy the value of the attendance evidence.
--
-- An incident is a separate record. It never edits, replaces or creates
-- an attendance row. The admin records what they decided and why; the
-- original evidence, or its absence, stands.
CREATE TYPE incident_reason AS ENUM (
    'permission_denied', 'gps_unavailable', 'poor_accuracy', 'outside_radius',
    'mock_location', 'network_unavailable', 'server_unavailable',
    'duplicate_check_in', 'other'
);
CREATE TYPE incident_state AS ENUM ('Open', 'Resolved', 'Dismissed');

CREATE TABLE attendance_incidents (
    incident_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id     uuid NOT NULL REFERENCES employees(employee_id),
    work_date       date NOT NULL DEFAULT ist_today(),
    kind            text NOT NULL CHECK (kind IN ('check_in','check_out')),
    reason          incident_reason NOT NULL,
    -- What the device reported at the time, kept as evidence of the attempt.
    reported_latitude  numeric(9,6),
    reported_longitude numeric(9,6),
    reported_accuracy  numeric(6,1),
    distance_m      integer,
    note            text CHECK (note IS NULL OR length(note) <= 1000),
    state           incident_state NOT NULL DEFAULT 'Open',
    resolved_by     uuid REFERENCES employees(employee_id),
    resolved_at     timestamptz,
    resolution      text CHECK (resolution IS NULL OR length(resolution) <= 1000),
    created_at      timestamptz NOT NULL DEFAULT now(),
    -- One open report per employee per day per kind: retrying the button
    -- should not create a queue of duplicates for the admin.
    CONSTRAINT chk_resolution CHECK (state = 'Open' OR length(trim(coalesce(resolution,''))) > 0)
);
CREATE UNIQUE INDEX attendance_incident_open_idx
    ON attendance_incidents (employee_id, work_date, kind) WHERE state = 'Open';
CREATE INDEX attendance_incident_state_idx ON attendance_incidents (state, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON attendance_incidents TO crm_app;

ALTER TABLE attendance_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_incidents FORCE ROW LEVEL SECURITY;

CREATE POLICY incident_read ON attendance_incidents FOR SELECT
  USING (current_is_admin() OR employee_id = current_actor());
CREATE POLICY incident_insert ON attendance_incidents FOR INSERT
  WITH CHECK (employee_id = current_actor());
CREATE POLICY incident_resolve ON attendance_incidents FOR UPDATE
  USING (current_is_admin()) WITH CHECK (current_is_admin());

CREATE TRIGGER trg_audit_incidents AFTER INSERT OR UPDATE ON attendance_incidents
    FOR EACH ROW EXECUTE FUNCTION write_audit('incident_id');

-- An incident is a record of what happened. It is never deleted.
CREATE TRIGGER trg_no_delete_incidents BEFORE DELETE ON attendance_incidents
    FOR EACH ROW EXECUTE FUNCTION block_delete();

-- ------------------------------------------------- audit traceability
-- So a user reporting "I got error REQ-..." can be traced to the exact
-- server event, and so a decision records why it was made.
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS request_id text;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS reason text;
CREATE INDEX IF NOT EXISTS audit_request_idx ON audit_log (request_id) WHERE request_id IS NOT NULL;

-- Down Migration
DROP INDEX IF EXISTS audit_request_idx;
ALTER TABLE audit_log DROP COLUMN IF EXISTS reason;
ALTER TABLE audit_log DROP COLUMN IF EXISTS request_id;
DROP TRIGGER IF EXISTS trg_no_delete_incidents ON attendance_incidents;
DROP TRIGGER IF EXISTS trg_audit_incidents ON attendance_incidents;
DROP POLICY IF EXISTS incident_resolve ON attendance_incidents;
DROP POLICY IF EXISTS incident_insert ON attendance_incidents;
DROP POLICY IF EXISTS incident_read ON attendance_incidents;
DROP TABLE IF EXISTS attendance_incidents;
DROP TYPE IF EXISTS incident_state, incident_reason;
DROP FUNCTION IF EXISTS purge_idempotency_keys(integer);
DROP TABLE IF EXISTS idempotency_keys;
