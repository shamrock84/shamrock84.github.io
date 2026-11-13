---
paths:
  - "scripts/fetch-rosters.mjs"
  - "scripts/lib/**"
  - "scripts/push-snapshot.sh"
  - "scripts/backfill-*"
  - "scripts/probe-*"
  - "myffl.html"
  - ".github/workflows/backfill-*.yml"
---

# History, placements and payouts

- **History is one Results card and one Finances card across all leagues, and renders logged out.** Editing a guessed finish is login-only (`buildResultRankCell`).
- **MFL final placement is derived from the brackets**; MFL standings are regular-season seeding (`computeMflSeasonPlacements`, `test-history.mjs`). List with `TYPE=playoffBrackets`, then `TYPE=playoffBracket` with **`BRACKET_ID`** — no other spelling works. ESPN uses `rankCalculatedFinal` (**never `rankFinal`**, an always-zero decoy). Sleeper is out of scope.
- **Bracket names are free text, classified by keyword** on both `name` and `bracketWinnerTitle` (`bracketFamily`/`isConsolationBracket`). A Toilet Bowl is not scored backwards. Unplaceable results fall back to regular-season order with `guessed: true`, rendered red.
- **Only `guessed: false` retires a year; a guess stays retry-eligible, but the sync re-reads one at most weekly** (`triedAt` stamp, `GUESSED_RETRY_DAYS`, `yearsNeedingHistoryBackfill`'s `retry`), and looks a league's history up at most weekly (`historyCheck`, `historyLookupIsDue`; `test-history-retry-throttle.mjs`). Un-throttled, the whole budget went to guesses that never changed. `backfill-history.mjs` passes no throttle and re-reads everything. The sync's backfill also doesn't sleep through a 429 (`setMflRetryOn429`, off only for that pass); the on-demand one keeps the retries. `fetchMflSeasonBracketData` rethrows on 429, and a 429 abandons the run's MFL backfill (`mflRateLimited`).
- **The backfill is a separate, budgeted, multi-sync cost.** `HISTORY_MFL_PER_LEAGUE_BUDGET` is lifted when `LEAGUE_ID` targets one league. `backfill-history.yml` and `backfill-scoring.yml` share the `rosters-data-write` concurrency group with the sync. `backfill-history.mjs` trusts the recorded season.
- **`historyLeagueIds` overrides `history.league[]` outright**, and override-covered years sort first in the backfill queue.
- **`draftonly` leagues rank by total points through week 17** (`computeMflSeasonPlacementsByPoints`) — never a guess, all-or-nothing per year, own budget (`HISTORY_MFL_DRAFTONLY_PER_LEAGUE_BUDGET`).
- **The weekly-high payout is awarded every week**: `results[].scoring` has `weeklyHighs` (weeks 1–18) and `seasonHigh`; season totals sum weeks 1–17. Both cutoffs are the manager's, not inferred. `leagueStandings.pf` is no shortcut.
- **Points in `results[].scoring` are rounded to two decimals** (`computeSeasonScoringRecords`) to kill float noise. Never round `salaryAdjustments` — that precision is real.
- **A franchise without a matchup is a flat entry under `weeklyResults.franchise`** (`parseMflWeekScores`, `test-weekly-scores.mjs`); reading only `.matchup` drops it.
- **Division Winner** comes free from `mflDivisionWinner` / ESPN `playoffSeed === 1`, and is unset for `draftonly`.
- **`startYear` is a floor on whose history it is**; `isBeforeStartYear` in the page is the authoritative gate.
- **The Results card averages `rank`, never the raw fraction**; rows are newest-first, leagues by best average.
