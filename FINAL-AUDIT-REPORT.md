# Final Pre-Deployment Audit

Date: 2026-09-07

## Fixed in this audit

- Fixed `M is not defined` in `web/Schools.jsx`: `SchoolHistoryCard` now receives `M` and `Btn` explicitly.
- School detail API now returns `school_history`, so saved history actually displays.
- School visit check-in now requires an active attendance session first.
- Employee `Tasks -> today` includes overdue/pending and completed tasks needed by the End Day checklist.
- End Day now processes carried-forward tasks (`due_date <= today`), so an overdue task can be completed in a later same-day session.
- End Day clears its transient result after the attendance refresh, allowing a second Punch In later on the same business day.
- Employee dashboard counts completed/late/field attendance by calendar day, not by session, while total hours still sum all closed sessions.
- Leaflet map uses the canonical OpenStreetMap tile URL.
- Mobile navigation remains an off-canvas left sidebar; no fixed bottom navigation.
- PWA meta tags include both `mobile-web-app-capable` and Apple compatibility tags.

## Attendance model verified by source inspection

- Multiple closed attendance sessions can exist on the same business date.
- Database partial unique index permits only one open session per employee/date.
- Trainer school visits remain separate from attendance sessions.
- Trainer/Technical Support field punches do not use the designated-location radius, but still validate the GPS fix and reject mocked location.
- Trainer End Day refuses to close an attendance session while a school visit is open.
- End Day and task updates are performed in one transaction.
- Idempotency keys are retained for Punch In and End Day retries.
- A session can cross midnight because timestamps are stored separately from the business date.

## School workflow verified

- Trainer school selector is type-to-filter autocomplete.
- Only assigned schools are offered by the server.
- School Check In/Out remains geofenced.
- School History is stored in `locations.school_history` and editable only through the admin history endpoint.

## Notifications verified

- Attendance reminder runner is scheduled by the server every minute.
- 09:00 IST reminder targets active employees with no attendance session started that day.
- 18:00 IST reminder targets active employees with an open attendance session.
- Reminder runs are idempotent per business date/type.

## Static checks completed

- `node --check` passed for server/API JavaScript files.
- Source inspection completed for attendance, tasks, school history, notifications, navigation, contributions, claims, LAT and employee dashboard flows.

## Environment limitation

A full Vite browser build could not be executed in this sandbox because the Vite development dependency is not installed and the attempted `npm ci --include=dev` could not complete before the sandbox transport timeout. PostgreSQL integration tests were therefore not run here. This report does not claim a production database migration has been executed.

## Deployment rule

Run the migration files in order on the target database and deploy the project as a single release. Do not delete or reset production attendance data.
