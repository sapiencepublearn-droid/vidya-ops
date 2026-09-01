# How to run it

Two processes: an API on port 3000 and a web dev server on 5173. The web
server proxies `/api` to the API, so the browser sees one origin and CORS
never comes up in development.

You need **PostgreSQL 16+** and **Node 20+**.

---

## First time, once

### 1. Install

```bash
cd crm-phase1
npm install
```

### 2. Create the database and a role for the app

```bash
createdb crm
psql crm -c "CREATE ROLE crm_app LOGIN PASSWORD 'pick-a-real-password'"
```

Two roles is deliberate. Migrations run as the owner; the API runs as
`crm_app`, which owns nothing and cannot bypass row-level security.

### 3. Set the environment

Create `.env` in the project root:

```bash
ADMIN_DATABASE_URL=postgres://YOUR_USER@localhost:5432/crm
DATABASE_URL=postgres://crm_app:pick-a-real-password@localhost:5432/crm
JWT_SECRET=paste-32+-random-characters-here
STORAGE_DIR=./storage
```

Generate the secret with `openssl rand -hex 32`. It must be at least 32
characters or the server refuses to start.

### 4. Run the migrations

Migrations run as the **owner**, so point `DATABASE_URL` at the admin URL
just for this command:

```bash
DATABASE_URL="$ADMIN_DATABASE_URL" npm run migrate
```

You should see five migrations apply. If you see `type "citext" does not
exist`, your PostgreSQL is missing contrib — install `postgresql-contrib`.

### 5. Create the first admin account

There is no signup screen; accounts are created by an admin, so the first
one is made by hand.

```bash
node -e "import('bcryptjs').then(b=>b.hash('a-long-password-you-choose',12).then(console.log))"
```

Copy the hash, then:

```bash
psql "$ADMIN_DATABASE_URL" -c "
INSERT INTO locations (kind,name,latitude,longitude,radius_metres)
VALUES ('office','Head Office, T. Nagar',13.041800,80.234100,100);

INSERT INTO employees (employee_code,name,role,email,password_hash,is_admin,office_location_id,claims_enabled)
SELECT 'EMP-000','Nandhini Raman','CEO','ceo@vidyapub.in','PASTE_HASH_HERE',true,location_id,true
FROM locations LIMIT 1;"
```

---

## Every time

Two terminals.

**Terminal 1 — the API:**
```bash
set -a; . ./.env; set +a
npm start
```
It prints `listening`. Check it with `curl localhost:3000/health` — you
want `"ok": true` and today's business date.

**Terminal 2 — the web app:**
```bash
npm run web
```

Open **http://localhost:5173** and sign in with the account you created.

---

## What to do first

1. Sign in as the CEO. You land on the admin console.
2. **Employees** → add your five people. Turn on Reimbursement for anyone
   who claims expenses, and set their daily food and stay caps.
3. **Words** → paste today's list, one per line as `word — meaning`, and
   publish. Everyone gets a notification.
4. Sign in as an employee on a phone to check in. The browser will ask
   for location permission; on a laptop far from the office the server
   will correctly refuse the check-in, which is the system working.

---

## Running the tests

The tests need a migrated database and truncate it between runs, so point
them at a **separate** database, never the live one.

```bash
createdb crm_test
DATABASE_URL=postgres://YOUR_USER@localhost:5432/crm_test npm run migrate
psql crm_test -c "ALTER ROLE crm_app PASSWORD 'test-password'"

cp .env.test.example .env.test   # edit the two URLs to point at crm_test
set -a; . ./.env.test; set +a
npm test
```

Expect **71 passing**.

---

## Going live

```bash
npm run web:build     # static files land in dist/
```

Serve `dist/` from nginx or Caddy, and proxy `/api` to the Node process.
In production you must also set:

```bash
NODE_ENV=production
CORS_ORIGINS=https://your-domain          # explicit, never *
```

The server refuses to start in production without a CORS allowlist, which
is intentional.

Then schedule the two jobs:

```cron
0 2 * * *  cd /srv/crm && ./scripts/backup.sh
0 3 * * 0  cd /srv/crm && ./scripts/restore-verify.sh /var/backups/crm/$(ls -t /var/backups/crm | head -1)
30 1 * * * psql "$ADMIN_DATABASE_URL" -c "SELECT purge_old_gps(90)"
```

The weekly restore matters more than the nightly backup. A backup nobody
has restored is a guess.

---

## When something is wrong

**`JWT_SECRET must be at least 32 characters`** — the server validates
config at boot rather than failing later at a random request.

**`ECONNREFUSED` on 5432** — PostgreSQL is not running.

**Login always fails** — check the account exists and `status` is
`Active`. After five wrong passwords the account locks for 15 minutes,
and the correct password is refused during the lock. That is the
brute-force protection, not a bug.

**Check-in refused with a distance** — you are further from the
registered location than its radius. The server decides this, so you
cannot work around it from the browser. Adjust the radius in the
`locations` table if the office coordinates are wrong.

**An employee sees no data at all** — usually the API is connected as the
wrong role. Row-level security needs the request to run through the app's
transaction helper; a query outside it sees nothing. See DECISIONS.md.

**Blank page on 5173** — check the API terminal. If `/api/auth/login`
returns 500, the migrations probably did not run.
