# Sapience Team - App Session + Assigned School Check-in Fix

Updated:
- web/api-client.js: persist login across app/browser reopen; clear on logout/401.
- web/Punch.jsx: school visit selector uses the assigned-school list and explicitly tells the employee only assigned schools are shown.

Backend assignment enforcement already exists in src/routes.js: school visit check-in rejects any location that is not assigned to the employee for the current day.
