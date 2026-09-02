-- Up Migration
-- =====================================================================
-- Broadcasts: the CEO tells the whole team something.
--
-- Why a table rather than reusing `notifications`:
--   • notifications has no title and no priority
--   • recipient_id IS NULL already means "the admins" in the read policy,
--     so it cannot also mean "everyone" without breaking that
--   • a notification is a transient nudge; a broadcast must stay
--     retrievable afterwards, which the brief requires explicitly
--
-- The notification fan-out is still reused for the nudge, so there is no
-- second notification system. Two small tables, no queue, no broker.
-- =====================================================================

CREATE TYPE broadcast_priority AS ENUM ('Normal', 'Important', 'Urgent');

CREATE TABLE broadcasts (
    broadcast_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title        text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 140),
    message      text NOT NULL CHECK (length(trim(message)) BETWEEN 1 AND 4000),
    priority     broadcast_priority NOT NULL DEFAULT 'Normal',
    created_by   uuid NOT NULL REFERENCES employees(employee_id),
    published_at timestamptz NOT NULL DEFAULT now(),
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX broadcasts_published_idx ON broadcasts (published_at DESC);

-- One row per employee who has opened it. Absence means unread, so
-- nothing has to be written when a broadcast is created.
CREATE TABLE broadcast_reads (
    broadcast_id uuid NOT NULL REFERENCES broadcasts(broadcast_id) ON DELETE CASCADE,
    employee_id  uuid NOT NULL REFERENCES employees(employee_id) ON DELETE CASCADE,
    read_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (broadcast_id, employee_id)
);

GRANT SELECT, INSERT, UPDATE ON broadcasts TO crm_app;
GRANT SELECT, INSERT ON broadcast_reads TO crm_app;

ALTER TABLE broadcasts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcasts      FORCE ROW LEVEL SECURITY;
ALTER TABLE broadcast_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcast_reads FORCE ROW LEVEL SECURITY;

-- Every signed-in employee reads every published broadcast: that is the
-- entire point of the feature. Writing is admin-only, enforced here as
-- well as in the API, so a missed check in a future route cannot let an
-- employee publish.
CREATE POLICY broadcast_read ON broadcasts FOR SELECT
  USING (true);
CREATE POLICY broadcast_insert ON broadcasts FOR INSERT
  WITH CHECK (current_is_admin());
CREATE POLICY broadcast_update ON broadcasts FOR UPDATE
  USING (current_is_admin()) WITH CHECK (current_is_admin());

-- An employee may only ever mark their own copy as read.
CREATE POLICY broadcast_read_own ON broadcast_reads FOR SELECT
  USING (current_is_admin() OR employee_id = current_actor());
CREATE POLICY broadcast_read_mark ON broadcast_reads FOR INSERT
  WITH CHECK (employee_id = current_actor());

CREATE TRIGGER trg_audit_broadcasts AFTER INSERT OR UPDATE ON broadcasts
    FOR EACH ROW EXECUTE FUNCTION write_audit('broadcast_id');

-- An announcement that was sent cannot be unsent.
CREATE TRIGGER trg_no_delete_broadcasts BEFORE DELETE ON broadcasts
    FOR EACH ROW EXECUTE FUNCTION block_delete();

-- Down Migration
DROP TRIGGER IF EXISTS trg_no_delete_broadcasts ON broadcasts;
DROP TRIGGER IF EXISTS trg_audit_broadcasts ON broadcasts;
DROP POLICY IF EXISTS broadcast_read_mark ON broadcast_reads;
DROP POLICY IF EXISTS broadcast_read_own ON broadcast_reads;
DROP POLICY IF EXISTS broadcast_update ON broadcasts;
DROP POLICY IF EXISTS broadcast_insert ON broadcasts;
DROP POLICY IF EXISTS broadcast_read ON broadcasts;
DROP TABLE IF EXISTS broadcast_reads;
DROP TABLE IF EXISTS broadcasts;
DROP TYPE IF EXISTS broadcast_priority;
