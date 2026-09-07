-- Step 2: weekly claim cycle.
-- Each cycle runs Saturday through Friday.
-- Sunday is a holiday; a Sunday-work claim is assigned to the following Saturday.
ALTER TABLE claims
  ADD COLUMN IF NOT EXISTS claim_cycle_start date;

CREATE INDEX IF NOT EXISTS claims_cycle_start_idx
  ON claims (claim_cycle_start);

-- Backfill only from the recorded claim date. Historical Sunday claims therefore
-- move to the following Saturday, matching the new rule. No expense data is changed.
UPDATE claims
SET claim_cycle_start = CASE
  WHEN EXTRACT(DOW FROM claim_date) = 0
    THEN claim_date + 6
  ELSE claim_date - ((EXTRACT(DOW FROM claim_date)::int + 1) % 7)
END
WHERE claim_cycle_start IS NULL;

ALTER TABLE claims
  ALTER COLUMN claim_cycle_start SET NOT NULL;

COMMENT ON COLUMN claims.claim_cycle_start IS
  'Saturday start date for the claim cycle. Sunday-work claims are assigned to the following Saturday.';
