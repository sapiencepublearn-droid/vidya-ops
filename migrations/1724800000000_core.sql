-- Up Migration
-- =====================================================================
-- Phase 1 core schema. Business dates are Asia/Kolkata, never the
-- server timezone, because managed Postgres defaults to UTC and a
-- 01:00 IST check-in would otherwise be filed under the previous day.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- Single source of truth for "what day is it in the office".
CREATE OR REPLACE FUNCTION ist_today() RETURNS date
LANGUAGE sql STABLE AS $$ SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date $$;

CREATE OR REPLACE FUNCTION ist_now() RETURNS timestamp
LANGUAGE sql STABLE AS $$ SELECT (now() AT TIME ZONE 'Asia/Kolkata') $$;

CREATE TYPE employee_role     AS ENUM ('Trainer','Admin','Accountant','Content Writer','Designer','CEO');
CREATE TYPE employee_state    AS ENUM ('Active','Inactive');
CREATE TYPE location_kind     AS ENUM ('office','school');
CREATE TYPE attendance_status AS ENUM ('Present','Late','Absent','Leave','Field Work');
CREATE TYPE task_priority     AS ENUM ('Low','Medium','High','Urgent');
CREATE TYPE task_status       AS ENUM ('Not Started','In Progress','Submitted','Completed','Returned');
CREATE TYPE review_status     AS ENUM ('Pending','Approved','Returned');
CREATE TYPE claim_category    AS ENUM ('Travel','Food','Stay','Others');
CREATE TYPE claim_status      AS ENUM ('Pending','Approved','Rejected');

