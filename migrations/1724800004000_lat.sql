-- Up Migration
-- =====================================================================
-- LAT (Learning And Teaching): the CEO publishes a set of words each
-- day, everyone reads them, then takes a spelling test. The mark is
-- calculated by the server, never by the client, and the correct
-- spellings are never sent to a device that has an open attempt.
-- =====================================================================

CREATE TABLE lat_sets (
    set_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    set_date     date NOT NULL UNIQUE DEFAULT ist_today(),
    created_by   uuid NOT NULL REFERENCES employees(employee_id),
    published_at timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lat_sets_date_idx ON lat_sets (set_date DESC);

CREATE TABLE lat_words (
    word_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    set_id   uuid NOT NULL REFERENCES lat_sets(set_id) ON DELETE CASCADE,
    position integer NOT NULL CHECK (position BETWEEN 1 AND 50),
    word     text NOT NULL CHECK (length(trim(word)) BETWEEN 1 AND 60),
    meaning  text NOT NULL CHECK (length(trim(meaning)) BETWEEN 1 AND 300),
    example  text CHECK (example IS NULL OR length(example) <= 300),
    UNIQUE (set_id, position)
);

CREATE TABLE lat_attempts (
    attempt_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    set_id       uuid NOT NULL REFERENCES lat_sets(set_id) ON DELETE CASCADE,
    employee_id  uuid NOT NULL REFERENCES employees(employee_id),
    started_at   timestamptz NOT NULL DEFAULT now(),
    submitted_at timestamptz,
    score        integer CHECK (score IS NULL OR score >= 0),
    total        integer CHECK (total IS NULL OR total > 0),
    -- One attempt per person per day. No retaking for a better mark.
    UNIQUE (set_id, employee_id),
    CONSTRAINT chk_scored CHECK ((submitted_at IS NULL) = (score IS NULL))
);
CREATE INDEX lat_attempts_emp_idx ON lat_attempts (employee_id, started_at DESC);

CREATE TABLE lat_answers (
    answer_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    attempt_id uuid NOT NULL REFERENCES lat_attempts(attempt_id) ON DELETE CASCADE,
    word_id    uuid NOT NULL REFERENCES lat_words(word_id),
    given      text NOT NULL,
    is_correct boolean NOT NULL,
    UNIQUE (attempt_id, word_id)
);

-- A submitted attempt is a record of what someone knew on a given day.
CREATE OR REPLACE FUNCTION freeze_submitted_attempt() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.submitted_at IS NOT NULL THEN
        RAISE EXCEPTION 'a submitted attempt cannot be changed'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER trg_freeze_attempt BEFORE UPDATE ON lat_attempts
    FOR EACH ROW EXECUTE FUNCTION freeze_submitted_attempt();

CREATE TRIGGER trg_no_delete_attempts BEFORE DELETE ON lat_attempts
    FOR EACH ROW EXECUTE FUNCTION block_delete();

CREATE TRIGGER trg_audit_lat_attempts AFTER INSERT OR UPDATE ON lat_attempts
    FOR EACH ROW EXECUTE FUNCTION write_audit('attempt_id');
CREATE TRIGGER trg_audit_lat_sets AFTER INSERT OR UPDATE ON lat_sets
    FOR EACH ROW EXECUTE FUNCTION write_audit('set_id');

-- ------------------------------------------------------------------ RLS
ALTER TABLE lat_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE lat_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE lat_answers  ENABLE ROW LEVEL SECURITY;
ALTER TABLE lat_answers  FORCE ROW LEVEL SECURITY;

CREATE POLICY lat_attempt_read ON lat_attempts FOR SELECT
  USING (current_is_admin() OR employee_id = current_actor());
CREATE POLICY lat_attempt_insert ON lat_attempts FOR INSERT
  WITH CHECK (employee_id = current_actor());
CREATE POLICY lat_attempt_update ON lat_attempts FOR UPDATE
  USING (employee_id = current_actor()) WITH CHECK (employee_id = current_actor());

CREATE POLICY lat_answer_read ON lat_answers FOR SELECT
  USING (current_is_admin() OR EXISTS (
    SELECT 1 FROM lat_attempts a WHERE a.attempt_id = lat_answers.attempt_id
       AND a.employee_id = current_actor()));
CREATE POLICY lat_answer_insert ON lat_answers FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM lat_attempts a WHERE a.attempt_id = lat_answers.attempt_id
       AND a.employee_id = current_actor()));

-- Sets and words are readable by everyone once published; only the API
-- decides whether the spelling is included in a response.
GRANT SELECT, INSERT, UPDATE ON lat_sets, lat_words, lat_attempts, lat_answers TO crm_app;

/**
 * Normalises an answer before comparison. Case and stray spacing are not
 * what the test is measuring; spelling is.
 */
CREATE OR REPLACE FUNCTION lat_normalise(t text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(regexp_replace(btrim(coalesce(t,'')), '\s+', ' ', 'g'))
$$;

-- Down Migration
DROP FUNCTION IF EXISTS lat_normalise(text);
DROP POLICY IF EXISTS lat_answer_insert ON lat_answers;
DROP POLICY IF EXISTS lat_answer_read ON lat_answers;
DROP POLICY IF EXISTS lat_attempt_update ON lat_attempts;
DROP POLICY IF EXISTS lat_attempt_insert ON lat_attempts;
DROP POLICY IF EXISTS lat_attempt_read ON lat_attempts;
DROP TRIGGER IF EXISTS trg_audit_lat_sets ON lat_sets;
DROP TRIGGER IF EXISTS trg_audit_lat_attempts ON lat_attempts;
DROP TRIGGER IF EXISTS trg_no_delete_attempts ON lat_attempts;
DROP TRIGGER IF EXISTS trg_freeze_attempt ON lat_attempts;
DROP FUNCTION IF EXISTS freeze_submitted_attempt();
DROP TABLE IF EXISTS lat_answers, lat_attempts, lat_words, lat_sets CASCADE;
