# Vidya Ops — Production School Import Fix

## Purpose
This release fixes the School Master / School History Excel import and cleans legacy imported data without deleting attendance records.

## Included
- Blank School Master Zone is allowed; Excel LOCATION is stored as Address.
- Permanent school delete is allowed only when the school has no attendance, visit, or trainer-assignment references.
- Legacy `VINTAGE: CATEGORY: X` / `BOOKS: CATEGORY: X` corruption is repaired.
- CATEGORY values are stored without the `CATEGORY:` label.
- Long ATU/SIM comments are accepted up to 10,000 characters.
- Legacy workbook labels such as `ATU 2 COMMENTS` after ATU 1 and `SIM 2 COMMENTS` after SIM 1 are attached to the preceding service.
- Windows App / Kids App columns are read from their header positions instead of fixed columns.
- Discount values such as `0.28` display as `28%`.
- Location is no longer displayed as a separate School History field; it belongs to School Master Address.
- Failed history import for a newly created school is rolled back so the importer does not leave a partial school.
- Render blueprint uses `npm run migrate && npm start` for Free-plan startup migrations.

## Deployment
Build command:
`npm ci --include=dev && npm run build`

Start command:
`npm run migrate && npm start`

After pushing this release to the GitHub `Deploy` branch, Render should run migration `1724800030000_school_delete_and_optional_zone` followed by `1724800031000_school_history_repair`.

## Data safety
The repair migration does not reset PostgreSQL, truncate tables, delete attendance, or rewrite attendance evidence.
