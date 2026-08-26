#!/usr/bin/env node
// Pulls rosters/standings/scoring for every league in config/leagues.json —
// from MFL (login + session cookie), ESPN (espn_s2/SWID cookies), and/or
// Sleeper (fully public API, no auth) — and writes it all into one
// consolidated data/rosters.json for myffl.html to render.
//
// Requires MFL_USERNAME and MFL_PASSWORD env vars (set as GitHub Actions secrets).
// ESPN leagues additionally require ESPN_S2 and ESPN_SWID env vars; leagues
// without a provider are assumed to be 'mfl'. Sleeper leagues need nothing
// extra — no login, cookies, or API key.
//
// Fetch logic lives in scripts/lib/providers.mjs, shared with the live-scoring
// Vercel function in api/live-scoring.js — this file is just orchestration.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  leagueUrl,
  mflLogin,
  loadPlayerMap,
  fetchNflByeWeeks,
  fetchMflInjuries,
  fetchLeagueRoster,
  fetchStandings,
  fetchScoring,
  fetchMflLineup,
  fetchSleeperLineup,
  fetchEspnLeagueRoster,
  fetchEspnStandings,
  fetchEspnScoring,
  loadSleeperPlayerMap,
  fetchSleeperLeagueRoster,
  fetchSleeperStandings,
  fetchSleeperScoring,
  mflLeagueExists,
  espnLeagueExists,
  detectScoringFormat,
  fetchMflRosteredNames,
  fetchEspnRosteredNames,
  fetchMflDraftStatus,
  fetchMflLeagueHistory,
  fetchMflSeasonBracketData,
  fetchEspnSeasonTeams,
  fetchMflSeasonMeta,
  fetchMflWeekScores,
} from './lib/providers.mjs';
import {
  attachRankings,
  attachSleepers,
  fantasyProsApiKey,
  nflSeasonPhase,
  normalizePlayerName,
  fetchProjections,
  buildEcrIndex,
  computeLeaguePower,
  rankingSpecForLeague,
  rankingPoolKey,
  DEFAULT_POWER_SLOTS,
} from './lib/fantasypros.mjs';
import {
  computeMflSeasonPlacements,
  computeMflSeasonPlacementsByPoints,
  espnSeasonPlacement,
  computeSeasonScoringRecords,
  mflDivisionWinner,
  espnDivisionWinner,
} from './lib/history.mjs';

const USERNAME = process.env.MFL_USERNAME;
const PASSWORD = process.env.MFL_PASSWORD;
const OUTPUT_PATH = fileURLToPath(new URL('../data/rosters.json', import.meta.url));
const CONFIG_PATH = fileURLToPath(new URL('../config/leagues.json', import.meta.url));

// League/franchise IDs live in config/leagues.json, not here — edit that file
// each offseason instead of this script. See its _readme field for the schema.
async function loadLeagueConfig() {
  const raw = await readFile(CONFIG_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.leagues) || parsed.leagues.length === 0) {
    throw new Error(`${CONFIG_PATH} has no leagues configured`);
  }
  return parsed.leagues;
}

