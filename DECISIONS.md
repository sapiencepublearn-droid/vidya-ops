# Phase 1 decisions

Recorded so the next person does not have to reverse-engineer intent.

## Task deletion: soft delete (Option C)

`ON DELETE CASCADE` from tasks to submissions fought the append-only
guard on submissions, so deleting a task raised an exception instead of
cascading. Resolved by removing deletion from the model entirely:

- `tasks.deleted_at` is set instead of removing the row.
- `v_tasks` filters `deleted_at IS NULL`, so deleted tasks vanish from
  every read path automatically.
- `work_submissions.task_id` is `ON DELETE RESTRICT`.
- The app role has no `DELETE` privilege at all.

Rationale: submissions and their audit trail are evidence of work done.
Losing them because a task was tidied up is worse than carrying a few
dead rows for five employees.

## Row-level security: enabled and FORCED

`ENABLE ROW LEVEL SECURITY` alone does nothing to the table owner, and a
superuser bypasses it entirely. An API connecting as the owner would see
every row while appearing to be protected. Both parts are therefore
required:

1. `FORCE ROW LEVEL SECURITY` on every employee-scoped table.
2. The API connects as `crm_app`, which owns nothing and has no
   `BYPASSRLS`. Migrations and backups use a separate owner URL.

Views are `security_invoker = true`, otherwise `v_tasks` would run with
its owner's rights and re-open the hole.

**Consequence to remember:** any query touching an RLS table must run
inside `tx(user, ...)` so `app.actor_id` is set. A bare `pool.query()`
sees a NULL actor and returns nothing — this already caused one bug
where an employee could not read their own uploaded file.

Scheduled maintenance (`purge_old_gps`) must run as a superuser, because
FORCE applies to the owner too.

## Money stored as integer paise

`amount_paise bigint`. Floating point and currency do not mix, and a
₹0.01 rounding drift in a reimbursement system is an argument with an
accountant. The API accepts rupees and converts at the boundary.

## Claim caps are daily totals, enforced with an advisory lock

The cap is per employee, per day, per category — not per bill. Two ₹300
food bills must not both pass a ₹500 cap.

Row locking cannot be used: on the first claim of a day there are no rows
to lock, which is exactly when two parallel requests would both read
"nothing claimed yet". A transaction-scoped advisory lock keyed on
`employee:date:category` covers the empty case and releases on commit or
rollback.

`SELECT SUM(...) FOR UPDATE` is not valid PostgreSQL and was the original
bug here.

## Business dates are Asia/Kolkata, never the server timezone

Managed Postgres defaults to UTC. `CURRENT_DATE` there is wrong for
Indian business hours between 00:00 and 05:30 IST, which would file a
late-night check-in under the previous day and let someone check in twice
in one real day. All business dates use `ist_today()`.

Timestamps remain `timestamptz` (absolute instants). Only the *date* is
localised, which is the correct split.

## Denials return 404, not 403, once RLS has filtered the row

RLS removes other people's rows before the handler runs, so the handler
genuinely cannot tell "does not exist" from "not yours". Returning 404
for both is the stronger answer: the API cannot be used to probe which
record IDs exist. Where the handler does know (task assigned to someone
else, fetched as admin), it returns 403.

## Tokens in memory, not localStorage

The client holds the JWT in a closure. localStorage is readable by any
XSS on the page, and this app has no cross-tab requirement that would
justify the exposure. The cost is re-login on refresh, which is
acceptable for a 5-person internal tool.

Logout is real: the `jti` goes into `revoked_tokens` and is checked on
every request.

## Backups: nightly full logical dump

Five employees means the whole database is measured in megabytes.
`pg_dump -Fc` nightly restores in seconds and is far harder to get wrong
than PITR. Revisit if the database passes a few GB.

`scripts/restore-verify.sh` restores into a scratch database and asserts
rows, triggers and policies survived. Schedule it — an untested backup
is not a backup.

## GPS retention: 90 days

Coordinates answer one question: was this check-in genuine. That question
is dead once the payroll month has closed and any dispute window has
passed. `purge_old_gps()` nulls the coordinates at 90 days and keeps the
attendance fact. The immutability trigger explicitly permits this one
transition via `gps_purged_at`.

## Deliberately not built

No Redis, no queues, no read replicas, no microservices. Five employees
generate a few hundred requests a day. Correct indexes and pagination
are enough, and every additional moving part is another thing to
operate.
