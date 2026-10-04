# CLAUDE.md

Guidance for Claude Code (claude.ai/code) in this repository.

**This file is an index of rules, not the reasoning behind them.** The source is 30–47% comments, and the comment at the code is the authority. Each entry states the rule, names what to read, and says how breaking it fails silently. When you change something, update the comment at the code first; touch this file only when a *rule* changes.

**Keep it short — it is loaded in full every session.** An entry is two to four sentences; history ("shipped wrong once", probe run narratives) belongs at the code or in the probe header, not here. `syntax-check.yml` fails a PR that takes this file past 45,000 bytes. If you are near that, compress an existing entry rather than raising the limit. This file has twice drifted past 90KB.

## What this repo is

A personal static site (`melbostads.com`) whose only real application is **`myffl.html`**, a fantasy football dashboard over 18 leagues on MyFantasyLeague (MFL), ESPN and Sleeper. Every other page is a stub, an iframe around a Google Sheet, or a redirect. `myffl_v1.html` is the retired predecessor.

There is **no build step, no test framework, no linter and no dependencies**. `package.json` only sets `"type": "module"`. Tests are plain `node scripts/test-*.mjs` files run by `syntax-check.yml`.

## Two deployment targets, one repository

| Path | Deploys to | Serving |
| --- | --- | --- |
| `*.html`, `data/`, images | GitHub Pages | `melbostads.com` (`CNAME`) |
| `api/*.js` | Vercel | `shamrock84-github-io.vercel.app` |

`myffl.html` calls Vercel by absolute URL (constants near the top of its script), so every request is cross-origin; `api/_lib/cors.mjs` holds the allowlist.

- **Secrets live in two independent places.** GitHub Actions secrets power the sync; Vercel env vars power `api/`. Adding a credential means deciding which half needs it. Upstash credentials are Vercel-only.
- **`.vercelignore` is a storage quota, not tidiness.** Vercel stores the whole upload per deployment, and the repo is ~172MB, almost all `mfl/` and `images/`; unignored it filled the free 10GB once. `ignoreCommand` skips the build, not the upload. Anything `api/` reads by path must stay (`config/leagues.json`, `scripts/lib/`), and the `!scripts/lib/` negation must stay. Verify with `git ls-files -i -c --exclude-from=.vercelignore`. Known and accepted: the Vercel copy of `myffl.html` can't fetch `data/`.
- **Shared `api/` helpers live in `api/_lib/`; the underscore is load-bearing.** Vercel makes every other file under `api/` a function, and Hobby caps a deployment at 12. Nine endpoints today — count before adding one.
- **`vercel.json`'s `ignoreCommand` skips deploys** unless the commit touched `api/`, `scripts/lib/providers.mjs`, `scripts/lib/fantasypros.mjs` or `config/leagues.json`. **If `api/` starts importing a new module, add it there**, or Vercel silently skips deploys that need to ship.

## Two data paths, deliberately separate

**Slow path — committed snapshot.** `sync-fantasy-rosters.yml` runs `scripts/fetch-rosters.mjs` every 4 hours and commits `data/rosters.json`: rosters, standings, scoring, lineups, FantasyPros pools, free agents. The page downloads the whole file on every load (~650KB, ~100KB gzipped), which is the budget any new field spends. **All three writers go through `serializeSnapshot`** (one line per league, for readable diffs) — never `JSON.stringify(…, null, 2)`.

**Fast path — live, never written down.** `api/live-scoring.js`, polled while the Scoring tab is open; it writes nothing and keeps a module-level cache that resets on cold start.

Both import fetch logic from **`scripts/lib/providers.mjs`**; `fetch-rosters.mjs` is orchestration only. `api/trigger-sync.js` lets the page's sync button dispatch the sync. **It is login-gated** (Bearer token checked before the cooldown, button hidden when logged out) and has a **5-minute cooldown held in the Upstash store**. Keep the cooldown longer than a sync run (60–120s): the workflow queues dispatches, so a shorter gap lets syncs run back to back.

## `config/leagues.json` is the control plane

