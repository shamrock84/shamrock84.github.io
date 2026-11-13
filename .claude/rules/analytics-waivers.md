---
paths:
  - "scripts/fetch-rosters.mjs"
  - "scripts/lib/**"
  - "scripts/push-snapshot.sh"
  - "scripts/backfill-*"
  - "scripts/probe-*"
  - "myffl.html"
  - "api/waivers.js"
---

# The Analytics and Waivers cards

- **Top Available reads the rankings, not our rosters**: top-level `rankingPools` (`RANKING_POOL_SIZE`, keyed by `rankingPoolKey`, site-relative URLs, team normalized to `'FA'`) plus per-league `available`. K/DST are dropped from the pool by `WIRE_EXCLUDED_POSITIONS` before truncation, never from `buildRankingIndex`. `test-ranking-pool.mjs`, `test-top-available.mjs`.
- **`available: null` is "couldn't tell", `[]` is "nothing free"; only `[]` belongs in a denominator.** Free In and Own In share one denominator.
- **A redrafting league still on last season is hidden on the page, not the sync** (`awaitingRollover`, `REDRAFTING_TYPES`). Both seasons must be present to drop anything.
- **Top Available must never median across Redraft and Dynasty** — two FantasyPros lists that disagree by a hundred places, weighted by league count. It gets one card per `TOP_AVAILABLE_GROUP` (Dynasty + Salary Cap share one card with `data-league-type="dynasty,salarycap"`), none for Draft Only, and lives on the Waivers tab.
- **Elsewhere Dynasty and Salary Cap are separate pills** via `SUBTAB_GROUP`; `typesInGroupMap`/`presentGroupsFor` are the shared plumbing for any new grouping.
- **The merged cards — Bye Weeks, Player/Injury/Loss Exposure (Analytics, `MERGED_ANALYTICS_ORDER`, fixed order), Power Rankings (top of Standings, `refreshPowerRankCard`) and Team Needs (top of Waivers, `refreshTeamNeedsCard`) — are one card each, recomputed on every pill toggle.** They read within-league ordinals, so the Top Available hazard doesn't apply. They carry no `data-league-type`, so present groups come from `analyticsPresentGroups(leagues)`, never from rendered cards. `searchAwareRefreshers` entries are `{card, fn}` and are pruned when the card leaves the DOM, or toggles leak closures.
- **The exposure cards share a denominator (`exposureLeagues`) but not a page size**: `PLAYER_EXPOSURE_PAGE_SIZE` 8, `ANALYTICS_PAGE_SIZE` 6, sized so side-by-side cards come out level. Change row height, change both.
- **Injury vs Loss Exposure is one vocabulary split by `INJURY_SETTLED`** (`collectInjuryDesignations`). Loss gets IR/PUP/NFI/SUSP/HOL/NA/RET; Injury gets the rest, including unknown codes. They sort `INJURY_SEVERITY` in opposite directions (`sortByWorstFirst`/`sortByBestChanceFirst`); **never re-rank the scale itself**, which also picks the winner when providers disagree.
- **Injury detail is a sub-line, never a column.** `Undisclosed` is dropped; `exp_return` shows only within `INJURY_RETURN_HORIZON_DAYS`. **Don't go back to Sleeper for injury news** — `probe-injury-detail.yml` found nothing usable. `attachInjuryDetail` only fills gaps.
- **NFL team is appended via `appendTeamSuffix`, never a column**, from the rostered player (so `LVR` and `LV` both appear as sent) or the ranking pool.
- **The Waivers tab is live-only, login-gated, and never enters `data/rosters.json` or Actions logs** (`api/waivers.js`, `renderWaiversCard`, `test-waivers.mjs`). Re-run `probe-waivers-auctions.yml` before changing a parser — MFL's claim string is underscore-separated (`parseMflAddsDrops`). Sleeper is unsupported. Cap room comes from the snapshot; BBID balance is read fresh (`mflBlindBidBalance`), null when unreadable. **ESPN's `PENDING` claims have processed twins** that `parseEspnPendingWaivers` must drop. A failed read never renders as "nothing pending". **An auction's end is derived**: 24h after the high bidder last *changed* (`foldMflAuctions`, `AUCTION_END_HOURS`).
- These cards fail silently, which is why most are pinned by tests that run the page's script in a `vm`. Every Analytics card carries only an `Across N leagues` subtitle.
