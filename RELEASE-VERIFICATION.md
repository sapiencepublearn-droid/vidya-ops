# Release verification — 2026-09-08

## Included fixes
- Employee dashboard task-history UNION explicitly casts both historical `outcome` fields and live task status fields to text, preventing PostgreSQL enum/text UNION failures.
- School History Excel full-fidelity import and comments.
- Mobile contact links.
- Multi-session attendance / End Day flow.
- Claims weekly cycle/review/close flow.
- Contributions/Inconveniences without monetary/invoice UI fields.
- Map/CSP/service-worker fixes.
- Render startup listens before migrations/DB health checks.

## Local checks
- `node --check` on backend JavaScript: PASS.
- ZIP integrity: PASS.
- No `node_modules` bundled.

## Production note
The reported dashboard URL is authenticated and currently returns HTTP 500 in the user's deployed environment. The exact Render-side SQL error is not exposed to this runtime, so the release includes the hardened dashboard UNION casting fix. After deployment, reload the admin dashboard and retest the same date range.