Adding, removing or reclassifying a league is a config edit, usually made in the **Admin tab** (visible when logged in), which saves through `api/save-leagues.js`. Prefer pointing the user there over hand-editing. That endpoint **commits straight to `main`**, bypassing PRs and CI, so its validation is the only guardrail; extend `test-save-leagues.mjs` with any schema change.

The file's `_readme` array is the authoritative schema — read it before touching anything league-shaped, and update it with the schema. Array order is display order everywhere.

- `mergeLeague` passes unknown fields through, or a field added later would be erased on the next Save. `RETIRED_KEYS` is how a field is removed for good (today `format`, `commishEmail`).
- `serialize` keeps one league per line so an Admin commit is a one-line diff.
- **`type: 'bestball'` was renamed `'draftonly'`.** Best Ball is a scoring system several salary-cap leagues use, and lives in `tags`. Nothing in code records this rename.
- `type: 'salarycap'` also drives the Salary/Yrs columns, the cap summary, and fetching cap adjustments.
- Providers: `mfl` (default), `espn`, `sleeper`. Selection is a three-way ternary at each stage of `fetch-rosters.mjs`, so a fourth provider touches every stage.

## Invariants worth preserving

### Sync, seasons and rate limits

- **The sync degrades, it never fails.** Each league is wrapped in try/catch and falls back to its previous entry (`previousById`) with an `error` field. FantasyPros is layered on last and can't fail the run.
- **MFL requests are paced per entry point** (`setMflRequestInterval`/`paceMflRequest`, `test-mfl-request-pacing.mjs`). Off by default; the sync and backfills opt in with `MFL_REQUEST_INTERVAL_MS`, live scoring with `LIVE_SCORING_MFL_INTERVAL_MS` (which must fit a cold burst inside its explicit `maxDuration: 30`). **Never make the gate global.** It serializes request *starts* on a promise chain, because a "has enough time passed?" check lets concurrent `Promise.all` callers burst together. Both numbers are guesses; MFL publishes no limit, so move one only after a probe.
- **The login retries transient failures; a cookieless 200 does not** (`fetchWithTransientRetry`/`mflLogin`, `test-mfl-login-retry.mjs`). A failed login kills the whole sync, so 429/5xx/transport errors retry on a long backoff; a 4xx or a 200 without a cookie is wrong credentials. `mflLoginForImport` deliberately doesn't retry.
- **`TYPE=league` is read once per MFL league per run** and the `{ nameById, ownerById }` pair threaded through as a local in `main()` — never a field on the result, which would ship to every visitor. `fetchStandings`/`fetchScoring` fetch their own if handed nothing.
- **Owner names come from the league's own regional host** (`fetchMflOwnerNames` uses `baseURL`). The generic `api.myfantasyleague.com` host unreliably honours a privileged session, which is what made `owner_name` look commissioner-gated for a long time. It isn't. See `probe-mfl-owner-name.mjs`. All providers render "Team Name (Owner)" via `teamNameWithOwner`.
- **The season is per league, resolved by availability, not the calendar** (`resolveSeason`; `seasonOf(league)`, `test-season-rollover.mjs`). Only a definitive absence moves a league — never a 429 or ESPN 401. Global lookups stay on `YEAR`. Expired ESPN cookies make every season look absent, which is why `probe-league-season.yml` hard-fails on its control.
- **Scoring format is read from the league** (`detectScoringFormat`, `test-scoring-format.mjs`). A rate that isn't exactly 1, 0.5 or 0 returns `null`, never a rounded guess. Blank `scoring` in config means "detect".
- **The availability pass runs last, once a day, and must not be folded into the roster fetch** (`availabilityIsFresh`/`fetchMflRosteredNames`). Widening the roster read cost enough rate limit to 429 the fetches behind it.
- **A finished `draftonly` league's roster is frozen** (`draftonlyRosterIsSettled`, `test-draftonly-freeze.mjs`). Only the roster block freezes; standings and scoring are fetched every sync, and the test reads the source to keep them ungated. A season rollover or `type` edit unfreezes; errored entries never freeze; `REFRESH_DRAFTONLY_ROSTERS` forces a read and stays separate from `REFRESH_AVAILABILITY`. A draft-only roster growing after its draft almost always means `draftInProgress` is still true — slow drafts run for days.
- **A league mid-draft is skipped and its `available` cleared** (`draftStatusFromResults`, `test-draft-status.mjs`). Zero picks means "couldn't tell"; every draft unit must be finished. **`TYPE=league`'s draft fields are settings, not state — don't try them again.** Sleeper answers from the league object; ESPN is exempt and unverified.
- **Every workflow that checks out uses `filter: blob:none` plus the same cone-mode sparse checkout** (`api scripts config data .github`). Reasoning and numbers are in `sync-fantasy-rosters.yml`. A shallow clone does not avoid downloading the ~121MB tip tree; copy the block into any new workflow.
- **Every `scripts/test-*.mjs` must be a step in `syntax-check.yml`**, enforced by its registration check. `test-set-lineup.mjs` is the one exception (it writes to MFL).
- **Manual workflows (`probe-*.yml`, `test-set-lineup.yml`, `test-login-endpoint.yml`) are `workflow_dispatch`-only — never add a `schedule`.** They exist because providers are unreachable from a sandbox; a new provider field starts with a probe, not with code assuming it exists.

