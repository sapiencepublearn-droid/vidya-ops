# Sapience Team — Release Verification

Date: 2026-09-08

## Included fixes
- School History Excel import preserves workbook values and comments.
- School History contacts are directly tappable via `tel:` links.
- School History mobile layout is responsive.
- Employee Dashboard PostgreSQL UNION type mismatch fixed with explicit text casts.
- Render startup listens on `0.0.0.0` before migrations/DB health checks, preventing port-scan timeout.
- Attendance uses multi-session model and End Day flow.
- Trainer/Technical Support field attendance records GPS at punch time; no continuous location watch.
- OSM map/CSP/service-worker fixes retained.
- Claims weekly cycle/review/close flow retained.
- Contributions/Inconveniences contain no invoice/amount concept.

## Local verification
- `node --check src/*.js`: PASS
- `node --test test/ui.test.js`: PASS — 41/41
- Full `npm test`: BLOCKED by incomplete local `node_modules` (`pg/index.js` is missing). This is an environment/dependency-install issue; the Render build uses `npm ci` from the lockfile.
- `npm run build`: BLOCKED locally because Vite is not installed in the incomplete local `node_modules`.

## Production verification
- Production service was reachable over HTTPS (HTTP 200 at the public root).
- Unauthenticated dashboard API returned HTTP 401, confirming the live route/auth middleware is reachable.
- Authenticated browser click-through could not be performed from this runtime because no authenticated browser session/browser automation is available.

## Release note
This ZIP is the corrected source package. It does not contain `node_modules` or local secrets. Deploy it through the existing Render/GitHub pipeline.
