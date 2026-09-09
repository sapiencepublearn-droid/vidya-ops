# School & Field Attendance Update

## Included

### Technical Support
- School Visit list now contains every active school with a confirmed latitude/longitude.
- Technical Support is no longer restricted to `trainer_assignments` for school visits.
- School check-in and check-out still require GPS and the school's configured radius.
- Inactive or unlocated schools are not offered for Technical Support visits.
- Trainers retain the existing assigned-school restriction.

### Admin Support
- Existing anywhere check-in/check-out behavior is retained.
- Multiple closed attendance sessions in the same business day remain supported.
- GPS is recorded for every field attendance session.

### School Master / Excel
- Admin School list loads up to 500 schools.
- Added **Import Excel** to Admin > Schools.
- Multiple `.xlsx` school-history files can be selected at once.
- Existing schools are matched by normalized school name and updated.
- New schools are created automatically.
- Full parsed 2026–2027 school history is saved for each imported file.
- Verified coordinates, radius and Active/Inactive state are never overwritten by the bulk history import.
- Imported schools without coordinates remain unavailable for GPS school check-in until an admin confirms their location.
- Existing manual Edit / Active / Inactive controls remain available.
- School history is stored separately from attendance and is not deleted when school details change.

### API client
- Added the missing `admin.resolveGoogleMaps` client method for the existing Google Maps resolver route.

## Deployment note
Run the normal database migrations already present in the repository before deploying. No new migration is required for these changes because the required school, school-history, field-attendance, Admin Support and multi-session database structures already exist in the supplied project.