### Rankings, projections and power

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

### The Analytics and Waivers cards

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

### History, placements and payouts

- **History is one Results card and one Finances card across all leagues, and renders logged out.** Editing a guessed finish is login-only (`buildResultRankCell`).
- **MFL final placement is derived from the brackets**; MFL standings are regular-season seeding (`computeMflSeasonPlacements`, `test-history.mjs`). List with `TYPE=playoffBrackets`, then `TYPE=playoffBracket` with **`BRACKET_ID`** — no other spelling works. ESPN uses `rankCalculatedFinal` (**never `rankFinal`**, an always-zero decoy). Sleeper is out of scope.
- **Bracket names are free text, classified by keyword** on both `name` and `bracketWinnerTitle` (`bracketFamily`/`isConsolationBracket`). A Toilet Bowl is not scored backwards. Unplaceable results fall back to regular-season order with `guessed: true`, rendered red.
- **Only `guessed: false` retires a year; a guess stays retry-eligible.** `fetchMflSeasonBracketData` rethrows on 429, and a 429 abandons the run's MFL backfill (`mflRateLimited`).
- **The backfill is a separate, budgeted, multi-sync cost.** `HISTORY_MFL_PER_LEAGUE_BUDGET` is lifted when `LEAGUE_ID` targets one league. `backfill-history.yml` and `backfill-scoring.yml` share the `rosters-data-write` concurrency group with the sync. `backfill-history.mjs` trusts the recorded season.
- **`historyLeagueIds` overrides `history.league[]` outright**, and override-covered years sort first in the backfill queue.
- **`draftonly` leagues rank by total points through week 17** (`computeMflSeasonPlacementsByPoints`) — never a guess, all-or-nothing per year, own budget (`HISTORY_MFL_DRAFTONLY_PER_LEAGUE_BUDGET`).
- **The weekly-high payout is awarded every week**: `results[].scoring` has `weeklyHighs` (weeks 1–18) and `seasonHigh`; season totals sum weeks 1–17. Both cutoffs are the manager's, not inferred. `leagueStandings.pf` is no shortcut.
- **Points in `results[].scoring` are rounded to two decimals** (`computeSeasonScoringRecords`) to kill float noise. Never round `salaryAdjustments` — that precision is real.
- **A franchise without a matchup is a flat entry under `weeklyResults.franchise`** (`parseMflWeekScores`, `test-weekly-scores.mjs`); reading only `.matchup` drops it.
- **Division Winner** comes free from `mflDivisionWinner` / ESPN `playoffSeed === 1`, and is unset for `draftonly`.
- **`startYear` is a floor on whose history it is**; `isBeforeStartYear` in the page is the authoritative gate.
- **The Results card averages `rank`, never the raw fraction**; rows are newest-first, leagues by best average.

### The page

