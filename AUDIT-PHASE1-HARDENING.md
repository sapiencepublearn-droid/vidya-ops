# Sapience Team — Audit & Risk Report

**Step 1 (Audit) and Step 2 (Risk Report). No code has been changed.**

Date: 2 September 2026 · Auditor: engineering review against the running codebase

---

## A. What actually exists

Inspected the code, not the documentation. Where they differ, the code wins and
the difference is recorded in section C.

| | |
|---|---|
| Backend | 1,395 lines across 6 modules (`core`, `auth`, `storage`, `routes`, `lat`, `app`) |
| Frontend | React, ~2,100 lines across `App.jsx`, `Lat.jsx`, `api-client.js` |
| Database | 19 tables, 6 reversible migrations, RLS forced on 10 tables |
| API | 33 endpoints |
| Tests | **71, all passing**, executed against real PostgreSQL 16 during this audit |
| Deployment | Render free tier + Neon free tier, live |

**Verified working during this audit:**

- Server-side GPS validation, radius, accuracy floor, mock-location rejection
- Attendance immutability enforced by database trigger, not application code
- Check-in race safety (single atomic INSERT with unique constraint)
- Claim daily caps with advisory-lock serialisation, tested under real contention
- LAT: spellings withheld once an attempt opens, server-side scoring, one attempt per day
- RLS forced, so even the table owner is subject to policies
- File typing by content inspection; signed, ownership-rechecked downloads
- bcrypt cost 12, account lockout, non-enumerating login, token revocation on logout
- Config validated at startup; production refuses to boot without a CORS allowlist

The security foundations the brief asks to preserve are genuinely present. This
audit is about what sits on top of them.

---

## B. Risk register

Severity per the brief's P0–P3 scale. Every item cites evidence from the code.

### P0 — Critical

**None found.**

I looked specifically for authentication bypass, unauthorised data access,
evidence modification and integrity failures. The existing controls hold. This
is a real finding, not a courtesy — the earlier remediation dealt with the P0
class (the RLS bypass, the audit trigger, the timezone defect).

---

### P1 — High. Fix before wider Phase 1 use.

**P1-1 · No idempotency on any write** — brief §14
*Evidence:* zero references to idempotency anywhere in `src/`.
*Risk:* a trainer on a weak connection submits a claim, the response is lost,
they tap again. Two claims for one bill. The same applies to task submission,
LAT submission and admin approvals. Check-in and check-out are already protected
by unique constraints, but nothing else is.
*Fix:* an `Idempotency-Key` header on critical POSTs, with a table storing the
key, the request fingerprint and the original response. A repeat returns the
first result instead of acting twice.

**P1-2 · Notification failure can roll back the business action** — brief §38
*Evidence:* 8 `INSERT INTO notifications` calls sit inside the same transaction
as the business write (`routes.js` 186, 268, 332, 350, 370, 433, 486;
`lat.js` 199).
*Risk:* the brief states plainly that creating a task must not fail because
notification delivery failed. Today it would. A constraint violation or
statement timeout on the notification insert rolls back the approved claim or
the created task with it.
*Fix:* write the notification as an event in the same transaction but never let
it fail the parent — either move delivery outside the commit, or make the insert
defensive so its failure is logged rather than raised.

**P1-3 · Health endpoint cannot report DEGRADED** — brief §39
*Evidence:* `/health` returns `ok` or, in the catch branch, `degraded` with 503.
There is no state between "everything fine" and "database unreachable", and
storage and migration status are not checked at all.
*Risk:* the brief calls monitoring the single biggest gap. An uptime monitor
currently learns only that the process is alive.
*Fix:* three explicit states, plus checks for database latency, storage
reachability and whether migrations are current.

**P1-4 · No attendance incident workflow** — brief §11
*Evidence:* zero references to incidents in `src/` or `migrations/`.
*Risk:* a trainer standing at a school whose registered coordinates are wrong
cannot check in and has no route to report it. The pressure that creates is
exactly what leads someone to add an "admin override GPS" button later, which
the brief explicitly forbids. Without a sanctioned path, the unsanctioned one
gets built.
*Fix:* an incident table and endpoint. The employee reports the failure with its
machine-recorded reason; the admin reviews and records a resolution. The
original attendance evidence is never rewritten.

---

### P2 — Medium. After P0/P1.

**P2-1 · No password reset** — §27. Resets require an admin running SQL against
production. That is both a bottleneck and a habit worth removing.

**P2-2 · Audit log lacks `reason` and `request_id`** — §33. Columns present:
`audit_id, actor_id, action, entity, record_id, before_data, after_data,
created_at`. The brief asks for reason and request ID so a user-reported error
can be traced to the exact server event. Return reasons are currently only on
the submission row, not in the audit trail.

