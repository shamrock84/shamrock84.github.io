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

- **`vikings.html` (melbostads.com/vikings, myVST) is a second, tiny app** over `api/vikings.js` (`test-vikings.mjs`). **Its GET is public and its POST login-gated — the opposite of `plans.js`** — because logged-out visitors see the names as text. Schedule and History are read-only for everyone; editing lives only in the login-only Admin tab.
- **The myVST schedule is home games only**: `nflSchedules.teams.MIN` plus the Vikings-only `nflPreseason` (`fetchNflPreseason`), kept out of `nflSchedules` so myFFL's bye logic never sees it, and dropped when its season isn't the schedule's. Names and face values are per-game patches keyed `${season}-${week}` (preseason `-p${week}`, playoffs `-po1..3`). Playoff rows are hand-typed and hidden from logged-out viewers until filled.
- **Earlier myVST seasons come from `data/vikings-history.json`** (`backfill-vikings-history.yml`, manual, re-run yearly; `test-vikings-history.mjs`), since the snapshot carries only the current one. A season with a `postseason` list takes its playoff rows from it; otherwise they're typed by hand.
- **Seat ids and owners live in `vikings.html`'s `SEAT_GROUPS`**, per season via `since`/`seasons`. Don't renumber a seat once names are saved.
- **myVST's Quick Links and Tasks are their own Upstash keys, never the plans document**: `vikings:quicklinks` (`?resource=quicklinks`, public GET, login-gated POST; it is also the header toolbar) and `vikings:tasks` (`?resource=tasks`, login-gated on GET too).
- **`bangers.html` (melbostads.com/bangers, "myBangers") is a third small app** over `data/bangers.json`: Winners and Nominees tabs for everyone, a login-only Admin tab. Admin's Save POSTs to `api/bangers.js`, which **commits the file straight to `main`** (like `save-leagues.js`, same `GITHUB_CONTENTS_TOKEN`), so its validation is the only guardrail; `test-bangers.mjs` also validates the committed file. A stale save is refused by blob sha (`baseSha`). Ids must be letters and digits. Pages republishes a minute or two after a save.
- **myBangers and myFAM carry the same Tasks and Quick Links cards as `vikings.html` — keep the three in step.** Each has its own Upstash keys (`bangers:*` via `api/bangers.js`, `fam:*` via `api/fam.js`, `?resource=tasks|quicklinks`, reusing vikings.js's validators; **never share keys**) and the same gating: quick-links GET public, tasks GET and every POST login-gated. `BANGERS_TASKS=1` / `FAM_TASKS=1` point `fetch-tasks`, `mark-tasks-done` and `rename-task-category` at them (`test-fam.mjs`).
- **`index.html` is myFAM, the home page.** Its Family tab's Photos and Calendar read public iCloud feeds via `api/fam.js` `?resource=photos|calendar` (`api/_lib/sharedalbum.mjs`, `calendarfeed.mjs`; `test-shared-album.mjs`, `test-calendar-feed.mjs`). The feed links live in Vercel's `FAM_PHOTOS_ALBUM`/`FAM_CALENDAR_ICS`, never committed. **Photos keeps two caches on different clocks**: the photo list 12 hours, Apple's signed image URLs 5 minutes (they expire in ~20), so never cache the whole response for hours. `&refresh=1` forces both and needs the Bearer token; the card's Refresh button shows only when logged in.
