# Sapience Team — 4-Week Pilot Log

**Start date:** ___________  **End date:** ___________
**Version at start:** v1.2.0  **Team size:** ____

The point of the pilot is to find out what actually breaks. An empty log
after four weeks does not mean the system is perfect; it means nobody
wrote anything down.

---

## How to record an issue

One row per problem. Do not fix anything in week one unless it is P0 —
let problems accumulate so patterns are visible.

| # | Date | Module | What happened | Who was affected | Severity | Repeats? | Evidence | Status |
|---|------|--------|---------------|------------------|----------|----------|----------|--------|
| 1 |      |        |               |                  |          |          |          |        |
| 2 |      |        |               |                  |          |          |          |        |
| 3 |      |        |               |                  |          |          |          |        |

**Module:** Attendance · Tasks · Claims · LAT · Broadcast · Login · Admin · Other

**Severity**
- **P0** — data loss, security, or nobody can work. Fix immediately.
- **P1** — an important workflow is broken. Fix before the pilot ends.
- **P2** — annoying, but there is a way around it. Fix after the pilot.
- **P3** — cosmetic or a nice-to-have. Probably never.

**Evidence:** screenshot, or the `ref` code shown on the error screen. That
code is the request ID and lets the exact server event be found.

---

## Before you classify, ask which one it is

Not every complaint is a bug.

- **Bug** — the system did the wrong thing → fix it
- **Usability** — it worked, but the person could not tell how → often a wording change, not code
- **Missing requirement** — a real need nobody mentioned → consider for Phase 2
- **Preference** — one person would like it differently → write it down, do nothing

One employee asking for something is a data point, not a decision.

---

## Weekly check (5 minutes, every Friday)

| | Wk 1 | Wk 2 | Wk 3 | Wk 4 |
|---|---|---|---|---|
| Everyone checked in daily? | | | | |
| Any GPS failures at real locations? | | | | |
| Incidents reported? | | | | |
| Tasks actually used, or worked around? | | | | |
| Claims submitted without duplicates? | | | | |
| LAT completed daily by everyone? | | | | |
| Broadcasts seen by everyone? | | | | |
| Anyone needed help to use it? | | | | |
| Anything slow? | | | | |

Also check `/health` shows **healthy**, and that the nightly backup wrote a
fresh `last-backup.json`.

---

## Questions to answer at the end

Not "did it work" but:

1. **Attendance** — did the 100 m radius fit your real schools and office? Which locations needed changing?
2. **Tasks** — did people use the task flow, or did work still happen over WhatsApp?
3. **Claims** — were the ₹500 and ₹1,500 caps right in practice?
4. **LAT** — was it still being done in week four, or did it fade after week one?
5. **Broadcast** — did announcements land, or did people miss them?
6. **Usability** — could someone use it without being shown?
7. **Anything unexpected?** — the most valuable line in this document.

---

## Known limitations during the pilot

Tell people these up front so they report real problems instead of these:

- **No offline use.** No signal means no check-in. Report it as an incident.
- **No password reset screen.** Ask the admin.
- **Free hosting sleeps** if the uptime ping is not running — the first person each morning may wait a minute.
- **No monitoring.** If it goes down, someone has to say so.
- **Day Plans and Daily Summary are not built.** Do not expect them.

---

## At the end

Decide one of:

- **Continue** — it works, keep using it, fix the P1s
- **Fix and re-pilot** — the shape is right, specific things are broken
- **Stop** — it does not fit how you actually work, and an off-the-shelf tool would be better

All three are acceptable outcomes. The third is not a failure; learning it
in four weeks for the price of one month's hosting is a good trade.
