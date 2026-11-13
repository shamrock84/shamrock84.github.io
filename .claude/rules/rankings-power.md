---
paths:
  - "scripts/fetch-rosters.mjs"
  - "scripts/lib/**"
  - "scripts/push-snapshot.sh"
  - "scripts/backfill-*"
  - "scripts/probe-*"
  - "myffl.html"
---

# Rankings, projections and power

- **The automatic ranking set follows the calendar** (`nflSeasonPhase`/`automaticRankingType`, `test-season-phase.mjs`): `ROS` from kickoff through the Super Bowl, `DYNASTY`/`DRAFT` otherwise. The FantasyPros year is not `YEAR` between New Year and the Super Bowl. The page's copy of the rule only words the Admin note. `rankingType` opts a league out.
- **FantasyPros player URLs are read off the response, never built from a name** (`playerPageUrl`) — slugs disambiguate same-named players.
- **Four things are duplicated across the sync boundary, and each drift is silent:**
  - `normalizeName`/`NAME_SUFFIX` (page) vs `normalizePlayerName` (`fantasypros.mjs`) — pinned in `test-top-available.mjs`.
  - `POWER_POSITIONS` — must be identical in both.
  - The weekly rollover comparison — `isPastWeeklyRolloverCutoff` (`providers.mjs`) vs `pastWeeklyRolloverCutoff` (page), checked hour-by-hour by `test-problems-digest.mjs`. The *setting* lives only in `WEEKLY_ROLLOVER_CUTOFF` and ships in the snapshot as `weeklyRolloverCutoff`.
  - `POSITION_ORDER` — the page's list is the sync's filtered down (same order, no IDP). `test-shared-constants.mjs` pins this and fires the day an IDP league appears.
- **Power ranks are homegrown** (`computePowerScore`/`computeLeaguePower`, `test-power-rank.mjs`); nothing team-shaped exists in the FantasyPros API (`probe-fantasypros-power-rank.yml`). MFL joins by player id; Sleeper and ESPN by normalized name, and **a Sleeper id must never touch the id join** — both are small numeric strings and a wrong join looks plausible. The score is a floor comparable only within a league. ESPN uses `DEFAULT_POWER_SLOTS`. Power rides the availability pass's read. `computeLeaguePower` returns null with no seated player, and `fetchProjections` throws on an empty position.
- **The Win column is the record on a 1..size scale** (`powerWinRank`) and joins the Avg beside ECR/Start/Ben (`powerRowAverage`); with no record it is left out, never counted as zero.
- **Studs and Sleepers** (`powerPlayersLine`, `STUDS_RANK_THRESHOLD`/`SLEEPER_RANK_THRESHOLD`, `attachSleepers`, `test-sleepers.mjs`). **The type is `SLEEPERS`, plural** — FantasyPros silently serves the Draft list for an unknown type. Re-run `probe-fantasypros-sleepers.yml` before touching it. Empty lines are omitted.
- **Team Needs calls `computeMyPowerRows` outright** so both cards agree on what's rankable; `hasByPosition` requires every team to carry the shape. It flags every position below the league average (fallback: the team's weakest; all-tied: nothing), in a sub-line, never in the cell. `test-team-needs.mjs`.
- **When projections are dark, power falls back to ranking pools** (`ecrValue`/`buildEcrIndex`; depth = deepest rank present, not entry count), and `powerDetailBasis` picks one basis card-wide (projections when any row has them), so a column never mixes the two.
- **In season, `fetchProjections` asks for `ros=true`, not `week=0`** (frozen). The full story is in its comment. `powerUsesPreseasonProjections` is the regression guard.
- **Roster-limit violations are computed** (`parseRosterLimits` + `rosterLimitProblems`); MFL has no verdict field. At a limit is not over it. **`"0-0"` means unconfigured, not a cap of zero.**
