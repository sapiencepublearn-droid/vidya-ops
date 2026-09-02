# Sapience Team— Daily Operations CRM (Phase 1)

A small, secure operations tool for five employees: GPS-verified
attendance, task lifecycle with review, reimbursement claims with
per-employee daily caps, and LAT — a daily words test the CEO publishes
and the whole team takes.

This is employee tracking and management. There is no customer or lead
database, by design.

Deliberately not built: microservices, Redis, queues, read replicas.
Five people generate a few hundred requests a day.

## Run it

```bash
createdb crm
export ADMIN_DATABASE_URL=postgres://owner:pw@localhost:5432/crm
export DATABASE_URL=$ADMIN_DATABASE_URL     # migrations run as owner
npm install
npm run migrate

psql "$ADMIN_DATABASE_URL" -c "ALTER ROLE crm_app PASSWORD 'a-real-password'"
export DATABASE_URL=postgres://crm_app:a-real-password@localhost:5432/crm
export JWT_SECRET=$(openssl rand -hex 32)
npm start
```

Copy `env.example` to `.env` for the full list. Two database URLs is
intentional: the API runs as `crm_app`, which owns nothing and cannot
bypass row-level security. Migrations and backups use the owner.

Create the first admin:

```bash
node -e "import('bcryptjs').then(b=>b.hash('a-long-password',12).then(console.log))"
psql "$ADMIN_DATABASE_URL" -c "INSERT INTO employees (employee_code,name,role,email,password_hash,is_admin) \
  VALUES ('EMP-000','Nandhini Raman','CEO','ceo@vidyapub.in','<hash>',true)"
```

## Test it

```bash
npm test    # 54 tests, needs a migrated database
```

## Layout

```
migrations/   4 reversible SQL migrations (node-pg-migrate)
src/          core.js config+db+errors, auth.js, storage.js, routes.js, app.js
web/          api-client.js and App.jsx — the canonical frontend
test/         security, business, journey, contract
scripts/      backup.sh, restore-verify.sh
legacy/       superseded prototypes, see DEPRECATED.md
DECISIONS.md  why things are the way they are
```

## What was verified, and how

Run against real PostgreSQL 16 deliberately set to **UTC**, so the IST
date bug would reproduce if it were still present.

| Claim | Evidence |
|---|---|
| Clean install works | 4 migrations onto an empty database; `down` then `up` again |
| Audit trigger works | Task insert writes an audit row; password hash stripped |
| IST dates correct | `2026-08-28 20:00 UTC` → `2026-08-29` IST, asserted |
| Check-in race handled | 8 concurrent requests → 1×201, 7×409, no 500s, 1 row |
| Claim caps enforced | 4 parallel ₹200 claims against ₹500 → exactly 2 succeed |
| RLS actually applied | Cross-employee read denied; owner access still works |
| Files validated | ELF-as-PDF → 415; PNG-as-PDF → 415; 11 MB → 413 |
| Backup restorable | Database dropped, restored, data and 15 policies identical |
| Frontend ↔ API | Full journey through `api-client.js`: login → check-in → task → claim → logout |
| LAT grading | Marks calculated server-side; spellings withheld during the test; one attempt per day |

## Not verified

- Browser rendering of `App.jsx`. It parses and its contract with the
  client is tested mechanically, but no browser ran here.
- HTTPS/TLS termination, production CORS against a real browser.
- Graceful shutdown under a real SIGTERM.
- Cron scheduling of `backup.sh` and `purge_old_gps()`.

## Known gaps

- No password reset flow.
- No CI pipeline.
- No error monitoring (Sentry or equivalent).
- Day plans and daily summaries have tables but no routes or UI yet.
- Schools, Map and Field Work modules are not built (no schema, no API).
- Admin console is still desktop-shaped below 768px.
