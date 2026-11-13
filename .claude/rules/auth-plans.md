---
paths:
  - "myffl.html"
  - "api/login.js"
  - "api/plans.js"
  - "api/_lib/auth.mjs"
  - "api/_lib/cors.mjs"
---

# Auth, plans and writes

- **Auth is stateless.** `api/login.js` checks `SITE_PASSWORD` and returns an HMAC-signed 30-day token (`api/_lib/auth.mjs`) used as a Bearer token. MFL credentials never reach the browser. **Failed logins are rate-limited per IP and globally in the Upstash store, and the check fails open if the store is down** (`test-api-rate-limits.mjs`) — don't make it fail closed.
- **Plans sync through `api/plans.js` (Upstash over REST with plain `fetch`, not the `redis://` marketplace store).** View, sub-tab and token stay device-local.
- **A merge is a union and can't express a deletion.** A device merges once (`myfflPlanSynced`) and plain-GETs afterwards, at load and on returning to the page (`syncPlansOnReturn`, throttled, never over a queued push or a focused field); `myfflPlanPending` carries `''` tombstones. Two-device behaviour is only visible in `test-plan-sync.mjs`.
- **The login gate on Analytics, Admin, the ECR column, lineup checkboxes and the sync button is intended — keep it, and gate any new card reading roster, ranking, finance or lineup data.** It deters a league mate opening the URL, nothing more: the same data is public in `config/leagues.json` and `data/rosters.json`. Don't file that as a bug, and don't put anything genuinely sensitive behind the gate alone. History is deliberately ungated.
- **Favorites (NFL teams) ride the plans document** (`favorites.nflTeams`, `renderFavoritesCard`, `test-nfl-favorites.mjs`), login-gated like plans. A merge unions, so only replace carries an un-favorite; an unpushed local list beats the store's (`myfflFavoritesPending`, `adoptRemotePlans`). Match teams through `favoriteTeamKey`. The Admin card's Edit-grid open state is a variable, since a toggle rebuilds the grid. The Depth Charts copies in `.nfl-fav-collapsed` carry no `data-league-type`, or the division pills hide them. Highlighting is purple, never gold: favorites sort first only where order is free (Depth Charts, Schedules); tables and game rows keep their order and get an inset bar.
- **Plans are the exception**: strategy about other people's leagues goes to Upstash, never the repo. That is the whole privacy model.
