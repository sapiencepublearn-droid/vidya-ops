-- Admin Support is a field role: punch in/out from any location.
-- It is distinct from Admin, which remains the management role.
ALTER TYPE employee_role ADD VALUE IF NOT EXISTS 'Admin Support';
