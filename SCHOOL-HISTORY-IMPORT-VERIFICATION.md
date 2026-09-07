# School History Excel Import – Verification

Source workbook tested: `Donbosco(1).xlsx`

## Expected / verified mappings
- Basic details: Location, Vintage, Books, Category
- Contacts: Correspondent/Principal/Key Person and numeric phone fields
- Books & Payment: LKG, UKG, LKG-HHP, UKG-HHP, Delivery Date, P.Y. Credit, Discount, SP Invoice MO, AO, 25-26 Total, Amount Received, Amount Received Date, Amount Pending, Status
- Deliverables 1: Teachers Copy, Teachers Manual, Flash Card Count + Date
- Deliverables 2: WhatsApp, Windows App, Windows App Comments, Kids App Count/Version + Date + System/TV/Both
- Deliverables 3: Question Paper and Progress Card Count + Date
- Services: T1, ATU1/SIM1/ATU2/SIM2/T3/SIM3 values, dates, and every supplied comment row
- Final Current Status and Comments

## Important behavior
- Re-import is a replacement, so stale values from an earlier incorrect import are cleared.
- `-` and `—` placeholders are treated as blank display values.
- Numeric Excel dates are converted to DD/MM/YYYY.
- Invalid textual dates such as `37/5/2025` are preserved for manual correction rather than silently changed.
- Non-numeric contact entries such as `nil` are not stored as phone numbers.
- Phone numbers are rendered as direct `tel:` links on mobile/desktop.
- Render startup continues to bind `0.0.0.0:$PORT` before migration/database readiness work.

## Checks performed
- Backend syntax: `src/app.js`, `src/core.js`, `src/routes.js` passed `node --check`.
- Importer was extracted and executed against the raw XLSX worksheet values and shared strings.
- Verified service comments and final comment are returned in the parsed result.
- Attempted `npm ci --include=dev`; sandbox dependency installation timed out, so a full Vite production build/browser run could not be truthfully reported as passed.

## Verified comment output
- Windows App Comments: `Win Comments`
- ATU 1 Comments: `ATU --sample comments`
- SIM 1 Comments: `SIM --sample comments`
- ATU 2 Comments: `ATU2 --sample comments`
- SIM 2 Comments: `SIM2 --sample comments`
- SIM 3 Comments: `SIM3 --sample comments`
- Final Comments: `Comments --sample comments`
