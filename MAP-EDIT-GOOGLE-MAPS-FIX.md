# School Edit + Google Maps Fix — 2026-09-08

## Fixed
1. School detail Edit now closes the detail view and opens the edit form. Previously the parent kept `open` true, so the form state was set but the early return continued rendering SchoolDetail.
2. School location input is now a single Google Maps link field. Pasting a full Google Maps URL or coordinate pair extracts latitude/longitude automatically.
3. Supported location URL forms include Google Maps `@lat,lng`, `?q=lat,lng`, `?query=lat,lng`, `?ll=lat,lng`, `?destination=lat,lng`, `/place/lat,lng`, and plain coordinate pairs.
4. Existing schools with coordinates show an "Open location in Google Maps" link instead of exposing raw latitude/longitude in the school detail and map selection card.
5. Long/mobile School History comment popup changes from the previous release are retained.

## Limitation
Google Maps short `maps.app.goo.gl` links do not contain the coordinates in the pasted string and are not resolved by the browser. Use the full Google Maps link or paste the coordinate pair. No Google API key is required for this extraction.

## Verification
- Backend `src/routes.js`: `node --check` PASS
- Google Maps parser: common URL forms PASS
- ZIP integrity: PASS
