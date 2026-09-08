# Validation notes for field punches and claims tests

## Field punch validation

`validateFieldFix()` applies only to `Trainer` and `Technical Support` when used by:
- `POST /attendance/check-in`
- `POST /attendance/check-out`
- `POST /attendance/end-day`

It still rejects mock-location signals (`isMocked`). The shared `fixSchema` also validates the GPS payload shape before this function runs.

It intentionally does **not** reject low GPS accuracy and does **not** perform office/school geofence matching for these anywhere punches. The GPS coordinates/accuracy are still recorded as evidence.

School visit check-in/out remains separate and uses `validateOpenFix()` plus assigned-site matching, so the school gate still requires the normal accuracy/geofence rules.

## Claims tests

The claims API schema requires `expenseType` (`Local` or `Outstation`). Stale tests were updated to send `expenseType: 'Local'` without changing the claim business rules.
