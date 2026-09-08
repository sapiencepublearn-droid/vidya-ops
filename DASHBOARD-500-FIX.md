# Dashboard 500 Fix

The employee dashboard no longer depends on the `v_tasks` view for task reporting.
It queries `tasks` directly, explicitly casts enum statuses to text, and checks whether
`task_daily_log` exists before using historical task rows. This prevents the common
production failures caused by enum/text UNION mismatches and databases that have not
yet applied the task-history migration.

Endpoint:
GET /api/admin/employees/:id/dashboard?from=YYYY-MM-DD&to=YYYY-MM-DD
