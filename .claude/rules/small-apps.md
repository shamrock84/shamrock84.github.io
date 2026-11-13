---
paths:
  - "vikings.html"
  - "bangers.html"
  - "index.html"
  - "api/vikings.js"
  - "api/bangers.js"
  - "api/fam.js"
  - "api/_lib/sharedalbum.mjs"
  - "api/_lib/calendarfeed.mjs"
  - "data/bangers.json"
  - "data/vikings-history.json"
  - ".github/workflows/backfill-vikings-history.yml"
---

# The small apps: myVST (`vikings.html`), myBangers (`bangers.html`), myFAM (`index.html`)

- **`vikings.html` (melbostads.com/vikings) is a second, tiny app** over `api/vikings.js` (`test-vikings.mjs`). The schedule is home games only: `nflSchedules.teams.MIN` plus the Vikings-only `nflPreseason` (`fetchNflPreseason`, ESPN `seasontype=1`; kept out of `nflSchedules` so myFFL's bye logic never sees it; keyed `${season}-p${week}`, dropped when its season isn't the schedule's). Playoffs are three hand-typed rows (`2026-po1..3`, `info` = date/day/time/opponent, hidden from logged-out viewers until filled); names and face values are per-game patches keyed `${season}-${week}`. **Its GET is public and its POST login-gated — the opposite of `plans.js`** — because logged-out visitors see the names as text. Seat ids and owners live in the page's `SEAT_GROUPS`; don't renumber a seat once names are saved. **Tabs: Schedule and History are read-only for everyone; editing lives only in the login-only Admin tab** (a Tasks card and a Seasons card of one collapsible mini-card per season, 2016 on; History is one collapsible card per earlier season). The snapshot carries only the current season, so earlier schedules come from `data/vikings-history.json` (`backfill-vikings-history.yml`, manual, re-run yearly; it reads playoffs too, and a season with a `postseason` list takes its playoff rows from it, otherwise they're typed by hand; `test-vikings-history.mjs`). Seat groups are per season (`since`/`seasons` on `SEAT_GROUPS`: Kevin's pair from 2024, Jeff's Sec 101 pair 2024 only). The header toolbar is the Admin tab's Quick Links card, stored whole under `vikings:quicklinks` (`?resource=quicklinks`, **public GET**, login-gated POST; no League Links block, hidden when empty). Admin's tasks are their own list under `vikings:tasks` (`?resource=tasks`, **login-gated on GET too**, per-task patches), never the plans document.

- **`bangers.html` (melbostads.com/bangers, "myBangers") is a third small app** over `data/bangers.json`: Winners and Nominees tabs for everyone, a login-only Admin tab. Admin's Save POSTs to `api/bangers.js`, which **commits the file straight to `main`** (like `save-leagues.js`, same `GITHUB_CONTENTS_TOKEN`; the list itself has no Upstash and no GET), so its validation is the only guardrail; `test-bangers.mjs` also validates the committed file. A stale save is refused by blob sha (`baseSha`). Pages republishes a minute or two after a save. Ids must be letters and digits. Its Admin tab also has the **same Tasks and Quick Links cards as vikings.html**, ported from it (keep them in step), in Upstash under `bangers:tasks` / `bangers:quicklinks` via `?resource=tasks|quicklinks` on the same endpoint (reusing vikings.js's validators; **never share vikings' keys**; quick-links GET public, tasks GET and every POST login-gated; `BANGERS_TASKS=1` points `fetch-tasks`, `mark-tasks-done` and `rename-task-category` at them). **`index.html` (myFAM, the home page) has the same two cards** over `api/fam.js` (`fam:tasks`/`fam:quicklinks`, `FAM_TASKS=1`, `test-fam.mjs`): keep the three in step. Its Family tab: Photos and Calendar read public iCloud feeds via `api/fam.js` `?resource=photos|calendar` (`api/_lib/sharedalbum.mjs`, `calendarfeed.mjs`; links in Vercel's `FAM_PHOTOS_ALBUM`/`FAM_CALENDAR_ICS`, never committed; `test-shared-album.mjs`, `test-calendar-feed.mjs`).
