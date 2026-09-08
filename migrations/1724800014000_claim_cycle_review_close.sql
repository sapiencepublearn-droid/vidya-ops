-- Step 4: weekly claim-cycle review and close workflow.
-- No per-claim Approved/Rejected workflow. The accountant reviews a whole
-- Saturday-Friday cycle, then closes it. Closed cycles are read-only.
CREATE TABLE IF NOT EXISTS claim_cycles (
    cycle_start date PRIMARY KEY,
    status text NOT NULL DEFAULT 'Open'
      CHECK (status IN ('Open', 'Reviewed', 'Closed')),
    reviewed_by uuid REFERENCES employees(employee_id),
    reviewed_at timestamptz,
    closed_by uuid REFERENCES employees(employee_id),
    closed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Existing claim cycles become Open and can be reviewed normally.
INSERT INTO claim_cycles (cycle_start)
SELECT DISTINCT claim_cycle_start
FROM claims
WHERE claim_cycle_start IS NOT NULL
ON CONFLICT (cycle_start) DO NOTHING;

CREATE INDEX IF NOT EXISTS claim_cycles_status_idx
  ON claim_cycles (status);

-- Keep the timestamp current for explicit workflow transitions.
CREATE OR REPLACE FUNCTION touch_claim_cycles_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS claim_cycles_updated_at ON claim_cycles;
CREATE TRIGGER claim_cycles_updated_at
BEFORE UPDATE ON claim_cycles
FOR EACH ROW EXECUTE FUNCTION touch_claim_cycles_updated_at();
