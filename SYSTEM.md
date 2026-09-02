# Vidya Daily Operations — System Documentation

**Version 1.0 · Phase 1 · September 2026**

An internal employee operations tool for a small team. Not a customer CRM —
there are no customers, leads or sales pipelines in this system by design.

---

## 1. Who uses it

| Role | Where | What they do |
|---|---|---|
| Employee | Phone | Check in and out, work tasks, file claims, take the daily words test |
| Trainer | Phone, in the field | Same, but checks in at an assigned school rather than the office |
| Admin / CEO | Phone or laptop | Assign work, review submissions, approve claims, publish words, see everything |

There are two permission levels: **employee** and **admin**. An employee sees
only their own records. An admin sees everyone's.

---

## 2. What it does

### 2.1 Attendance — GPS verified

An employee taps Check In. The phone reports its location, and **the server**
decides whether to accept it. The phone never makes that decision, which is
what stops someone checking in from home.

A check-in is refused when:

- The employee is further from the registered site than its radius (default 100 m)
- The GPS reading is too vague to trust (worse than 100 m accuracy)
- The device reports a mock location, meaning a spoofing app is running
- They have already checked in today

Trainers are matched against their assigned schools; everyone else against the
office. If a trainer covers several schools, the nearest permitted one is used.

Once written, the time and coordinates are **frozen**. The database itself
refuses to change them, so a saved check-in cannot be edited by anyone,
including an admin.

Status is set automatically: **Present**, **Late** (past the shift start plus a
grace period), **Field Work** (trainers), **Absent**, or **Leave**.

### 2.2 Tasks

An admin creates a task with a title, description, assignee, priority and
deadline. The assignee is notified.

The task moves through a fixed sequence. Nothing else is possible:

```
Not Started ──▶ In Progress ──▶ Submitted ──▶ Completed
                     ▲                │
                     └──── Returned ◀─┘
```

Submitting requires a written description of what was done, and can carry file
attachments. The admin then approves, or returns it with a reason. A returned
task goes back to the employee with that reason visible, and their next attempt
is recorded as a new submission — the earlier one is kept, so the whole
back-and-forth stays readable.

**Overdue is calculated, never stored.** A task is overdue the moment its
deadline passes while still open. There is no job that could fall behind and
leave the dashboard lying.

### 2.3 Claims — reimbursement

Four categories: **Travel**, **Food**, **Stay**, **Others**.

Every claim needs a photographed or scanned bill. Amount without proof is what
finance sends back.

Limits are **daily totals per employee**, not per bill. Two ₹300 lunches will
not both pass a ₹500 daily cap. The remaining allowance is shown before the
amount is typed, and the server rejects anything that would cross it.

| Category | Default cap | Also required |
|---|---|---|
| Travel | none | Where the journey was |
| Food | ₹500 per day | — |
| Stay | ₹1,500 per day | Location |
| Others | none | What it was for |

Caps are set per employee when the account is created, so a trainer who stays
overnight in another town can have a different ceiling.

Reimbursement is **off by default**. An employee only sees the Claims tab if an
admin enabled it on their account.

The admin approves or rejects. A rejection requires a reason, which the
employee sees.

### 2.4 LAT — Learning And Teaching

A daily words habit, in the spirit of a spelling bee.

```
CEO publishes 10 words  ──▶  everyone is notified
        │
        ▼
Employee reads the words and their meanings
        │
        ▼
Taps Test  ──▶  the words disappear
        │
        ▼
One word per screen: the meaning is shown, the spelling is typed
        │
        ▼
Submit  ──▶  the server marks it  ──▶  score, and the right spellings
        │
        ▼
CEO sees every employee's mark, and who has not taken it
```

Three rules make the mark mean something:

- **Once the test starts, the API stops sending the spellings.** The answers
  are not sitting in the page while the test is taken.
- **The mark is calculated on the server.** A score submitted by the phone is
  rejected outright.
- **One attempt per person per day.** No retaking for a better number.

