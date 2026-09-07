-- Step 1: classify each new claim as Local or Outstation.
-- Existing claims are left NULL because their original expense type is unknown.
-- The API requires the field for every new claim.
ALTER TABLE claims
  ADD COLUMN IF NOT EXISTS expense_type text;

ALTER TABLE claims
  ADD CONSTRAINT claims_expense_type_check
  CHECK (expense_type IS NULL OR expense_type IN ('Local', 'Outstation'));

CREATE INDEX IF NOT EXISTS claims_expense_type_idx
  ON claims (expense_type);