- **A league's name is `leagueDisplayName(league)`, never `league.name`**, which is a placeholder like `ESPN League 1` for ESPN leagues. `nickname` is the short toolbar label, not the display name.
- **Admin tab layout**: fields are grouped by the subsystem that reads them (four `.admin-section` captions in `renderAdminCard`). Captions use `grid-column: 1 / -1`, never `span N` (implicit columns cause sideways scroll on phones); `.admin-field-mid` stays behind its `min-width: 40rem` query.
- **Unsaved-change tracking normalizes before comparing** (`adminComparable`/`adminPendingChanges`, `test-admin-dirty.mjs`), matching `mergeLeague`'s drop-empties rule. Save is never disabled on a zero count. Repaint via `refreshAdminDirtyState`, not a re-render, which steals focus.
- **The collapsed Admin row shows deviations, not defaults** — except Scoring, the money summary (always last, always present, em-dash for a missing place) and the season chip. The Leagues card's Save row is sticky (`.admin-sticky-actions`), Quick Links' isn't.
- **A field the current `type` can't use is hidden, never disabled or cleared**: commissioner contact (Salary Cap), cutdown size (Dynasty), division winner (not `draftonly`). `save-leagues.js` validates them by shape, not type.
- **The header login control always renders** — it is also how the Admin tab is reached.
- **The problems digest flags only what changes a decision; its failure mode is noise** (`computeLeagueProblems`/`computeProblemsDigest`, `test-problems-digest.mjs`). No scoring/standings/lineup errors (only roster `error`), no Questionable starters, one row per starter, "no lineup data" means not asked. Lineup rows wait for the weekly rollover cutoff; roster-limit rows don't and run before the lineup early return. **With nothing wrong, the strip is absent.**
- **Cut planning is Dynasty-only and `duringWeeks1Through17`**; `duringIrClearingWindow` adds IR. `cutdownRosterSize` is set by hand from league rules (not MFL's `rosterLimits.size`) and stored as a number. The Cut control is a dropdown because a mis-click is a real MFL write. `test-cut-planning-window.mjs`.
- **`submit-lineup.js` uses an allowlist**: `lineupPilot` set *and* provider MFL/unset. A new read-only provider must fail closed. **Do not invert this.**
- **The standings League/Division toggle appears only for a real split** (`withDivisions`, `buildLeagueStandingsDivisions`, `test-league-standings-divisions.mjs`). A league known to have divisions with no toggle means a field name is wrong.
- **The Scoring matchup drawer is live-only** (`appendMatchupDetail`/`pairStartersByPosition`, `test-scoring-details.mjs`). It costs no per-league requests; the player map (`loadPlayerMap`) is fetched once per poll *outside* the per-league fan-out — never inside. `stripScoringPlayers` keeps `players[]` out of the snapshot. Login-gated; none for a bye.
  - **Null points render as a dash, never `0.00`**; a real `0` stays `0`.
  - **Rows align by position, not slot**; the deeper side sets the row count, provider order within a group.
  - **Stat breakdowns** (`espnStatBreakdown`, `sleeperStatBreakdown`, `mflStatBreakdownFromBoxscore`; `test-stat-breakdown.mjs`, `test-mfl-boxscore-breakdown.mjs`). **MFL's terms forbid exposing raw stats and its API has none — read `mfl/README.md` before probing again.** MFL's breakdown joins ESPN's *public* boxscore against the league's own `TYPE=rules`, skill positions only, not reconciled to MFL's score. Unconfirmed categories are labelled; kicking/DST are left out.
  - **Names**: first initial (`abbreviatePlayerName`); a defense keeps its mascot, the last word (`isTeamDefense`).
  - **Game line** comes from the same scoreboard as the clocks (`fetchNflGames`/`gameClocksFromGames`): kickoff as ISO and formatted in the browser (Vercel is UTC), then ESPN's `shortDetail` verbatim. The schedule ships once per response as `games`, keyed under every alias (`NFL_TEAM_ALIASES`; **no `LA` alias**). `broadcast` is shown on NFL-tab rows.
  - **Column widths are measured**; the game line uses non-breaking spaces so only the space after the opponent breaks.
  - **Open state is in `localStorage` (stores *open*) because every poll rebuilds the cards.** The key includes franchise ids. Bodies fill lazily.
  - **Show bench** (`appendBenchDetail`) reuses the starter machinery with its own `:bench` key and no live flag. **MFL bench comes from `TYPE=liveScoring&DETAILS=1`** (`mflLiveStarters`/`mflNonstarterBench`); plain `liveScoring` has no nonstarters. **Never resurrect `playerScores&RULES=1` for bench points** — it reports 0 for players with real scores (`test-mfl-bench.mjs`, `mfl/README.md`).
  - **Polling backs off when nothing is live and pauses when the tab is hidden** (`nextLiveScoringDelayMs`, `scheduleLiveScoringPoll`, `liveScoringPollingEnabled`).
- **Best-ball leagues** (tag `BestBall`) project the best legal lineup over starters and bench (`bestBallProjection`, `bestBallLineupSpec`, `test-best-ball-win-prob.mjs`), live path only; a flex slot falls back.
- **The Game-Time Watchlist reads the snapshot's lineup, never the live poll's** (`computeGameTimeWatchlist`, `test-game-time-watchlist.mjs`, `myffl.html#watchlist`). Waits for the rollover cutoff. A designation is the practice report, not the inactive list — read `probe-inactives.mjs` RUN 1 first; a missing ESPN "Active" flag doesn't mean inactive. Backup picks (`watchlistBackupFor`, synced `backupPlans`) default to the best-ECR healthy same-position bench player, shown but not saved; `'none'` means deliberately none.
- **`api/game-time-check.js` never says "playing" without evidence** (`api/_lib/gametime.mjs`, `test-game-time-check.mjs`): inactive if any feed says out; playing only on ESPN Active or a posted list without him. It records what it sent per kickoff and notifies only on change, but the first look at a slot always sends, so silence means broken. `resolveBackup` duplicates `watchlistBackupFor` (pinned against it). Bodies are capped at Pushover's 1024 characters.
- **`api/weekly-results.js` takes the finished week from the calendar** (`finishedWeek`, `test-weekly-results.mjs`) and asks each provider for it by number. Tue/Wed only unless `?week=`. An unreadable league is listed, never dropped; a bye is "no game", not a tie. `weeklyMedianGame` adds `medianResult`. Records come from a fresh standings read that MFL may not have processed yet, so keep its cron mid-morning Eastern. Both cron endpoints are driven by cron-job.org with `GAMETIME_CHECK_SECRET`.
- **The Scoring tab excludes `draftonly` leagues**, including server-side in `hasLiveScoring`.
- **ESPN's and Sleeper's "current week" are trusted blind** — they advance before kickoff. Holding them back was considered and declined; see `fetchEspnScoring`'s comment before revisiting.
- **The NFL tab is ungated real NFL data** (`test-nfl-tab.mjs`, `VIEW_LABELS`).
  - Depth Charts nest in one wrapper (`renderDepthChartCards`, `data-depth-charts-wrap`) that `updateVisibility`'s per-card branches must skip. Its pills and the *same* re-parented `.search-wrap` live inside it (`relocateSearchControls`); `renderGrid` must rescue the search box before its `innerHTML` wipe.
  - `buildNflGamesList` collapses aliased `liveGames` back to one row per event id. Now Playing is today in local time (`isGameToday`); no score pre-kickoff.
  - The Stats drawer is player-only (`appendNflBoxscoreToggle`, `nflBoxscorePlayerLines`), fetched only when open; `fillNflBoxscoreBody` keeps pre-kickoff / not-answered / empty apart. `BOXSCORE_EXCLUDED_LABELS` drops by label, and stats are positional.
  - The Standings card reads snapshot `nflStandings` (`fetchNflStandings`, `test-nfl-standings.mjs`), is excluded from `rerenderNflCards` like Depth Charts, and ranks conferences by `seed` first.
  - Rostered players' rows are purple and login-gated via `nflBoxscoreOwnership`, which returns an empty `Map` logged out.
- **Sorting is one `makeTableSort`**: natural → reverse → default, ties keep the default order, `missingLast` holds in both directions, never persisted.
- **Popovers are one `makePopover`** with separate instances. **Position before showing**, or the first click fires its own scroll-dismiss.

### Auth, plans and writes

- **Auth is stateless.** `api/login.js` checks `SITE_PASSWORD` and returns an HMAC-signed 30-day token (`api/_lib/auth.mjs`) used as a Bearer token. MFL credentials never reach the browser. **Failed logins are rate-limited per IP and globally in the Upstash store, and the check fails open if the store is down** (`test-api-rate-limits.mjs`) — don't make it fail closed.
- **Plans sync through `api/plans.js` (Upstash over REST with plain `fetch`, not the `redis://` marketplace store).** View, sub-tab and token stay device-local.
- **A merge is a union and can't express a deletion.** A device merges once (`myfflPlanSynced`) and plain-GETs afterwards; `myfflPlanPending` carries `''` tombstones. Two-device behaviour is only visible in `test-plan-sync.mjs`.
- **The login gate on Analytics, Admin, the ECR column, lineup checkboxes and the sync button is intended — keep it, and gate any new card reading roster, ranking, finance or lineup data.** It deters a league mate opening the URL, nothing more: the same data is public in `config/leagues.json` and `data/rosters.json`. Don't file that as a bug, and don't put anything genuinely sensitive behind the gate alone. History is deliberately ungated.
- **Plans are the exception**: strategy about other people's leagues goes to Upstash, never the repo. That is the whole privacy model.

## Where the reasoning lives

| Subsystem | Read |
| --- | --- |
| Provider quirks, XML shapes, rate limits | `scripts/lib/providers.mjs` |
| Rankings, projections, power, sleepers | `scripts/lib/fantasypros.mjs` |
| Brackets, placements | `scripts/lib/history.mjs` (and `scripts/probe-league-history.mjs`) |
| Orchestration, budgets, backfills, seasons | `scripts/fetch-rosters.mjs` |
| Config schema / validation | `config/leagues.json` `_readme` / `api/save-leagues.js` |
| What a provider actually returns | the matching `scripts/probe-*.mjs` header |
| MFL's own limits and the bench-points history | `mfl/README.md` |
| Anything on screen | `myffl.html`, at the `render*` function |

## Verifying changes

**`myfantasyleague.com` and `api.sleeper.app` are unreachable from a cloud sandbox** (`api.github.com` works), so verify against real providers by dispatching a workflow (`sync-fantasy-rosters.yml`, `test-login-endpoint.yml`, a probe).

```bash
node --check scripts/fetch-rosters.mjs
for f in scripts/test-*.mjs; do node "$f"; done   # skip test-set-lineup.mjs (real MFL write)
python3 -m http.server 8000                        # open /myffl.html; file:// can't fetch data/
```

The committed snapshot is real, so the page renders offline. To see logged-in UI, set `localStorage.setItem('mflAuthToken', 'anything')` before loading. For a headless browser, Chromium is installed; add Playwright with `--no-save` and delete `node_modules` afterwards.

## Working through the Tasks card

The manager files work for Claude in the Tasks card (`renderTasksCard`).

- **Fetch it with `scripts/fetch-tasks.mjs`** (needs `SITE_PASSWORD`), or dispatch `fetch-tasks.yml` when the sandbox can't reach Vercel — don't ask the user to paste it.
- **Only act on `Bugs` and `Site Enhancement`.** Other categories are the manager's own.
- **Once merged, mark done with `scripts/mark-tasks-done.mjs` / `mark-tasks-done.yml`**, matched by exact `text`. It must POST `mode: 'replace'` after re-fetching the whole document, because `merge` lets the stored copy win.

## Front-end conventions

`myffl.html` is one ~17,000-line file of vanilla JS, CSS and markup with no framework or bundler; keep it that way, since that is what lets Pages serve it directly. Cards are built by `render*Card` functions; tabs and sub-tab pills are derived at render time from the cards present (`data-league-type`), which is why logging out removes the Analytics and Admin tabs for free.

- Shared: `appendAnalyticsTable` (paginated tables), `makeTableSort`, `makePopover`, `.popover` CSS. Content stays at the call site.
- Not shared: two features sharing a visual form get separate classes (`.results-*` vs `.finances-*`).
- A clickable number that opens a popover is an idiom: `.salary-link`, `.needs-link`, `.starters-link`, `.finances-link`.
- Colour: `--accent` purple = notable; gold = taxi squad, with `--gold-chip-text` (not `--gold-text`, which vanishes in dark mode); `--ir-text` red = needs a look.