Case and stray spaces are ignored — `Conscience` and `  liaison ` both count.
Spelling is what is being measured.

### 2.5 Supporting features

- **Daily summary** — what was completed, what is pending, any blocker
- **Notifications** — task assigned, work returned or approved, claim decided, words published
- **Audit trail** — every check-in, task change, submission and claim decision, with who did it and when
- **Attendance history** — an employee's own record, by month

---

## 3. Screens

**Employee (phone)**

| Screen | Contents |
|---|---|
| Login | Email and password |
| Home | Attendance, today's words, today's tasks, close the day |
| Tasks | Today, Upcoming, Done, Overdue |
| Task detail | Description, deadline, history, start and submit |
| Attendance | Today's status and the month's history |
| Claims | Month total, history, new claim |
| LAT | Read, test, result |
| Profile | Details, limits, theme, sign out |

**Admin (phone or laptop)**

| Screen | Contents |
|---|---|
| Today | Present count, completion, overdue, claims awaiting approval, team board |
| Words | Publish today's list, see everyone's marks |
| Claims | Pending, approved, rejected; approve or reject |
| Team | Employees, their limits, add an employee |
| Audit | Recent activity |

The admin console uses a sidebar on a laptop and bottom navigation on a phone.
The same information is shown, arranged for the screen.

---

## 4. How it is built

```
   Phone / laptop browser
            │  HTTPS
            ▼
   ┌─────────────────────┐
   │  Render (Singapore) │   one Node process serves both:
   │                     │   • the React app (static files)
   │  Express API        │   • the API at /api/*
   └─────────┬───────────┘
             │  SSL
             ▼
   ┌─────────────────────┐
   │  Neon PostgreSQL 16 │   data, files, audit trail
   └─────────────────────┘
```

**Frontend** — React, no framework beyond it. Mobile-first. Installs to a phone
home screen as a PWA, so there is no app store and no separate Android build.
All network access goes through one API client, so authentication, errors and
the session-expired path exist in one place.

**Backend** — Node 22, Express, PostgreSQL. Roughly 1,400 lines across six
modules: config and database, authentication, storage, routes, LAT, and the app
assembly.

**Database** — 19 tables, created by 6 reversible migrations. Migrations run
automatically on deploy.

---

## 5. Database

| Table | Holds |
|---|---|
| `employees` | Accounts, roles, claim caps, lockout state |
| `locations` | Office and schools, each with coordinates and a radius |
| `trainer_assignments` | Which trainer may check in at which school |
| `attendance` | One row per employee per day, with frozen GPS |
| `tasks` | Work, its deadline and current state |
| `work_submissions` | Each attempt at a task, kept in full |
| `claims` | Reimbursement, in integer paise |
| `attachments` | File metadata |
| `file_blobs` | File contents |
| `lat_sets`, `lat_words` | The daily words |
| `lat_attempts`, `lat_answers` | Who took the test, what they wrote, the mark |
| `daily_summaries` | End-of-day notes |
| `day_plans`, `day_plan_items` | Self-declared plan for the day |
| `notifications` | Messages to employees and admins |
| `audit_log` | Before and after of every important change |
| `revoked_tokens` | Sessions ended by signing out |

**Money is stored as integer paise**, never a decimal. Floating point and
currency do not mix, and a one-paisa drift in a reimbursement system is an
argument with an accountant.

---

## 6. API

33 endpoints. Everything except login requires a valid token.

**Authentication** — `POST /auth/login`, `POST /auth/logout`, `GET /me`

**Attendance** — `GET /attendance/sites`, `POST /attendance/check-in`,
`POST /attendance/check-out`, `GET /attendance/me`

**Tasks** — `GET /tasks/me`, `GET /tasks/:id`, `POST /tasks/:id/start`,
`POST /tasks/:id/submit`

**Claims** — `POST /claims`, `GET /claims/me`, `GET /claims/:id`

