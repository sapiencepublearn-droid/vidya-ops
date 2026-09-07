-- Contributions / Inconveniences are informational employee reports, not invoices or reimbursement claims.
UPDATE employee_contributions
SET entry_type='Contribution', invoice_number=NULL, amount_paise=NULL
WHERE entry_type='Invoice';

ALTER TABLE employee_contributions
  DROP CONSTRAINT IF EXISTS employee_contributions_entry_type_check;
ALTER TABLE employee_contributions
  ADD CONSTRAINT employee_contributions_entry_type_check
  CHECK (entry_type IN ('Contribution', 'Inconvenience'));

-- Legacy invoice fields are retained physically for migration compatibility but are no longer used by the API.