async function loadPreviousOutput() {
  try {
    const raw = await readFile(OUTPUT_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Carries MFL's injury detail (body part, expected return) onto the rosters
// that can't reach it by MFL player id — every ESPN and Sleeper league.
//
// MFL's TYPE=injuries is a plain NFL fact rather than a league one: it takes no
// league parameter and covers the whole league-eligible player pool, which is
// why one global report can serve rosters held on other sites at all. The join
// has to be by name, and this is the only place both halves exist — the id-to-
// name map is MFL's, `normalizePlayerName` is fantasypros.mjs's, and
// providers.mjs deliberately imports neither (api/ imports providers.mjs, and
// vercel.json's ignoreCommand doesn't list fantasypros.mjs, so a dependency
// added there would silently skip Vercel deploys that need to ship).
//
// Two properties are load-bearing:
//
// It only ever *fills in* a detail, never replaces one. An MFL-rostered player
// already carries the exact by-id answer from fetchLeagueRoster, and a name is
// the weaker key — two players who share one collide here the same way they
// would in a FantasyPros slug (josh-allen the quarterback, josh-allen-lb the
// linebacker), so where an id has already spoken, the name is not consulted.
//
// It attaches nothing to a player the page doesn't already consider injured.
// The detail is an annotation on a designation, not a designation of its own:
// MFL carrying a stale row about somebody ESPN says is healthy must not put him
// on the Injury Exposure card, which reads `injuryStatus`/the IR slot alone.
export function attachInjuryDetail(leagues, injuries, playerMap) {
  if (!injuries?.size || !playerMap?.size) return 0;
  const byName = new Map();
  for (const [id, entry] of injuries) {
    if (!entry?.detail) continue;
    const key = normalizePlayerName(playerMap.get(id)?.name);
    if (key && !byName.has(key)) byName.set(key, entry.detail);
  }

  let filled = 0;
  for (const league of leagues) {
    for (const player of league.players || []) {
      if (player.injuryDetail || !player.injuryStatus) continue;
      const detail = byName.get(normalizePlayerName(player.name));
      if (!detail) continue;
      player.injuryDetail = detail;
      filled++;
    }
  }
  return filled;
}

// How stale a league's free agent list may get before the next sync re-reads
// the whole league's rosters. Twenty hours rather than twenty-four, and that
// is the whole point of the number: the sync runs every four hours, so an
// exactly-24h rule would be missed by seconds by the run that lands a day
// later and satisfied by the one after it, walking the daily read four hours
// further into the day every day until it wrapped. Anything comfortably under
// 24 pins it to one read per calendar day at a stable hour.
const AVAILABILITY_MAX_AGE_MS = 20 * 60 * 60 * 1000;

// Whether a league's recorded free agent list is still current enough to keep
// instead of re-reading every franchise's roster.
//
// Three ways to be due, and the second two matter as much as the first: a
// league that has never been read has nothing to keep, and a league whose last
// read *failed* carries `available: null` and so is retried on the very next
// sync rather than waiting out a day — the same reasoning as the season
// resolver re-probing a league that errored. That is what keeps a 429 during
// the daily pass from stranding one league's list for a full day, and it
// self-heals without anything having to notice.
export function availabilityIsFresh(previous, now, force = false) {
  if (force) return false;
  if (!Array.isArray(previous?.available)) return false;
  const readAt = Date.parse(previous.availableAt ?? '');
  if (!Number.isFinite(readAt)) return false;
  return now.getTime() - readAt < AVAILABILITY_MAX_AGE_MS;
}

// Whether a league's draft is already known to have finished, in which case
// this sync needn't ask again.
//
// The invariant that makes this safe: a finished draft never unfinishes. Once
// MFL has reported every pick made for a league in a season, that answer holds
// for the rest of the season, so the check can run on *every* sync while
// costing a request only for leagues that haven't finished yet — in the
// steady state, none of them.
//
// Which is what closes the gap the once-a-day version had. The draft check
// used to sit behind the availability freshness rule, so a league that started
// drafting just after its daily read kept serving a stale pre-draft wire for
// up to twenty hours. Checking first would have meant sixteen requests every
// sync instead of sixteen a day; checking first *and* skipping settled leagues
// means roughly zero, and the answer is never more than four hours old.
//
// Keyed to the season for the same reason `scoringDetected` is: a league that
// has rolled over has a new draft to run, and last season's answer says
// nothing about it. Anything other than a definite `false` — never checked, a
// failed check, or a draft in progress — is asked again.
export function draftIsSettled(previous, season, force = false) {
  if (force) return false;
  if (previous?.draftInProgress !== false) return false;
  return String(previous.season ?? '') === String(season ?? '');
}

// The manual override, wired to the workflow's refresh_availability input, for
// when you want today's free agents now rather than at the next daily read.
// Absent on a scheduled run, which is how the daily rule stays the default.
const forceAvailability = /^(true|1)$/i.test(process.env.REFRESH_AVAILABILITY || '');

// How far back to look when a league has no known-good season to fall back on.
// Two seasons covers a league whose new site isn't up yet, and one that missed a
// year entirely; further back than that is a stale config, not a rollover.
const SEASON_LOOKBACK = 2;

// Which season each league is actually read from, resolved per league rather
// than taken from the calendar.
//
// The problem this solves: leagues don't roll over together. An MFL commissioner
// might create the new season in February or in April, entirely at their own
// pace, and a redraft league on ESPN or Sleeper later still. A single global
// year is therefore wrong for somebody for months, and the failure is quiet —
// every card falls back to its previous entry and shows a stale roster.
//
// So: aim at the current NFL season, and only move a league there once that
// season actually exists for it.
//
//   - Settled on the target      -> use it, no probe. The common case, and it
//                                   costs nothing all season long.
//   - Pinned in config           -> use the pin, no probe. Manual override.
//   - Target exists              -> move there.
//   - Target definitively absent -> fall back: to the last known-good season if
//                                   there is one, otherwise walk backwards
//                                   until a season answers.
//   - Couldn't tell              -> change nothing and try again next sync.
//
// "Settled" means the league is recorded against a season AND fetched cleanly
// on it. A league carrying an error is exactly the one worth re-asking, because
// sitting on a season that was never really there looks precisely like that —
// which is also what stops a bad answer from becoming permanent, since the
// recorded season alone would otherwise short-circuit the probe forever.
//
// Movement is one-way past a known-good season: the walk-back only runs when
// there is nothing good to fall back to, so a rolled-over league can never be
// dragged into a finished season.
export async function resolveSeason(league, previous, target, probes) {
  // An explicit season in config/leagues.json pins the league and opts it out
  // of probing entirely, the same way rankingType opts out of the seasonal
  // ranking flip.
  if (league.season) return { season: String(league.season), pinned: true };

  const last = previous?.season ? String(previous.season) : null;
  const settled = Boolean(last) && !previous?.error;
  if (settled && last === String(target)) return { season: last, rolledOver: false };

  // Strictly one-way. If a league is already ahead of the target it stays
  // there, without asking. Last season still exists at the provider and would
  // answer a probe perfectly happily, so relying on the probe to refuse would
  // mean a league that had already rolled over could be pulled back into a
  // finished season — and that failure is silent, since stale rosters render
  // exactly like fresh ones.
  if (last && Number(last) > Number(target)) return { season: last, ahead: true };

  // Sleeper can't be probed — a new season is a new league id there and the
  // old id answers forever — so it simply follows whatever id is configured.
  if (league.provider === 'sleeper') return { season: String(target), rolledOver: false };

  const probe = league.provider === 'espn' ? probes.espn : probes.mfl;

  const exists = await probe(league, String(target));
  if (exists === true) {
    return { season: String(target), rolledOver: Boolean(last) && last !== String(target) };
  }
  // null, not false: the provider didn't answer, so nothing is known and
  // nothing should move. Falling back here would act on a hiccup.
  if (exists === null) return { season: last || String(target), probeFailed: true };

  // Definitively absent. A known-good season is the best answer available.
  if (settled) return { season: last, waiting: true };

  // Nothing known-good to sit on — a league on its first sync, or one whose
  // recorded season never actually worked. Walk backwards until one answers,
  // which is how a league whose new site isn't up yet lands on the season it
  // was really last played in rather than an empty one.
  for (let season = Number(target) - 1; season >= Number(target) - SEASON_LOOKBACK; season--) {
    const back = await probe(league, String(season));
    if (back === true) return { season: String(season), fellBack: true };
    // Stop on an unknown rather than reading it as another absence.
    if (back === null) return { season: last || String(target), probeFailed: true };
  }
  return { season: String(target), unresolved: true };
}

// ---- History tab: one-time backfill of past-season final placement --------
// See scripts/lib/history.mjs for the derivation itself. This is explicitly
// a backfill, not a per-sync fetch: once a season is over its placement
// never changes, so a year recorded in `results` is never re-fetched, and a
// league whose full history is already captured costs nothing on every sync
// after that. Deliberately budget-limited and run last, after every
// season-critical fetch above — this is bonus historical data, and must
// never compete with rosters/standings/scoring for MFL's rate limit. A
// large league's full history (MNMx Dynasty goes back to 2006) is expected
// to take several syncs to fully backfill; that is the intended shape, not
// a bug to fix by raising the budget.
const HISTORY_MFL_REQUEST_BUDGET = 24;
const HISTORY_ESPN_REQUEST_BUDGET = 8;
// A cap on how much of the RUN's budget any single MFL league can spend,
// enforced alongside HISTORY_MFL_REQUEST_BUDGET rather than instead of it.
// Without this, a league with a long tail of still-guessed years (the
// common shape now that a guess stays eligible for retry — see
// yearsNeedingHistoryBackfill) sits first in iteration order and can
// legitimately spend the entire run's budget on itself before any other
// league gets a single request, run after run. Confirmed live: a real run
// spent its whole 24-request budget re-backfilling one league's remaining
// guessed years and never reached the other fourteen. This doesn't fix that
// league's own backfill speed — it still needs the same number of runs to
// fully clear — it only stops it from starving every league behind it.
const HISTORY_MFL_PER_LEAGUE_BUDGET = 8;
// A draftonly-type league's placement isn't a bracket walk at all (see
// computeMflSeasonPlacementsByPoints in scripts/lib/history.mjs) — it costs
// one TYPE=league request plus one TYPE=weeklyResults request PER WEEK
// through week 17, up to 18 requests for a single year, which
// HISTORY_MFL_PER_LEAGUE_BUDGET (8) can never cover even once. Without a
// bigger allowance a draftonly league would spend its whole per-league
// budget fetching a handful of weeks, hit the wall, and (by the same
// all-or-nothing discipline fetchMflSeasonBracketData's caller already
// applies) discard that partial year and retry from week 1 next run —
// forever, never completing a single season. Sized to comfortably cover one
// season (18) with a little room to spare, not to cover a league's whole
// back catalog in one run — same "several runs to fully backfill" shape
// every other league here already has.
const HISTORY_MFL_DRAFTONLY_PER_LEAGUE_BUDGET = 20;
// MFL answers "how far back does this go" from its own history.league[]
// field (see fetchMflLeagueHistory) — always exact, never a guess. ESPN has
// no equivalent, so this is a cap on how far back it's ever walked, not a
// real boundary: a league founded earlier than this simply won't get years
// before it until the cap is widened.
const ESPN_HISTORY_LOOKBACK_YEARS = 15;

// Pure and budget-agnostic: which of a league's known past seasons still
// need a placement fetched. The current/active season is always excluded —
// its bracket hasn't been decided yet, and fetching it would either fail or
// (worse) compute a "final" placement from a still-in-progress bracket.
// Sorted most-recent-first, so a budget that can't cover a league's entire
// history in one run fills in from the present backward — the years a
// manager is most likely to ask about — rather than from whichever end an
// unordered scan happened to start.
//
// Only a *confirmed* (`guessed: false`) result counts as "already have it."
// A `guessed: true` entry can be the honest gap-filling fallback described in
// computeMflSeasonPlacements, but it can equally be the residue of a bracket
// fetch that got 429'd mid-year — MFL is already near its rate limit by the
// time this backfill pass runs, right after the main sync's own roster/
// standings/scoring/lineup requests, so a real 429 here isn't rare. Treating
// every guessed year as permanently resolved would bake a rate-limit blip in
// forever, since "a season once recorded is never re-fetched" is the whole
// point of this backfill. Leaving guessed years eligible for retry costs
// nothing once a league's real answer has been found (a confirmed result
// still blocks retry), and lets a bad guess correct itself the next time
// MFL has budget to spare.
//
// `startYear` (from config/leagues.json's own per-league field, blank by
// default) is a manager-declared floor — "I didn't join this league until
// this season" — for a league whose real MFL/ESPN history predates the
// user's own membership. A year that predates it is never worth fetching:
// the franchise id this backfill fetches under belonged to somebody else
// back then, so the placement it would compute is a real answer about the
// wrong manager, not a gap to fill. Optional and undefined by default so
// every existing call site (and every league without one set) keeps
// backfilling its full known history exactly as before.
//
// One deliberate exception to "confirmed is permanent": `divisionWinnerFranchiseId`
// was added to this same entry shape well after most leagues' history was
// already confirmed (see the "Division Winner" payout in CLAUDE.md), so a
// confirmed year missing it isn't a gap the normal retry rule was ever
// meant to catch — without this, most of a league's real history would
// simply never get the field, since a confirmed rank is otherwise never
// re-fetched. `leagueType` gates it: a `draftonly` league never fetches a
// regular-season order at all (computeMflSeasonPlacementsByPoints), so
// treating a missing field as a gap there would retry every single year
// forever rather than just the ones genuinely missing something. Once a
// year IS re-fetched through this path, `divisionWinnerFranchiseId` is
// always set (it rides the same regularSeasonOrder that had to be
// non-empty for `rank` to have been computed at all — see
// fetchMflSeasonBracketData), so this never becomes a permanent retry loop
// of its own.
export function yearsNeedingHistoryBackfill(historyYears, existingResults, currentSeason, startYear, leagueType) {
  const canBackfillDivisionWinner = leagueType !== 'draftonly';
  const haveYears = new Set(
    (existingResults || [])
      .filter((r) => r.guessed === false)
      .filter((r) => !canBackfillDivisionWinner || r.divisionWinnerFranchiseId != null)
      .map((r) => String(r.year))
  );
  return (historyYears || [])
    .filter((h) => Number(h.year) < Number(currentSeason))
    .filter((h) => startYear == null || startYear === '' || Number(h.year) >= Number(startYear))
    .filter((h) => !haveYears.has(String(h.year)))
    .sort((a, b) => Number(b.year) - Number(a.year));
}

// Exported so backfill-history.mjs — the on-demand, standalone companion to
// this pass (see that file's header) — can invoke exactly this logic with
// its own uncontested cookie and budget, instead of duplicating it.
export async function backfillLeagueHistory(leagues, previousById, cookie) {
  let mflBudget = HISTORY_MFL_REQUEST_BUDGET;
  let espnBudget = HISTORY_ESPN_REQUEST_BUDGET;
  let yearsAdded = 0;
  let leaguesTouched = 0;
  // The per-league cap exists to stop one league from starving every OTHER
  // league's turn (see HISTORY_MFL_PER_LEAGUE_BUDGET above) — it has nothing
  // to protect when `leagues` names exactly one league, which is exactly
  // what backfill-history.mjs's LEAGUE_ID targeting produces. Confirmed live:
  // a genuinely unresolvable bracket gap (two-plus leftover teams with no
  // consolation game to place them — see computeMflSeasonPlacements) never
  // confirms and so is retried every run, permanently occupying the front of
  // that one league's queue; capped at 8, a LEAGUE_ID-targeted run could
  // never get past it to reach an older year sitting right behind it. With
  // only one league in play, handing it the whole run's budget is free.
  const perLeagueMflBudget = leagues.length === 1 ? HISTORY_MFL_REQUEST_BUDGET : HISTORY_MFL_PER_LEAGUE_BUDGET;
  // A confirmed 429 means MFL is rate-limited for the rest of this run, not
  // just for the request that hit it — every other MFL call in this pass is
  // equally likely to fail. Once one lands, stop spending the remaining MFL
  // budget on requests that would just add to the same pile (this is what let
  // one real run's log spend 27 requests against a budget of 24). The
  // providers.mjs re-throw is what makes this observable at all; without it
  // a 429 here looked identical to "this bracket doesn't exist."
  let mflRateLimited = false;

  for (const league of leagues) {
    const prev = previousById.get(league.id);
    league.results = prev?.results ? prev.results.map((r) => ({ ...r })) : [];
    if (prev?.historyBoundaryYear) league.historyBoundaryYear = prev.historyBoundaryYear;

    if (league.provider === 'sleeper') continue; // out of scope for now
    if (!league.franchiseId) continue; // nothing to match a placement against, ever

    if (league.provider === 'espn') {
      if (espnBudget <= 0) continue;
      // No history list to ask for, unlike MFL — walk backward from the
      // known boundary (a confirmed absence from a previous run) or the
      // lookback cap on a first attempt, stopping the moment budget runs
      // out or a definitive absence narrows the boundary further. Anchored
      // to this league's OWN resolved season, not the sync's global target
      // — a trailing league's currently-active season is still in progress
      // and must never be treated as a completed year to backfill. Also
      // never walks earlier than the league's own `startYear`, if the
      // manager has set one — see yearsNeedingHistoryBackfill's own comment
      // for why a year before that is never worth fetching at all.
      const haveYears = new Set(league.results.map((r) => Number(r.year)));
      const floor = Math.max(
        league.historyBoundaryYear
          ? Number(league.historyBoundaryYear)
          : Number(league.season) - ESPN_HISTORY_LOOKBACK_YEARS,
        league.startYear ? Number(league.startYear) : -Infinity
      );
      for (let year = Number(league.season) - 1; year >= floor && espnBudget > 0; year--) {
        if (haveYears.has(year)) continue;
        try {
          espnBudget--;
          const exists = await espnLeagueExists({ id: league.id, provider: 'espn' }, String(year));
          if (exists === false) {
            // A definitive absence — remember it so future syncs never
            // re-probe a year this league is now known not to reach.
            league.historyBoundaryYear = String(year + 1);
            break;
          }
          if (exists === null) break; // couldn't tell — stop, retry next sync
          espnBudget--;
          const teams = await fetchEspnSeasonTeams(league, String(year));
          const mine = teams.find((t) => String(t.id) === String(league.franchiseId));
          const placement = mine ? espnSeasonPlacement(mine, teams.length) : null;
          if (placement) {
            const entry = { year: String(year), ...placement };
            const divisionWinnerFranchiseId = espnDivisionWinner(teams);
            if (divisionWinnerFranchiseId) entry.divisionWinnerFranchiseId = divisionWinnerFranchiseId;
            league.results.push(entry);
            yearsAdded++;
            leaguesTouched++;
          }
        } catch (err) {
          console.error(`History backfill failed for ${league.name} (${year}): ${err.message}`);
          break;
        }
      }
      continue;
    }

    // MFL
    if (mflBudget <= 0 || mflRateLimited) continue;
    // Draftonly leagues cost far more per year than a bracket walk does
    // (see HISTORY_MFL_DRAFTONLY_PER_LEAGUE_BUDGET) — Math.max rather than a
    // straight override so the existing single-league full-budget case
    // (perLeagueMflBudget already 24 there) is never shrunk back down to 20.
    let leagueMflBudget = league.type === 'draftonly'
      ? Math.max(perLeagueMflBudget, HISTORY_MFL_DRAFTONLY_PER_LEAGUE_BUDGET)
      : perLeagueMflBudget;
    let historyYears;
    try {
      historyYears = await fetchMflLeagueHistory(league, cookie, league.season);
      mflBudget--;
      leagueMflBudget--;
    } catch (err) {
      if (err.status === 429) mflRateLimited = true;
      console.error(`Failed to fetch league history for ${league.name}: ${err.message}`);
      continue;
    }
    const missing = yearsNeedingHistoryBackfill(historyYears, league.results, league.season, league.startYear, league.type);
    for (const { year, id } of missing) {
      if (mflBudget <= 0 || mflRateLimited || leagueMflBudget <= 0) break;
      try {
        let mine;
        // Only the bracket path (below) ever fetches a regular-season order
        // to read a "division winner" off — draftonly leagues rank by total
        // points and never fetch leagueStandings at all, so this stays null
        // for them, same as any other award that doesn't apply.
        let divisionWinnerFranchiseId = null;
        if (league.type === 'draftonly') {
          // No bracket to walk at all — see computeMflSeasonPlacementsByPoints
          // in scripts/lib/history.mjs. `nameById`'s keys are that season's
          // own franchise ids, the same role fetchMflSeasonBracketData's
          // leagueStandings read fills for the bracket path, at no extra
          // request since fetchMflSeasonMeta already fetches TYPE=league for
          // endWeek/nameById.
          const { endWeek, nameById } = await fetchMflSeasonMeta(id, cookie, year);
          mflBudget -= 1;
          leagueMflBudget -= 1;
          const leagueFranchiseIds = [...nameById.keys()];
          if (leagueFranchiseIds.length === 0) continue; // try again next sync

          // Through week 17, same cutoff and reasoning as the season-total
          // high-score award (SEASON_HIGH_SCORE_WEEKS below) — capped by the
          // season's own endWeek for the rare season that never reached it.
          const weeksToFetch = Number.isFinite(endWeek) && endWeek > 0
            ? Math.min(SEASON_HIGH_SCORE_WEEKS, endWeek)
            : SEASON_HIGH_SCORE_WEEKS;

          // Every week has to succeed for this year to be recorded — a
          // placement computed from a partial set of weeks would misrank
          // whoever it happened to miss, which is worse than retrying the
          // whole year next run. Same all-or-nothing discipline
          // backfillLeagueScoringRecords already applies to this identical
          // per-week fetch.
          const weeklyScoresByWeek = new Map();
          let weeksOk = true;
          for (let week = 1; week <= weeksToFetch; week++) {
            if (mflBudget <= 0 || leagueMflBudget <= 0) { weeksOk = false; break; }
            try {
              const totals = await fetchMflWeekScores(id, cookie, year, week);
              mflBudget--;
              leagueMflBudget--;
              weeklyScoresByWeek.set(week, totals);
            } catch (err) {
              if (err.status === 429) mflRateLimited = true;
              weeksOk = false;
              break;
            }
          }
          if (!weeksOk || weeklyScoresByWeek.size !== weeksToFetch) continue; // retry the whole year next run

          const placements = computeMflSeasonPlacementsByPoints(leagueFranchiseIds, weeklyScoresByWeek, weeksToFetch);
          mine = placements.find((p) => p.franchiseId === league.franchiseId);
        } else {
          const { leagueFranchiseIds, regularSeasonOrder, brackets, bracketDataById } =
            await fetchMflSeasonBracketData(id, cookie, year);
          // Two calls up front (standings, the bracket listing) plus one per
          // bracket actually fetched — an honest count of what this year just
          // spent, so a deep-bracket league can't quietly blow the budget in
          // one iteration.
          const spent = 2 + bracketDataById.size;
          mflBudget -= spent;
          leagueMflBudget -= spent;
          if (leagueFranchiseIds.length === 0) continue; // try again next sync
          const placements = computeMflSeasonPlacements({
            leagueFranchiseIds,
            brackets,
            bracketDataById,
            regularSeasonOrder,
          });
          mine = placements.find((p) => p.franchiseId === league.franchiseId);
          divisionWinnerFranchiseId = mflDivisionWinner(regularSeasonOrder);
        }
        if (mine && mine.rank != null) {
          // A retried year may already carry a guessed entry from a prior
          // run (see yearsNeedingHistoryBackfill) — replace it rather than
          // pushing a duplicate, whether this attempt confirms it or not.
          // That entry may also already carry a `scoring` field from the
          // separate weekly-high-score backfill (backfillLeagueScoringRecords
          // below) — a placement re-fetch has nothing to say about that, so
          // it has to be carried forward explicitly or a guessed year that
          // gets reconfirmed the same run its scoring was backfilled would
          // silently lose that scoring data again.
          const existing = league.results.find((r) => String(r.year) === String(year));
          league.results = league.results.filter((r) => String(r.year) !== String(year));
          const entry = { year, rank: mine.rank, total: mine.total, guessed: mine.guessed };
          if (divisionWinnerFranchiseId) entry.divisionWinnerFranchiseId = divisionWinnerFranchiseId;
          if (existing?.scoring) entry.scoring = existing.scoring;
          league.results.push(entry);
          yearsAdded++;
          leaguesTouched++;
        }
      } catch (err) {
        if (err.status === 429) mflRateLimited = true;
        console.error(`History backfill failed for ${league.name} (${year}): ${err.message}`);
      }
    }
  }

  for (const league of leagues) {
    if (Array.isArray(league.results)) {
      league.results.sort((a, b) => Number(a.year) - Number(b.year));
    }
  }

  console.log(
    `History backfill: added ${yearsAdded} season(s) across ${leaguesTouched} league update(s) `
    + `(MFL budget ${HISTORY_MFL_REQUEST_BUDGET - mflBudget}/${HISTORY_MFL_REQUEST_BUDGET}, `
    + `ESPN budget ${HISTORY_ESPN_REQUEST_BUDGET - espnBudget}/${HISTORY_ESPN_REQUEST_BUDGET})`
    + (mflRateLimited ? ' — stopped early on a 429, remaining leagues retry next sync' : '')
  );
}

// ---- History tab: one-time backfill of weekly/season high-score payouts ---
// A second, separate backfill pass from backfillLeagueHistory above, kept on
// its own budget rather than sharing HISTORY_MFL_REQUEST_BUDGET: a season's
// placement costs roughly 2 + (a few brackets) MFL requests, but its
// weekly/season point totals need one request PER week fetched — there is no
// bulk endpoint — which is up to WEEKLY_HIGH_SCORE_WEEKS (18) requests for a
// typical season, enough on its own to blow past HISTORY_MFL_PER_LEAGUE_BUDGET
// and starve the placement backfill of its own leagues if the two shared a
// pool.
//
// The fetch window is a fixed weeks 1-18, not the league's own regular
// season (`lastRegularSeasonWeek`, e.g. 14 for a 10-team league running a
// 4-week playoff bracket) — confirmed live via probe-weekly-scores.yml that
// these payouts are meant to cover the whole fantasy season a league
// actually plays, brackets included, not just the H2H standings portion of
// it: a last-place team eliminated week 1 of the playoffs can still have
// banked a weekly-high win, and several real leagues here run their bracket
// through week 17 or later. The weekly-high and season-total halves are two
// DIFFERENT KINDS of award, not two versions of the same one (confirmed
// directly with the user after an earlier version of this got it wrong):
// weekly-high is awarded fresh every week — week 1's top scorer wins it,
// then week 2's top scorer wins it again independently, all the way through
// week 18, so a single season can pay it out up to 18 times — while
// season-total is a single once-a-season award that only ever sums weeks
// 1-`SEASON_HIGH_SCORE_WEEKS` (17), so week 18 has its own weekly winner but
// never contributes to the season sum. This also rules out leagueStandings'
// `pf` as a shortcut for the season-total number
// (it was seriously considered — `pf` is already fetched for free during
// placement backfill): probe-weekly-scores.yml showed `pf` running well
// above even just the weeks-1-14 regular-season sum for every franchise in
// a real league (e.g. one franchise: 1960.10 summed vs. 2424.00 on `pf`),
// meaning it folds in playoff weeks with no fixed cutoff this feature could
// rely on — so the season-total number is always summed from weeks fetched
// here, never read off `pf`.
//
// Deliberately NOT wired into the regular 4-hourly sync's main() the way
// backfillLeagueHistory is — that sync already brushes MFL's rate limit
// fetching rosters/standings/scoring/lineups for every league before its own
// (cheap) History backfill even starts, and adding a pass this much more
// expensive on top would risk the exact 429 cascade documented on
// backfillLeagueHistory above. backfill-scoring.mjs (dispatched via
// backfill-scoring.yml, workflow_dispatch only) is the only way this runs,
// with a cookie and MFL rate-limit window of its own — same shape as
// backfill-history.yml for the identical reason.
//
// Gated on a season already having a results[] entry from the OTHER
// backfill pass (guessed or confirmed — a guess still means the season
// genuinely happened and ended, which is all this needs): that's what
// guarantees this never runs against a season still in progress, which
// would compute a "final" weekly high / season total that keeps changing
// week to week.
// Both fixed, not derived from any one league's own regular-season/playoff
// split — see this pass's own header comment for why they're different
// numbers. A season shorter than 18 weeks (rare; some older seasons) is
// capped by that season's own `endWeek` instead, never padded out with
// weeks that were never played.
const WEEKLY_HIGH_SCORE_WEEKS = 18; // how far the fetch itself reaches
const SEASON_HIGH_SCORE_WEEKS = 17; // how far the season-total SUM reaches
const SCORING_MFL_REQUEST_BUDGET = 40;
// A season alone can cost close to this on its own (up to
// WEEKLY_HIGH_SCORE_WEEKS requests), so — unlike HISTORY_MFL_PER_LEAGUE_BUDGET,
// which mainly protects against one league's long tail of cheap bracket
// years — this mostly just caps one league's back catalog from filling the
// whole run before any other league gets a turn.
const SCORING_MFL_PER_LEAGUE_BUDGET = 20;

// Pure and budget-agnostic: which of a league's already-resolved seasons
// (any results[] entry at all) still need weekly/season point totals
// computed. No "guessed and eligible for retry" concept here, unlike
// yearsNeedingHistoryBackfill above — every number computeSeasonScoringRecords
// produces is a hard sum/max over data actually fetched, never a fallback
// estimate, so once a year's `scoring` is recorded it's simply done.
// Sorted most-recent-first, same reasoning as yearsNeedingHistoryBackfill: a
// manager is more likely to ask about last year's high score than one from
// a decade ago. `startYear` (see yearsNeedingHistoryBackfill's own comment)
// is filtered here too, defensively — the placement backfill never adds a
// year older than it in the first place, but a league that already had
// older years recorded before a manager set `startYear` would otherwise
// still have this pass spend a season's worth of budget (up to 18 requests)
// computing a weekly/season high nobody can see once it's filtered out on
// the page. Optional and undefined by default, same as there.
export function yearsNeedingScoringBackfill(existingResults, startYear) {
  return (existingResults || [])
    .filter((r) => !r.scoring)
    .filter((r) => startYear == null || startYear === '' || Number(r.year) >= Number(startYear))
    .map((r) => String(r.year))
    .sort((a, b) => Number(b) - Number(a));
}

// Exported so backfill-scoring.mjs — the standalone, on-demand companion to
// this pass (mirroring backfill-history.mjs) — can invoke exactly this logic
// with its own uncontested cookie and budget.
export async function backfillLeagueScoringRecords(leagues, previousById, cookie) {
  let mflBudget = SCORING_MFL_REQUEST_BUDGET;
  let yearsAdded = 0;
  let leaguesTouched = 0;
  let mflRateLimited = false;

  for (const league of leagues) {
    const prev = previousById.get(league.id);
    // results[] is owned by backfillLeagueHistory — this pass only ever adds
    // a `scoring` field onto an entry that pass already created, never
    // pushes a new year of its own.
    league.results = prev?.results ? prev.results.map((r) => ({ ...r })) : [];

    if (league.provider === 'espn' || league.provider === 'sleeper') continue; // out of scope for now — see providers.mjs
    if (!league.franchiseId) continue;
    if (mflBudget <= 0 || mflRateLimited) continue;

    // Needs each candidate year's OWN league id (an old league may have
    // changed id — see fetchMflLeagueHistory), which costs one MFL request
    // per league regardless of how many years end up touched this run.
    let historyYears;
    try {
      historyYears = await fetchMflLeagueHistory(league, cookie, league.season);
      mflBudget--;
    } catch (err) {
      if (err.status === 429) mflRateLimited = true;
      console.error(`Scoring backfill: failed to fetch league history for ${league.name}: ${err.message}`);
      continue;
    }
    const idByYear = new Map(historyYears.map((h) => [String(h.year), h.id]));

    let leagueBudget = SCORING_MFL_PER_LEAGUE_BUDGET;
    const missing = yearsNeedingScoringBackfill(league.results, league.startYear);
    for (const year of missing) {
      if (mflBudget <= 0 || mflRateLimited || leagueBudget <= 0) break;
      const yearLeagueId = idByYear.get(String(year));
      if (!yearLeagueId) continue; // a year results[] knows about but history.league[] doesn't — nothing to fetch against

      try {
        const { endWeek, nameById } = await fetchMflSeasonMeta(yearLeagueId, cookie, year);
        mflBudget--; leagueBudget--;
        // Fixed weeks 1-18, capped by the season's own endWeek for the rare
        // season that never reached 18 — see this pass's header comment for
        // why this is endWeek-capped rather than lastRegularSeasonWeek-scoped.
        // The season-total SUM stops at SEASON_HIGH_SCORE_WEEKS (17) below,
        // via computeSeasonScoringRecords's own cutoff argument — week 18 is
        // still fetched here because it can win the weekly-high payout.
        const weeksToFetch = Number.isFinite(endWeek) && endWeek > 0
          ? Math.min(WEEKLY_HIGH_SCORE_WEEKS, endWeek)
          : WEEKLY_HIGH_SCORE_WEEKS;

        // Every week has to succeed for this year to be recorded at all — a
        // season half-summed from surviving weeks would silently understate
        // the season total AND could miss the real weekly high, which is
        // worse than just trying again next run. Same all-or-nothing
        // discipline fetchMflSeasonBracketData's caller applies to a mid-year
        // 429 during placement backfill.
        const weeklyScoresByWeek = new Map();
        let weeksOk = true;
        for (let week = 1; week <= weeksToFetch; week++) {
          if (mflBudget <= 0 || leagueBudget <= 0) { weeksOk = false; break; }
          try {
            const totals = await fetchMflWeekScores(yearLeagueId, cookie, year, week);
            mflBudget--; leagueBudget--;
            weeklyScoresByWeek.set(week, totals);
          } catch (err) {
            if (err.status === 429) mflRateLimited = true;
            weeksOk = false;
            break;
          }
        }
        if (!weeksOk || weeklyScoresByWeek.size !== weeksToFetch) continue; // retry the whole year next run

        const { weeklyHighs, seasonHigh } = computeSeasonScoringRecords(weeklyScoresByWeek, nameById, SEASON_HIGH_SCORE_WEEKS);
        if (weeklyHighs.length || seasonHigh) {
          league.results = league.results.map((r) =>
            String(r.year) === String(year) ? { ...r, scoring: { weeklyHighs, seasonHigh } } : r
          );
          yearsAdded++;
          leaguesTouched++;
        }
      } catch (err) {
        if (err.status === 429) mflRateLimited = true;
        console.error(`Scoring backfill failed for ${league.name} (${year}): ${err.message}`);
      }
    }
  }

  console.log(
    `Scoring backfill: added ${yearsAdded} season(s) across ${leaguesTouched} league update(s) `
    + `(MFL budget ${SCORING_MFL_REQUEST_BUDGET - mflBudget}/${SCORING_MFL_REQUEST_BUDGET})`
    + (mflRateLimited ? ' — stopped early on a 429, remaining leagues retry next run' : '')
  );
}

async function main() {
  if (!USERNAME || !PASSWORD) {
    throw new Error('MFL_USERNAME and MFL_PASSWORD environment variables are required.');
  }

  const LEAGUES = await loadLeagueConfig();
  const previous = await loadPreviousOutput();
  const previousById = new Map((previous?.leagues ?? []).map((l) => [l.id, l]));

  const cookie = await mflLogin(USERNAME, PASSWORD);
  const playerMap = await loadPlayerMap(cookie);

  // Resolve every league's season up front, so the roster, standings, scoring
  // and lineup passes below all read the same one. Providers pick it up off the
  // league object (see seasonOf in providers.mjs), which is why none of the
  // calls further down mention a year.
  // One clock reading for the whole run, so season resolution and the ranking
  // set below can't land on different sides of a boundary mid-sync.
  const now = new Date();
  const phase = nflSeasonPhase(now);
  const targetSeason = phase.season;
  const probes = {
    mfl: (l, season) => mflLeagueExists(l, cookie, season),
    espn: (l, season) => espnLeagueExists(l, season),
  };
  for (const league of LEAGUES) {
    try {
      const resolved = await resolveSeason(league, previousById.get(league.id), targetSeason, probes);
      league.season = resolved.season;
      if (resolved.pinned) {
        console.log(`${league.name}: season ${resolved.season} (pinned in config)`);
      } else if (resolved.rolledOver) {
        console.log(`${league.name}: rolled over to ${resolved.season}`);
      } else if (resolved.waiting) {
        console.log(`${league.name}: staying on ${resolved.season} — ${targetSeason} isn't available yet`);
      } else if (resolved.fellBack) {
        console.log(`${league.name}: ${targetSeason} isn't set up yet — falling back to ${resolved.season}`);
      } else if (resolved.probeFailed) {
        console.log(`${league.name}: couldn't check whether ${targetSeason} exists — leaving it on ${resolved.season}`);
      } else if (resolved.unresolved) {
        console.log(`${league.name}: no season found from ${targetSeason} back to ${targetSeason - SEASON_LOOKBACK} — using ${resolved.season}`);
      }
    } catch (err) {
      // Never fatal. A probe that throws leaves the league exactly where the
      // last sync left it, which is the same outcome as a negative probe.
      const last = previousById.get(league.id)?.season;
      league.season = last ? String(last) : String(targetSeason);
      console.error(`Failed to resolve season for ${league.name}: ${err.message}`);
    }
  }

  // Sleeper needs no auth at all, but its player database is a ~5MB fetch —
  // only pull it if a Sleeper league is actually configured.
  let sleeperPlayerMap = null;
  if (LEAGUES.some((l) => l.provider === 'sleeper')) {
    sleeperPlayerMap = await loadSleeperPlayerMap();
  }

  let byeWeeks = new Map();
  try {
    byeWeeks = await fetchNflByeWeeks(cookie);
  } catch (err) {
    console.error(`Failed to fetch NFL bye weeks: ${err.message}`);
  }

  let injuries = new Map();
  try {
    injuries = await fetchMflInjuries(cookie);
  } catch (err) {
    console.error(`Failed to fetch NFL injury report: ${err.message}`);
  }

  // Which FantasyPros list the ECR column is drawn from, read from each league's
  // own scoring settings rather than assumed. Detected once per league per
  // season, not every sync: scoring rules don't change mid-year, and this is one
  // more request per league on a run that already brushes MFL's rate limit.
  // A league that errored last time is re-checked, same reasoning as the season.
  for (const league of LEAGUES) {
    const prev = previousById.get(league.id);
    if (prev?.scoringDetected && String(prev.season) === String(league.season) && !prev.error) {
      league.detectedScoring = prev.scoringDetected;
      continue;
    }
    try {
      const { format, points } = await detectScoringFormat(league, cookie);
      league.detectedScoring = format;
      console.log(format
        ? `${league.name}: scoring ${format} (${points} per reception)`
        : `${league.name}: ${points} per reception doesn't map onto PPR/HALF/STD — leaving scoring alone`);
    } catch (err) {
      // Never fatal, and never worse than before: without a detected format the
      // ranking spec falls back exactly as it always did.
      league.detectedScoring = prev?.scoringDetected || null;
      console.error(`Failed to detect scoring for ${league.name}: ${err.message}`);
    }
  }

  const leagues = [];
  for (const league of LEAGUES) {
    if (!league.franchiseId) {
      console.log(`Skipping ${league.name}: no franchiseId configured yet`);
      leagues.push({
        id: league.id,
        name: league.name,
        type: league.type,
        provider: league.provider || null,
        tags: league.tags || [],
        rulesUrl: league.rulesUrl || null,
        commishContact: league.commishContact || null,
        cutdownRosterSize: league.cutdownRosterSize || null,
        dues: league.dues ?? null,
        payout1: league.payout1 ?? null,
        payout2: league.payout2 ?? null,
        payout3: league.payout3 ?? null,
        payoutWeeklyHigh: league.payoutWeeklyHigh ?? null,
        payoutSeasonHigh: league.payoutSeasonHigh ?? null,
        startYear: league.startYear ?? null,
        leagueName: league.name,
        franchiseId: null,
        teamName: league.name,
        season: league.season,
        scoringDetected: league.detectedScoring || null,
        url: leagueUrl(league),
        players: [],
        updatedAt: null,
        error: 'Franchise ID not configured yet',
      });
      continue;
    }
    try {
      const result = league.provider === 'espn'
        ? await fetchEspnLeagueRoster(league)
        : league.provider === 'sleeper'
        ? await fetchSleeperLeagueRoster(league, sleeperPlayerMap, byeWeeks)
        : await fetchLeagueRoster(league, cookie, playerMap, byeWeeks, injuries);
      result.tags = league.tags || [];
      result.provider = league.provider || null;
      result.rulesUrl = league.rulesUrl || null;
      result.commishContact = league.commishContact || null;
      result.cutdownRosterSize = league.cutdownRosterSize || null;
      // ?? rather than || — a real, deliberate $0 dues or payout must survive,
      // not collapse into null the way an empty string legitimately would for
      // the string fields above. See leagueFinancesSummary's own missing-vs-
      // zero rule in myffl.html, which this is feeding.
      result.dues = league.dues ?? null;
      result.payout1 = league.payout1 ?? null;
      result.payout2 = league.payout2 ?? null;
      result.payout3 = league.payout3 ?? null;
      result.payoutWeeklyHigh = league.payoutWeeklyHigh ?? null;
      result.payoutSeasonHigh = league.payoutSeasonHigh ?? null;
      result.startYear = league.startYear ?? null;
      // Recorded per league because it's what the next sync reads to decide
      // whether this league has already rolled over — see resolveSeason.
      result.season = league.season;
      result.scoringDetected = league.detectedScoring || null;
      leagues.push(result);
      console.log(`Fetched ${league.name}: ${result.players.length} players`);
    } catch (err) {
      console.error(`Failed to fetch ${league.name}: ${err.message}`);
      const prev = previousById.get(league.id);
      leagues.push({
        id: league.id,
        name: league.name,
        type: league.type,
        provider: league.provider || null,
        tags: league.tags || [],
        rulesUrl: league.rulesUrl || null,
        commishContact: league.commishContact || null,
        cutdownRosterSize: league.cutdownRosterSize || null,
        dues: league.dues ?? null,
        payout1: league.payout1 ?? null,
        payout2: league.payout2 ?? null,
        payout3: league.payout3 ?? null,
        payoutWeeklyHigh: league.payoutWeeklyHigh ?? null,
        payoutSeasonHigh: league.payoutSeasonHigh ?? null,
        startYear: league.startYear ?? null,
        leagueName: prev?.leagueName || league.name,
        franchiseId: league.franchiseId,
        teamName: prev?.teamName || league.name,
        season: league.season,
        scoringDetected: league.detectedScoring || null,
        url: prev?.url || leagueUrl(league),
        players: prev?.players || [],
        updatedAt: prev?.updatedAt || null,
        error: err.message,
      });
    }
  }

  // In memory, no requests: the report was fetched once above and the MFL
  // player map was already loaded for the roster pass.
  const detailed = attachInjuryDetail(leagues, injuries, playerMap);
  if (detailed) console.log(`Matched injury detail by name for ${detailed} non-MFL roster entries`);

  for (const league of LEAGUES) {
    const target = leagues.find((l) => l.id === league.id);
    if (!target || !league.franchiseId) continue;
    try {
      target.standings = league.provider === 'espn'
        ? await fetchEspnStandings(league)
        : league.provider === 'sleeper'
        ? await fetchSleeperStandings(league)
        : await fetchStandings(league, cookie);
      target.standingsError = null;
      console.log(`Fetched standings for ${league.name}: ${target.standings.length} teams`);
    } catch (err) {
      console.error(`Failed to fetch standings for ${league.name}: ${err.message}`);
      const prev = previousById.get(league.id);
      target.standings = prev?.standings || [];
      target.standingsError = err.message;
    }
  }

  for (const league of LEAGUES) {
    const target = leagues.find((l) => l.id === league.id);
    if (!target || !league.franchiseId) continue;
    try {
      target.scoring = league.provider === 'espn'
        ? await fetchEspnScoring(league)
        : league.provider === 'sleeper'
        ? await fetchSleeperScoring(league)
        : await fetchScoring(league, cookie);
      target.scoringError = null;
      console.log(`Fetched scoring for ${league.name}: ${target.scoring.teams.length} teams`);
    } catch (err) {
      console.error(`Failed to fetch scoring for ${league.name}: ${err.message}`);
      const prev = previousById.get(league.id);
      target.scoring = prev?.scoring || null;
      target.scoringError = err.message;
    }
  }

  // Pilot: current-week starters/bench, only for leagues flagged
  // lineupPilot in config/leagues.json. See fetchMflLineup's comment for why
  // this can't affect any other league's data. Sleeper leagues get the same
  // read-only starters fetch (fetchSleeperLineup) — myffl.html renders it
  // without a Submit control for those, since Sleeper's API has no write
  // endpoint. ESPN isn't included: no read (or write) lineup fetch exists
  // for it yet.
  for (const league of LEAGUES) {
    if (!league.lineupPilot || (league.provider && league.provider !== 'mfl' && league.provider !== 'sleeper')) continue;
    const target = leagues.find((l) => l.id === league.id);
    if (!target || !league.franchiseId) continue;
    try {
      const { week, starterIds } = league.provider === 'sleeper'
        ? await fetchSleeperLineup(league)
        : await fetchMflLineup(league, cookie);
      target.lineupWeek = week;
      target.starters = starterIds;
      target.lineupError = null;
      console.log(`Fetched lineup for ${league.name}: ${starterIds.length} starters`);
    } catch (err) {
      console.error(`Failed to fetch lineup for ${league.name}: ${err.message}`);
      target.starters = null;
      target.lineupError = err.message;
    }
  }

  // Who is rostered by anyone in each league — the input to each league's
  // `available` list, and so to the Top Available card.
  //
  // Deliberately the last thing fetched, and deliberately per-league
  // best-effort. The league-wide MFL export is a much heavier response than
  // the FRANCHISE-scoped one, and the first sync that folded it into the
  // roster pass spent enough of the rate limit that three scoring fetches and
  // a lineup fetch behind it came back 429. Nothing was lost — they fell back
  // to the previous sync — but the ordering was backwards: this is the least
  // important thing here, so it goes after everything that matters more and
  // it is the thing that gives way under a rate limit.
  //
  // Sleeper is skipped because fetchSleeperLeagueRoster already collected it
  // from rosters it had in hand, at no extra request — which is also why
  // Sleeper isn't subject to the once-a-day rule below. Free is free.
  //
  // Two separate cadences here, and the order between them is the point.
  //
  // The *wire* is re-read once a day. Even last, that read is expensive —
  // sixteen heavy MFL exports, four of which came back 429 on the run that
  // proved it — and a free agent pool doesn't move meaningfully in four hours,
  // so five runs in six skip it and cost what the sync cost before any of this
  // existed.
  //
  // The *draft check* runs every sync, ahead of that rule. It used to sit
  // behind it, which left a real hole: a league that started drafting just
  // after its daily read went on serving a stale pre-draft wire for up to
  // twenty hours, and the only reason it ever got noticed was a manual
  // refresh. Moving it in front closes that to four hours — and costs nothing
  // in the steady state, because a finished draft never unfinishes, so
  // draftIsSettled skips every league already seen complete this season. In
  // August that's one request a sync for the league actually drafting; by
  // October it's none at all.
  let refreshed = 0;
  let carried = 0;
  let drafting = 0;
  let settled = 0;
  for (const league of LEAGUES) {
    const target = leagues.find((l) => l.id === league.id);
    if (!target || !league.franchiseId || target.error) continue;
    // Sleeper arrives with both its rostered names and its draft status
    // already attached, at no extra request.
    if (league.provider === 'sleeper' || target.rosteredNames) continue;

    const prev = previousById.get(league.id);

    // Mid-draft, every unpicked player reads as a free agent — true at the
    // instant it was read and useless, since they aren't claimable off a
    // wire, they're about to be drafted by somebody. Before a draft it's the
    // same picture with nothing picked yet: a draft board, not a wire. So any
    // unfinished draft takes the league out until it's done.
    //
    // ESPN is exempt: its own draft state is unverified from here, and its
    // leagues have no rosters to read anyway.
    if (league.provider !== 'espn') {
      if (draftIsSettled(prev, target.season, forceAvailability)) {
        // Sticky, so the answer survives into the next sync's `prev` and this
        // league stays free to check forever after.
        target.draftInProgress = false;
        settled++;
      } else {
        try {
          const status = await fetchMflDraftStatus(league, cookie);
          // Only a definite "not finished" hides a league. A league with no
          // draft data at all keeps its wire rather than vanishing on a guess,
          // and stays unsettled so the next sync asks again.
          if (status && !status.complete) {
            target.draftInProgress = true;
            drafting++;
            console.log(`${league.name}: draft in progress (${status.made} of ${status.made + status.unmade} picks made) — skipping free agents`);
            continue;
          }
          if (status) target.draftInProgress = false;
        } catch (err) {
          console.error(`Failed to read draft status for ${league.name}: ${err.message}`);
          // Degrade the way everything else here does: keep what the last sync
          // concluded rather than dropping to "don't know". A 429 on this
          // request would otherwise strip a drafting league of its flag, and
          // the card would go on excluding it — its `available` is null — while
          // no longer being able to say a draft is why. Which is precisely what
          // happened on the first run of this ordering.
          //
          // Safe in all three directions: a carried-forward `false` was already
          // true and stays true (a finished draft never unfinishes), `true`
          // keeps the league both flagged and unsettled so the next sync asks
          // again, and an absent value stays absent and is asked again too.
          target.draftInProgress = prev?.draftInProgress;
          if (target.draftInProgress === true) {
            drafting++;
            console.log(`${league.name}: draft status unavailable, still assumed drafting — skipping free agents`);
            continue;
          }
        }
      }
    }

    // Only now the daily rule for the wire itself. A league whose draft just
    // finished lands here with `available: null` — cleared while it was
    // drafting — so it is never "fresh" and gets re-read on this very sync
    // rather than waiting for the next daily one.
    if (availabilityIsFresh(prev, now, forceAvailability)) {
      target.available = prev.available;
      target.availableAt = prev.availableAt;
      carried++;
      continue;
    }

    try {
      const read = league.provider === 'espn'
        ? await fetchEspnRosteredNames(league)
        : await fetchMflRosteredNames(league, cookie, playerMap);
      // One response, two consumers: the flat names feed availability, the
      // per-franchise grouping feeds the power score. Splitting them here
      // rather than returning two shapes keeps the call sites honest about
      // it being a single read.
      target.rosteredNames = read?.names ?? null;
      target.rosterFranchises = read?.franchises ?? null;
      refreshed++;
    } catch (err) {
      console.error(`Failed to fetch league-wide rosters for ${league.name}: ${err.message}`);
      target.rosteredNames = null;
      target.rosterFranchises = null;
    }
  }
  console.log(`Free agents: re-read ${refreshed} league(s), kept ${carried} from the last daily read, skipped ${drafting} mid-draft`);
  console.log(`Draft status: asked about ${LEAGUES.length - settled} league(s), ${settled} already settled this season`);

  // FantasyPros consensus rankings, layered over whatever rosters we managed
  // to fetch above. Skipped entirely without an API key so the sync behaves
  // exactly as it did before this existed, and never allowed to fail the run
  // — every league keeps its roster whether or not rankings came through.
  const fpApiKey = fantasyProsApiKey();
  let rankingPools = {};
  if (!fpApiKey) {
    console.log('Skipping FantasyPros rankings: FANTASYPROS_API_KEY not set');
  } else {
    // The NFL season year, not the calendar year: between New Year and the
    // Super Bowl those differ, and that is exactly the stretch where the
    // automatic ranking set is ROS — asking FantasyPros for next season's
    // rest-of-season list comes back empty. An explicit MFL_YEAR still wins,
    // as it does everywhere. Note this is the league-independent target: a
    // league still trailing on last season gets current rankings, which is
    // right, since the rankings describe the players, not the league.
    const season = process.env.MFL_YEAR || String(targetSeason);
    console.log(`FantasyPros — ${season} season, ${phase.inSeason ? 'in season' : 'offseason'}`);
    try {
      const result = await attachRankings(leagues, LEAGUES, { apiKey: fpApiKey, season, now });
      for (const line of result.summary) console.log(`FantasyPros — ${line}`);
      rankingPools = result.pools;
      for (const [key, pool] of Object.entries(rankingPools)) {
        console.log(`FantasyPros — pool ${key}: ${pool.players.length} players`);
      }
    } catch (err) {
      console.error(`Failed to attach FantasyPros rankings: ${err.message}`);
    }

    // Sleepers: a second, independent FantasyPros list layered on the same
    // way — non-fatal, one fetch for the whole sync (see attachSleepers).
    try {
      const sleeperResult = await attachSleepers(leagues, { apiKey: fpApiKey, season });
      console.log(`FantasyPros — sleepers: ${sleeperResult.matched} roster spots matched against ${sleeperResult.total} listed`);
    } catch (err) {
      console.error(`Failed to attach FantasyPros sleepers: ${err.message}`);
    }

    // Power ranks: every franchise in a league graded by its best legal
    // starting lineup under FantasyPros' season projections — homegrown,
    // because probe-fantasypros-power-rank.yml established the partner API
    // has nothing team-shaped to ask for. Computed only for leagues whose
    // league-wide rosters were read *this run*, so it rides the same
    // once-a-day cadence (and the same mid-draft skip) as availability:
    // Sleeper refreshes every sync because its rosters arrive free, MFL and
    // ESPN once a day. Everyone else carries forward in the cleanup loop
    // below, exactly like `available`. Four projection GETs a sync, shared
    // across all eighteen leagues, and never allowed to fail the run.
    try {
      // phase.inSeason rides along so a power object can say whether it was
      // built from preseason projections during the season — see the meta
      // comment in fetchProjections. The sync is the side that decides this,
      // the page only describes it, same division as the ranking calendar.
      //
      // Projections are the preferred basis and are not always there:
      // FantasyPros publishes them per season, so from the Super Bowl until
      // the next season's list goes up there is nothing to ask for and every
      // position comes back empty. That is an ordinary state of the year
      // rather than a failure, so it falls back to the ranking pools this
      // sync already fetched (see buildEcrIndex) instead of leaving the card
      // to carry January's ranks through to July.
      let projections = null;
      // Only meaningful when projections stays null: which of the two things
      // that both look like "no players came back" actually happened. The
      // season not being up yet is an ordinary offseason state that lasts
      // months; FantasyPros rate-limiting this run's projections calls is a
      // transient failure that should clear on its own next sync. The page
      // needs to say different things about each rather than one banner
      // wording standing in for both.
      let projectionsUnavailable = null;
      try {
        projections = await fetchProjections({ apiKey: fpApiKey, season, inSeason: phase.inSeason });
      } catch (err) {
        projectionsUnavailable = err.projectionsNotPublished ? 'not_published' : 'fetch_failed';
        console.log(`FantasyPros — projections unavailable (${err.message}); power ranks fall back to consensus rankings`);
      }

      // One ECR index per distinct ranking pool rather than per league, the
      // same sharing rankingPoolKey already buys the pools themselves — a
      // dozen leagues typically draw on two or three lists.
      const ecrIndexByPool = new Map();
      const ecrIndexFor = (league) => {
        if (!league.rankings) return null;
        const key = rankingPoolKey(league.rankings);
        if (!ecrIndexByPool.has(key)) {
          ecrIndexByPool.set(key, buildEcrIndex(rankingPools[key], { season, inSeason: phase.inSeason }));
        }
        return ecrIndexByPool.get(key);
      };

      // computeLeaguePower computes `starters` for every franchise in the
      // league — ranking ours needs the same greedy fill run for everyone
      // else regardless — but only ours is ever shown on the page (Power
      // Rankings prints one row per league we hold a team in, never a
      // full-league breakdown). Shipping every franchise's starter list
      // would be N times the bytes for information nobody reads; this
      // strips it back to just the matching franchise right before the
      // sync writes its output.
      function keepMyStarters(teams, myFranchiseId) {
        return teams.map((t) => {
          if (String(t.franchiseId) !== String(myFranchiseId)) {
            const { starters, ...rest } = t;
            return rest;
          }
          return t;
        });
      }

      const configById = new Map(LEAGUES.map((l) => [l.id, l]));
      let powered = 0;
      let skipped = 0;
      const byBasis = { projections: 0, ecr: 0 };
      for (const league of leagues) {
        if (league.draftInProgress) continue; // cleared below, like available
        if (!Array.isArray(league.rosterFranchises) || league.rosterFranchises.length === 0) continue;
        const config = configById.get(league.id);
        if (!config) continue;
        // ESPN's real slot counts are unprobed; the platform-default shape
        // is uniform across the league's franchises, which is the property
        // the ordinal needs. MFL/Sleeper leagues that yielded no parseable
        // slots are skipped rather than guessed at.
        const slots = league.lineupSlots
          || (config.provider === 'espn' ? DEFAULT_POWER_SLOTS : null);
        if (!slots) continue;
        // Both bases, every run, because they answer different questions and
        // the card shows them side by side. Projections value a roster by the
        // points it should score; rankings value it by where consensus places
        // its players, which in a dynasty league is a bet on the next several
        // years rather than this one. A team can lead one and trail the other,
        // and that gap is the contender-versus-rebuilder signal the pair
        // exists to show.
        //
        // Computing both costs nothing extra at the provider: the projections
        // were fetched once for the whole sync, the pools were already fetched
        // for Top Available, and what remains is arithmetic over a few dozen
        // names. Either may come back null on its own — see the guard in
        // computeLeaguePower — and the page renders that side as TBD rather
        // than dropping the league.
        const common = {
          franchises: league.rosterFranchises,
          slots,
          // The same resolution the ECR column uses: explicit config wins,
          // then the detected format, PPR as the last resort.
          scoring: rankingSpecForLeague(config, now).scoring,
          joinById: (config.provider || 'mfl') === 'mfl',
          computedAt: now.toISOString(),
        };
        const projPower = projections ? computeLeaguePower({ ...common, values: projections }) : null;
        const ecrValues = ecrIndexFor(league);
        const ecrPower = ecrValues ? computeLeaguePower({ ...common, values: ecrValues }) : null;

        // Only when *neither* basis produced anything is there nothing to
        // say. Skipping leaves the previous sync's ranks in place via the
        // carry-forward below, and says so out loud.
        if (!projPower && !ecrPower) {
          console.error(`${league.name}: power ranks skipped — no franchise seated a player on either basis (join or slot shape broken?)`);
          skipped++;
          continue;
        }
        league.power = {
          computedAt: now.toISOString(),
          scoring: common.scoring,
          // Per basis rather than merged: each carries its own provenance, and
          // each ranks the same franchises independently.
          projections: projPower ? { source: projPower.source, teams: keepMyStarters(projPower.teams, league.franchiseId) } : null,
          ecr: ecrPower ? { source: ecrPower.source, teams: keepMyStarters(ecrPower.teams, league.franchiseId) } : null,
          // Why the projections basis is missing, when it is — carried onto
          // every league this run touches the projections fetch for, since
          // that fetch is one shared call for the whole sync. Null once
          // projPower exists; there is nothing to explain on a row that has
          // its data.
          projectionsUnavailable: projPower ? null : projectionsUnavailable,
        };
        powered++;
        if (projPower) byBasis.projections++;
        if (ecrPower) byBasis.ecr++;
      }
      console.log(
        `FantasyPros — power ranks computed for ${powered} league(s) `
        + `(${byBasis.projections} with projections, ${byBasis.ecr} with consensus rankings)`
        + `${skipped > 0 ? `, skipped ${skipped} with no usable join` : ''}`
      );
    } catch (err) {
      console.error(`Failed to compute power ranks: ${err.message}`);
    }
  }

  // Degrade the same way everything else here does: a league that couldn't be
  // read keeps the availability it last had, and a run with no rankings at all
  // keeps the previous pools rather than emptying the two cards that need
  // them. Both are stale, but stale beats blank for a list of free agents that
  // barely moves between syncs.
  //
  // `availableAt` is stamped only on a list actually rebuilt this run, since
  // it is what the once-a-day rule reads next time — carrying a list forward
  // must never look like a fresh read of it, or the daily read would never
  // come due again.
  //
  // One consequence of carrying the names forward rather than the rosters they
  // were derived from: they were filtered against yesterday's ranking pool,
  // and today's differs a little. A carried-forward name that has since fallen
  // out of the pool simply doesn't render (computeTopAvailable looks each one
  // back up), and a player who newly entered it won't appear as available
  // until the next daily read. Both are a one-day lag on a slow-moving list,
  // and the alternative — persisting every league's full rostered-name list so
  // it could be re-filtered — is the ~150KB this design exists to avoid.
  for (const league of leagues) {
    const readThisRun = Array.isArray(league.rosteredNames);
    delete league.rosteredNames;
    // Working fields for the power score, spent in the same run: the
    // per-franchise rosters and slot shapes never reach data/rosters.json —
    // only the computed `power` object does, a few hundred bytes per league
    // against the ~150KB the raw rosters would cost.
    delete league.rosterFranchises;
    delete league.lineupSlots;
    const prev = previousById.get(league.id);
    if (league.draftInProgress) {
      // Explicitly cleared, not merely left unset: the carry-forward below
      // would otherwise restore the wire this league had *before* its draft
      // started, which is the most misleading version of all — a list of
      // players who are being taken as you read it.
      //
      // Nulling it also puts the league back on the every-sync retry path
      // (availabilityIsFresh needs an array), so a finished draft is picked
      // up within four hours rather than at the next daily read.
      league.available = null;
      league.availableAt = null;
      // A half-drafted league's power rank is a ranking of who drafted
      // earliest, so it goes the way the wire does.
      league.power = null;
    } else if (readThisRun && league.available != null) {
      league.availableAt = now.toISOString();
    } else if (league.available == null) {
      league.available = prev?.available ?? null;
      league.availableAt = prev?.availableAt ?? null;
    }
    // Carried forward on the runs that skip the daily roster read, exactly
    // like `available` — a power object computed this run was assigned above
    // and stays.
    if (!league.draftInProgress && league.power == null) {
      league.power = prev?.power ?? null;
    }
  }
  if (Object.keys(rankingPools).length === 0 && previous?.rankingPools) {
    rankingPools = previous.rankingPools;
  }

  // Last, deliberately — this is bonus historical data for the History tab,
  // never allowed to compete with the season-critical fetches above for
  // MFL's rate limit. See backfillLeagueHistory's own comment for the
  // budget/backfill shape.
  try {
    await backfillLeagueHistory(leagues, previousById, cookie);
  } catch (err) {
    console.error(`History backfill failed: ${err.message}`);
  }

  const output = {
    generatedAt: new Date().toISOString(),
    // The season being aimed at. Individual leagues can legitimately trail it
    // during the rollover window, so each carries its own `season` too.
    year: String(targetSeason),
    // The ranking lists themselves, deep enough for the Top Players and Top
    // Available cards. Shared across leagues rather than repeated on each,
    // since a dozen leagues typically draw on the same two or three lists —
    // see rankingPoolKey, which is how a league finds its own.
    rankingPools,
    leagues,
  };

  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n');
  console.log(`Wrote ${OUTPUT_PATH}`);
}

// Only sync when run directly. Without this guard, importing the module to test
// resolveSeason would kick off a full fetch against MFL — and fail immediately
// on the missing credentials, which is what CI would see.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