**Files** — `POST /files`, `GET /files/:id/link`, `GET /files/:id/download`

**LAT** — `GET /lat/today`, `POST /lat/attempts`,
`POST /lat/attempts/:id/submit`, `GET /lat/me`

**Admin only** — `POST /tasks`, `POST /admin/employees`,
`GET /admin/employees`, `GET /admin/dashboard`, `GET /admin/claims`,
`POST /admin/claims/:id/decide`, `POST /admin/submissions/:id/approve`,
`POST /admin/submissions/:id/return`, `POST /admin/lat/sets`,
`GET /admin/lat/results`, `GET /admin/audit`

**Also** — `GET /notifications`, `GET /health`

---

## 7. Security

**Every rule is enforced on the server.** The browser may validate for
convenience, but it is never trusted. This applies to the GPS radius, the claim
caps, task transitions, LAT marks and admin-only actions. Each one was tested
by attacking it directly through the API, bypassing the interface.

**Passwords** are hashed with bcrypt at cost 12. They are never stored,
logged, or written to the audit trail. Login gives the same answer for an
unknown account and a wrong password, so it cannot be used to discover who
works here. Five failures lock the account for 15 minutes.

**Sessions** are tokens valid for 12 hours. Signing out revokes the token
immediately rather than waiting for it to expire.

**Row-level security** is enforced by the database, not only by the code. An
employee cannot read another employee's attendance, claims or files even if a
query forgets to filter. The application connects with a restricted role that
owns nothing and cannot delete.

**Files** are typed by inspecting their contents, not their filename. An
executable renamed `.pdf` is refused. Downloads use short-lived signed links,
and ownership is re-checked on every request.

**Evidence is immutable.** Captured attendance times and coordinates, submitted
work and completed tests cannot be altered once written. Attendance,
submissions and the audit log cannot be deleted at all.

**Privacy.** Location is read at check-in and check-out only, never in between.
Coordinates are deleted after 90 days; the attendance fact is kept. This is a
deliberate position under the DPDP Act: the coordinates answer one question —
was this check-in genuine — and that question is dead once the month closes.

---

## 8. Quality

- **71 automated tests**, run against a real PostgreSQL instance
- Covering authentication, permissions, IDOR, GPS rules, race conditions, claim caps, file validation, LAT integrity, error handling
- **Race conditions tested under real contention**: 8 simultaneous check-ins produce exactly one record; 4 parallel ₹200 claims against a ₹500 cap admit exactly two
- **Disaster recovery drilled**: the database was dropped entirely and restored from backup with all data and security policies intact

---

## 9. Running it

| | |
|---|---|
| Hosting | Render, free tier |
| Database | Neon PostgreSQL, free tier |
| Cost | ₹0 during the trial |
| Backups | `pg_dump` nightly, with a scripted restore-and-verify |

On the free tier the service sleeps after 15 minutes idle, so an uptime pinger
every 5 minutes keeps it awake. Moving to the paid tier removes this and is
a one-word change.

---

## 10. What it does not do

Honest limits, so nobody discovers them at an awkward moment.

- **No offline use.** Check-in is verified live, which is the point. No signal means no check-in.
- **No password reset screen.** Resets are done by an admin against the database.
- **No schools directory, map or field-work journey.** Locations exist as check-in points only, with no zone, coordinator or visit tracking.
- **No payroll, leave approval, shifts or rosters.**
- **No customers, leads or sales.**
- **No reporting exports.** Data is visible in the app, not downloadable as a spreadsheet.
- **No monitoring or alerting.** If it goes down, you find out when someone tells you.

---

## 11. Where it could go next

1. Run four weeks with the real team and change nothing
2. Fix what actually breaks, rather than what might
3. Then, in likely order of value: password reset, a spreadsheet export for the accountant, schools with zones and visits, and offline check-in that reconciles when signal returns

The main risk is not technical. It is that the system has no maintainer. It
works, it is tested, and it is documented — but when something breaks, somebody
has to be able to read this and act.
