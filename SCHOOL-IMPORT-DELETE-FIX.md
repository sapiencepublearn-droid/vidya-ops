# School Import/Delete Fix

- Excel `LOCATION` is stored as `address`; it is never copied into `zone`.
- School `zone` is optional and can remain blank until Admin enters it.
- Existing school zones are cleared once by migration 1724800030000 so old misleading imports can be re-imported cleanly.
- Admin can permanently delete a school only when it has no attendance, school-visit, or trainer-assignment records. This permits removal of a bad import and re-upload without risking operational history.
- Schools with operational records must be deactivated instead.
