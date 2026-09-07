-- Admin tools: reclaim uploaded-file storage after exported claim cycles,
-- edit employee master data, and a guarded testing reset.
-- The reset preserves employee accounts, locations/schools and trainer
-- assignments so configuration survives while operational test data is cleared.

CREATE OR REPLACE FUNCTION reset_test_data()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  TRUNCATE TABLE
    broadcast_reads,
    broadcasts,
    notifications,
    audit_log,
    idempotency_keys,
    password_reset_tokens,
    lat_answers,
    lat_attempts,
    lat_words,
    lat_sets,
    day_plan_items,
    day_plans,
    daily_summaries,
    attendance_incidents,
    work_submissions,
    attendance,
    revoked_tokens,
    attachments,
    file_blobs,
    claims,
    claim_cycles,
    tasks
  RESTART IDENTITY CASCADE;

  RETURN jsonb_build_object(
    'resetAt', now(),
    'preserved', jsonb_build_array('employees', 'locations', 'trainer_assignments')
  );
END;
$$;

REVOKE ALL ON FUNCTION reset_test_data() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reset_test_data() TO crm_app;

-- Down Migration
DROP FUNCTION IF EXISTS reset_test_data();
