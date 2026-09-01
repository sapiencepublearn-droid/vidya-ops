#!/usr/bin/env bash
# Restores a backup into a scratch database and verifies the data is
# actually there. A backup that has never been restored is not a backup.
# Run this on a schedule, not only when something has gone wrong.
set -Eeuo pipefail

: "${ADMIN_DATABASE_URL:?ADMIN_DATABASE_URL is required}"
DUMP="${1:?usage: restore-verify.sh <dump-file> [verify-db-name]}"
VERIFY_DB="${2:-crm_restore_check}"

BASE_URL="${ADMIN_DATABASE_URL%/*}"
VERIFY_URL="${BASE_URL}/${VERIFY_DB}"

if [[ -f "${DUMP}.sha256" ]]; then
  echo "checking dump integrity"
  sha256sum --check "${DUMP}.sha256"
fi

echo "restoring into ${VERIFY_DB}"
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${VERIFY_DB}"
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${VERIFY_DB}"
pg_restore --dbname="$VERIFY_URL" --no-owner --exit-on-error "$DUMP"

echo "verifying restored contents"
psql "$VERIFY_URL" -v ON_ERROR_STOP=1 --quiet --tuples-only <<'SQL'
DO $$
DECLARE employees_n int; tasks_n int; claims_n int; audit_n int; triggers_n int;
BEGIN
    SELECT count(*) INTO employees_n FROM employees;
    SELECT count(*) INTO tasks_n     FROM tasks;
    SELECT count(*) INTO claims_n    FROM claims;
    SELECT count(*) INTO audit_n     FROM audit_log;
    SELECT count(*) INTO triggers_n  FROM pg_trigger WHERE NOT tgisinternal;

    IF employees_n = 0 THEN RAISE EXCEPTION 'restore verify failed: no employees'; END IF;
    IF triggers_n = 0 THEN RAISE EXCEPTION 'restore verify failed: triggers missing'; END IF;
    -- The business rules must survive the round trip, not just the rows.
    PERFORM ist_today();
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'claims') THEN
        RAISE EXCEPTION 'restore verify failed: RLS policies missing';
    END IF;

    RAISE NOTICE 'verified: % employees, % tasks, % claims, % audit rows, % triggers',
        employees_n, tasks_n, claims_n, audit_n, triggers_n;
END $$;
SQL

echo "restore verified. dropping scratch database"
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -c "DROP DATABASE ${VERIFY_DB}"
echo "OK: backup ${DUMP} is restorable"
