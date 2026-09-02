-- Up Migration
-- =====================================================================
-- Stage 2. Additive only.
--
-- The audit_log.reason and audit_log.request_id columns already exist
-- (added in migration 1724800006000) but nothing populated them. This
-- migration replaces the trigger function so they are filled in, and
-- adds the password reset table. No existing table is altered and no
-- existing row is touched.
-- =====================================================================

-- ------------------------------------------------------ password reset
-- The token is never stored. Only its SHA-256 hash is kept, so a copy of
-- the database does not hand someone a working reset link.
CREATE TABLE password_reset_tokens (
    token_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id uuid NOT NULL REFERENCES employees(employee_id) ON DELETE CASCADE,
    token_hash  text NOT NULL UNIQUE,
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    created_ip  inet
);
CREATE INDEX password_reset_lookup_idx ON password_reset_tokens (token_hash) WHERE used_at IS NULL;
CREATE INDEX password_reset_expiry_idx ON password_reset_tokens (expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON password_reset_tokens TO crm_app;

-- Housekeeping, run alongside the other purges.
CREATE OR REPLACE FUNCTION purge_reset_tokens(retain_hours integer DEFAULT 48)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
    DELETE FROM password_reset_tokens WHERE created_at < now() - make_interval(hours => retain_hours);
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END $$;

-- --------------------------------------------- audit: reason + request
-- Same function, same triggers, same table. Only the body changes, so
-- every existing audit row stays exactly as it is.
CREATE OR REPLACE FUNCTION write_audit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    actor  uuid;
    rec    uuid;
    newj   jsonb;
    oldj   jsonb;
    req    text;
    why    text;
BEGIN
    BEGIN
        actor := nullif(current_setting('app.actor_id', true), '')::uuid;
    EXCEPTION WHEN others THEN
        actor := NULL;
    END;

    -- Set per transaction by the API. Authoritative, server-generated.
    req := nullif(current_setting('app.request_id', true), '');
    why := nullif(current_setting('app.reason', true), '');

    IF TG_OP = 'DELETE' THEN
        oldj := to_jsonb(OLD);
        rec  := (oldj ->> TG_ARGV[0])::uuid;
    ELSE
        newj := to_jsonb(NEW);
        rec  := (newj ->> TG_ARGV[0])::uuid;
        IF TG_OP = 'UPDATE' THEN oldj := to_jsonb(OLD); END IF;
    END IF;

    -- A password hash must never reach the audit trail.
    IF newj ? 'password_hash' THEN newj := newj - 'password_hash'; END IF;
    IF oldj ? 'password_hash' THEN oldj := oldj - 'password_hash'; END IF;

    INSERT INTO audit_log (actor_id, action, entity, record_id, before_data, after_data, request_id, reason)
    VALUES (actor, lower(TG_OP), TG_TABLE_NAME, rec, oldj, newj, req, why);

    RETURN NULL;
END $$;

-- Down Migration
-- Restores the previous trigger body. The columns themselves belong to an
-- earlier migration and are deliberately left in place.
CREATE OR REPLACE FUNCTION write_audit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE actor uuid; rec uuid; newj jsonb; oldj jsonb;
BEGIN
    BEGIN actor := nullif(current_setting('app.actor_id', true), '')::uuid;
    EXCEPTION WHEN others THEN actor := NULL; END;
    IF TG_OP = 'DELETE' THEN
        oldj := to_jsonb(OLD); rec := (oldj ->> TG_ARGV[0])::uuid;
    ELSE
        newj := to_jsonb(NEW); rec := (newj ->> TG_ARGV[0])::uuid;
        IF TG_OP = 'UPDATE' THEN oldj := to_jsonb(OLD); END IF;
    END IF;
    IF newj ? 'password_hash' THEN newj := newj - 'password_hash'; END IF;
    IF oldj ? 'password_hash' THEN oldj := oldj - 'password_hash'; END IF;
    INSERT INTO audit_log (actor_id, action, entity, record_id, before_data, after_data)
    VALUES (actor, lower(TG_OP), TG_TABLE_NAME, rec, oldj, newj);
    RETURN NULL;
END $$;

DROP FUNCTION IF EXISTS purge_reset_tokens(integer);
DROP TABLE IF EXISTS password_reset_tokens;