-- ------------------------------------------------------------- locations
CREATE TABLE locations (
    location_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind          location_kind NOT NULL,
    name          text NOT NULL,
    latitude      numeric(9,6) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude     numeric(9,6) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    radius_metres integer NOT NULL DEFAULT 100 CHECK (radius_metres BETWEEN 20 AND 2000),
    is_active     boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------- employees
CREATE TABLE employees (
    employee_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_code      text UNIQUE NOT NULL,
    name               text NOT NULL CHECK (length(trim(name)) > 0),
    role               employee_role NOT NULL,
    phone              text,
    email              citext UNIQUE NOT NULL,
    password_hash      text NOT NULL,
    password_changed_at timestamptz NOT NULL DEFAULT now(),
    status             employee_state NOT NULL DEFAULT 'Active',
    is_admin           boolean NOT NULL DEFAULT false,
    office_location_id uuid REFERENCES locations(location_id),
    shift_start        time NOT NULL DEFAULT '09:00',
    late_grace_minutes integer NOT NULL DEFAULT 10 CHECK (late_grace_minutes >= 0),
    -- Reimbursement is opt-in per account, with per-employee daily caps.
    claims_enabled     boolean NOT NULL DEFAULT false,
    cap_food           integer NOT NULL DEFAULT 500  CHECK (cap_food >= 0),
    cap_stay           integer NOT NULL DEFAULT 1500 CHECK (cap_stay >= 0),
    failed_logins      integer NOT NULL DEFAULT 0,
    locked_until       timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX employees_active_idx ON employees (role) WHERE status = 'Active';

CREATE TABLE trainer_assignments (
    assignment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id   uuid NOT NULL REFERENCES employees(employee_id) ON DELETE CASCADE,
    location_id   uuid NOT NULL REFERENCES locations(location_id),
    valid_from    date NOT NULL DEFAULT ist_today(),
    valid_to      date,
    UNIQUE (employee_id, location_id, valid_from)
);

-- Token revocation list, so logout and "lost phone" actually work.
CREATE TABLE revoked_tokens (
    jti        uuid PRIMARY KEY,
    employee_id uuid NOT NULL REFERENCES employees(employee_id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX revoked_tokens_exp_idx ON revoked_tokens (expires_at);

-- ------------------------------------------------------------ attendance
CREATE TABLE attendance (
    attendance_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id           uuid NOT NULL REFERENCES employees(employee_id),
    work_date             date NOT NULL DEFAULT ist_today(),
    check_in_time         timestamptz,
    check_in_latitude     numeric(9,6),
    check_in_longitude    numeric(9,6),
    check_in_accuracy     numeric(6,1),
    check_in_location_id  uuid REFERENCES locations(location_id),
    check_in_distance_m   integer,
    check_in_device       jsonb,
    check_out_time        timestamptz,
    check_out_latitude    numeric(9,6),
    check_out_longitude   numeric(9,6),
    check_out_accuracy    numeric(6,1),
    check_out_location_id uuid REFERENCES locations(location_id),
    check_out_distance_m  integer,
    check_out_device      jsonb,
    status                attendance_status NOT NULL DEFAULT 'Absent',
    -- GPS retention: coordinates are purged after this date, the
    -- attendance fact itself is kept. See migration 3.
    gps_purged_at         timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    UNIQUE (employee_id, work_date),
    CONSTRAINT chk_out_after_in CHECK (check_out_time IS NULL OR check_in_time IS NOT NULL),
    CONSTRAINT chk_out_later    CHECK (check_out_time IS NULL OR check_out_time >= check_in_time)
);
CREATE INDEX attendance_date_idx ON attendance (work_date DESC);
CREATE INDEX attendance_emp_date_idx ON attendance (employee_id, work_date DESC);

-- ----------------------------------------------------------------- tasks
CREATE SEQUENCE task_code_seq START 1000;
CREATE OR REPLACE FUNCTION next_task_code() RETURNS text
LANGUAGE sql AS $$ SELECT 'T-' || nextval('task_code_seq') $$;

CREATE TABLE tasks (
    task_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_code    text UNIQUE NOT NULL DEFAULT next_task_code(),
    title        text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
    description  text CHECK (description IS NULL OR length(description) <= 5000),
    assigned_to  uuid NOT NULL REFERENCES employees(employee_id),
    assigned_by  uuid NOT NULL REFERENCES employees(employee_id),
    priority     task_priority NOT NULL DEFAULT 'Medium',
    due_date     date NOT NULL,
    due_time     time NOT NULL DEFAULT '18:00',
    status       task_status NOT NULL DEFAULT 'Not Started',
    started_at   timestamptz,
    submitted_at timestamptz,
    completed_at timestamptz,
    -- Soft delete. Decision recorded in docs/DECISIONS.md.
    deleted_at   timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_assignee_due_idx ON tasks (assigned_to, due_date DESC) WHERE deleted_at IS NULL;
CREATE INDEX tasks_open_idx ON tasks (due_date) WHERE deleted_at IS NULL AND status IN ('Not Started','In Progress','Returned');

CREATE TABLE work_submissions (
    submission_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id       uuid NOT NULL REFERENCES tasks(task_id) ON DELETE RESTRICT,
    employee_id   uuid NOT NULL REFERENCES employees(employee_id),
    attempt_no    integer NOT NULL DEFAULT 1 CHECK (attempt_no > 0),
    description   text NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 5000),
    remarks       text CHECK (remarks IS NULL OR length(remarks) <= 2000),
    submitted_at  timestamptz NOT NULL DEFAULT now(),
    review_status review_status NOT NULL DEFAULT 'Pending',
    reviewed_by   uuid REFERENCES employees(employee_id),
    reviewed_at   timestamptz,
    return_reason text,
    UNIQUE (task_id, attempt_no),
    CONSTRAINT chk_return_reason CHECK (review_status <> 'Returned' OR length(trim(coalesce(return_reason,''))) > 0)
);
CREATE INDEX work_submissions_pending_idx ON work_submissions (review_status) WHERE review_status = 'Pending';

-- ---------------------------------------------------------------- claims
CREATE TABLE claims (
    claim_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id   uuid NOT NULL REFERENCES employees(employee_id),
    claim_date    date NOT NULL,
    category      claim_category NOT NULL,
    amount_paise  bigint NOT NULL CHECK (amount_paise > 0 AND amount_paise <= 10000000),
    place         text CHECK (place IS NULL OR length(place) <= 200),
    location      text CHECK (location IS NULL OR length(location) <= 200),
    note          text CHECK (note IS NULL OR length(note) <= 500),
    status        claim_status NOT NULL DEFAULT 'Pending',
    reviewed_by   uuid REFERENCES employees(employee_id),
    reviewed_at   timestamptz,
    reject_reason text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_not_future CHECK (claim_date <= ist_today() + 1),
    CONSTRAINT chk_reject_reason CHECK (status <> 'Rejected' OR length(trim(coalesce(reject_reason,''))) > 0),
    CONSTRAINT chk_travel_place CHECK (category <> 'Travel' OR length(trim(coalesce(place,''))) > 0),
    CONSTRAINT chk_stay_location CHECK (category <> 'Stay' OR length(trim(coalesce(location,''))) > 0),
    CONSTRAINT chk_other_note CHECK (category <> 'Others' OR length(trim(coalesce(note,''))) > 0)
);
CREATE INDEX claims_emp_date_idx ON claims (employee_id, claim_date DESC);
CREATE INDEX claims_pending_idx ON claims (status) WHERE status = 'Pending';

-- ----------------------------------------------------------- attachments
CREATE TABLE attachments (
    attachment_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id         uuid REFERENCES tasks(task_id) ON DELETE RESTRICT,
    submission_id   uuid REFERENCES work_submissions(submission_id) ON DELETE RESTRICT,
    claim_id        uuid REFERENCES claims(claim_id) ON DELETE RESTRICT,
    uploaded_by     uuid NOT NULL REFERENCES employees(employee_id),
    file_name       text NOT NULL,
    storage_key     text NOT NULL UNIQUE,
    mime_type       text NOT NULL,
    size_bytes      bigint NOT NULL CHECK (size_bytes > 0),
    checksum_sha256 text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_owner CHECK (num_nonnulls(task_id, submission_id, claim_id) <= 1)
);
CREATE INDEX attachments_uploader_idx ON attachments (uploaded_by);

CREATE TABLE daily_summaries (
    summary_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id     uuid NOT NULL REFERENCES employees(employee_id),
    work_date       date NOT NULL DEFAULT ist_today(),
    completed_tasks integer NOT NULL DEFAULT 0,
    pending_tasks   integer NOT NULL DEFAULT 0,
    summary         text NOT NULL CHECK (length(trim(summary)) > 0),
    pending_note    text,
    blockers        text,
    support_needed  text,
    submitted_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (employee_id, work_date)
);

CREATE TABLE day_plans (
    plan_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id uuid NOT NULL REFERENCES employees(employee_id),
    plan_date   date NOT NULL DEFAULT ist_today(),
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (employee_id, plan_date)
);
CREATE TABLE day_plan_items (
    item_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id   uuid NOT NULL REFERENCES day_plans(plan_id) ON DELETE CASCADE,
    text      text NOT NULL CHECK (length(trim(text)) BETWEEN 1 AND 300),
    done      boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
    notification_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_id    uuid REFERENCES employees(employee_id) ON DELETE CASCADE,
    kind            text NOT NULL,
    body            text NOT NULL,
    task_id         uuid REFERENCES tasks(task_id) ON DELETE CASCADE,
    read_at         timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_unread_idx ON notifications (recipient_id, created_at DESC) WHERE read_at IS NULL;

CREATE TABLE audit_log (
    audit_id    bigserial PRIMARY KEY,
    actor_id    uuid REFERENCES employees(employee_id),
    action      text NOT NULL,
    entity      text NOT NULL,
    record_id   uuid NOT NULL,
    before_data jsonb,
    after_data  jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_entity_idx ON audit_log (entity, record_id, created_at DESC);
CREATE INDEX audit_created_idx ON audit_log (created_at DESC);

-- Down Migration
DROP TABLE IF EXISTS audit_log, notifications, day_plan_items, day_plans, daily_summaries,
  attachments, claims, work_submissions, tasks, attendance, revoked_tokens,
  trainer_assignments, employees, locations CASCADE;
DROP SEQUENCE IF EXISTS task_code_seq CASCADE;
DROP FUNCTION IF EXISTS next_task_code, ist_today, ist_now CASCADE;
DROP TYPE IF EXISTS claim_status, claim_category, review_status, task_status, task_priority,
  attendance_status, location_kind, employee_state, employee_role CASCADE;