**P2-3 · Client-supplied `X-Request-Id` is trusted** — §34.
*Evidence:* `app.js:19` accepts the header verbatim. A client can send the same
ID on every request, or forge another user's, making logs unreliable for the
one purpose they exist. Also the format is a bare UUID, not the traceable form
the brief describes.

**P2-4 · Rate limiting covers only login and a global 300/min** — §52. Upload,
claim, LAT and task submission have no specific limits.

**P2-5 · Service worker cache is not cleared on logout** — §47. API responses
are correctly never cached, which is the important half. But the app shell
persists after sign-out, and on a shared phone that is worth closing.

**P2-6 · Backup success is not verified** — §42. `backup.sh` writes a dump and a
checksum, but nothing asserts the file is non-empty or records a timestamp
anywhere the admin can see. Restore has been drilled successfully; *automated*
verification has not been implemented.

**P2-7 · No smoke tests after deploy** — §45. Migrations run at boot and the
health check exists, but no critical-path request is exercised post-deploy.

---

### P3 — Low.

**P3-1 · Product name is wrong throughout** — §2. The code says "Vidya
Publications", "Vidya Daily Operations" and "Daily Ops". The official name is
**Sapience Team**. Cosmetic, but explicitly required, and cheap.

**P3-2 · No version displayed** — §64. `/health` reports `version: "dev"`.

**P3-3 · No CSP** — §53. Helmet's defaults are on; a content security policy is
not configured.

---

## C. Where documentation and code disagree

The brief asks for these to be named rather than silently reconciled.

1. **`SYSTEM.md` claims "no monitoring or alerting"** — accurate, and now
   recorded as P1-3 rather than left as prose.
2. **`SYSTEM.md` lists "Day Plans" as a feature.** The tables `day_plans` and
   `day_plan_items` exist and RLS covers them, but **there are no API routes and
   no UI**. It is schema only. The brief's §4 lists Day Plans as an existing
   Phase 1 module — it is not, in the running system.
3. **`SYSTEM.md` says "Daily summary"** — the endpoint exists in the UI, but
   there is no `POST /daily-summary` route in the current `routes.js`. The table
   exists. **This feature is not wired end to end.**

Items 2 and 3 need a decision from you: build them, or remove them from the
documented feature list. I have not assumed either.

---

## D. Proposed plan (Step 3)

Sequenced by the brief's priority order. Nothing below changes the product
model, adds a module, or costs money.

**Stage 1 — P1**
1. Idempotency table + middleware on critical writes, with tests for the
   duplicate-request case
2. Notification writes made non-fatal to the parent transaction
3. Health endpoint: HEALTHY / DEGRADED / DOWN, with database, storage and
   migration checks
4. Attendance incident workflow: table, endpoints, employee report path, admin
   resolution — original evidence untouched

**Stage 2 — P2**
5. Password reset: single-use short-lived token, sessions invalidated, audited
6. Audit log gains `reason` and `request_id`
7. Server-generated request IDs; client header accepted only as a correlation
   hint
8. Per-endpoint rate limits
9. Backup verification: non-empty, restorable, timestamp recorded
10. Post-deploy smoke test

**Stage 3 — P3**
11. Rename to **Sapience Team** everywhere
12. Version surfaced to admin
13. CSP

**Throughout:** run the full suite after each change, add tests for each new
behaviour, and verify no existing data is affected. Migrations will be additive
only — no destructive changes, no resets.

---

## E. Honesty statements

Per brief §72.

- **Test results above are real.** 71 tests executed against PostgreSQL 16
  during this audit; all passed.
- **Security properties: REVIEWED — NOT PENETRATION TESTED.** The controls are
  exercised by automated tests that attack them through the API (IDOR,
  escalation, answer leakage, file type spoofing). No independent penetration
  test has been performed.
- **RESTORE: VERIFIED ONCE, MANUALLY.** A full drop-and-restore drill succeeded
  with data and RLS policies intact. Automated, scheduled restore verification
  is **NOT IMPLEMENTED**.
- **Browser testing: NOT VERIFIED.** No automated browser tests exist. The
  frontend has been used manually by the operator only.
- **Load and performance: NOT TESTED.** Concurrency is tested; throughput is not.
- **Monitoring in production: NOT IMPLEMENTED.**

---

**Awaiting approval before Step 4.** Confirm the plan, and tell me the decision
on Day Plans and Daily Summary (section C, items 2 and 3), since that changes
what "preserve existing features" means.
