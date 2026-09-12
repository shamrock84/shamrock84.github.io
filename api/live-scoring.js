// Vercel serverless function: live scoring only, polled by the Scoring tab
// every ~30s while it's open. Deliberately separate from the GitHub Actions
// sync (scripts/fetch-rosters.mjs) which handles rosters/standings on a much
// slower 4-hour cadence and commits to the repo — this never writes anywhere,
// it just answers requests with fresh scores.
//
// Requires the same MFL_USERNAME/MFL_PASSWORD/ESPN_S2/ESPN_SWID as the GitHub
// Actions secrets, set separately as Vercel project environment variables
// (secrets aren't shared across platforms).

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  mflLogin,
  fetchMflFranchiseNames,
  fetchScoring,
  loadPlayerMap,
  fetchEspnScoring,
  fetchSleeperScoring,
  fetchSleeperWeekStats,
  fetchNflGames,
  gameClocksFromGames,
  loadSleeperPlayerMap,
  setMflRequestInterval,
  currentNflWeek,
} from '../scripts/lib/providers.mjs';
import { applyCors } from './lib/cors.mjs';
// scripts/lib/fantasypros.mjs is a new import boundary for api/ — see
// vercel.json's ignoreCommand, which now watches this file too. Without
// that, a commit touching only fantasypros.mjs would silently skip the
// Vercel deploy this function needs (see CLAUDE.md's own note about
// attachInjuryDetail avoiding this exact trap for the sync's fetch-rosters.mjs).
import { fetchProjections, fantasyProsApiKey, normalizePlayerName, nflSeasonPhase } from '../scripts/lib/fantasypros.mjs';

const CONFIG_PATH = fileURLToPath(new URL('../config/leagues.json', import.meta.url));

// Explicit rather than relying on Vercel's default execution ceiling — see
// LIVE_SCORING_MFL_INTERVAL_MS's own comment below. A fully-cold poll's
// worst case (~30 MFL requests across every league, paced 300ms apart, plus
// a possible 429 retry chain on top) can approach 10+ seconds; 30s leaves
// real margin instead of hoping the platform default happened to cover it,
// which is the assumption that ran out of room the last two times this
// pacing interval needed raising.
export const config = { maxDuration: 30 };

// Module-level cache — persists across warm invocations of this function
// instance (not guaranteed across cold starts, which is fine: worst case we
// just re-login / re-fetch names once). Keeps steady-state polling down to
// one cheap request per league instead of re-authenticating and re-fetching
// static franchise names on every single poll.
const cache = {
  mflCookie: null,
  mflCookieAt: 0,
  mflNames: new Map(), // leagueId -> { nameById: Map<franchiseId, name>, ownerById: Map<franchiseId, ownerName|null> }
  mflNamesAt: new Map(), // leagueId -> timestamp
  sleeperPlayerMap: null,
  sleeperPlayerMapAt: 0,
  mflPlayerMap: null, // loadPlayerMap's id -> { name, position, team }
  mflPlayerMapAt: 0,
  nflWeek: null,
  nflWeekAt: 0,
  projections: null, // fetchProjections' index: { byMflId, byName, meta }
  projectionsAt: 0,
  projectionsWeek: null, // the week the cached index above was fetched for
};

const COOKIE_TTL_MS = 20 * 60 * 1000; // 20 min
const NAMES_TTL_MS = 60 * 60 * 1000; // 1 hour
// Sleeper's own player-team assignments (used for minutesRemaining) barely
// move within a week, unlike the NFL game clocks below — same TTL reasoning
// as the MFL franchise names above, just for a different provider's mostly-
// static lookup. The clocks themselves are NOT cached at all: they're the
// one thing that's genuinely different every poll while a game is live, and
// fetching the public NFL scoreboard fresh each time is one cheap,
// unauthenticated request shared across every ESPN/Sleeper league in that
// poll — not one per league.
const SLEEPER_PLAYER_MAP_TTL_MS = 60 * 60 * 1000; // 1 hour
// MFL's own global player list, for the Scoring tab's detail drawer — it
// needs a name/position beside each starter, and MFL's liveScoring response
// identifies players by id alone.
//
// Same TTL and same reasoning as the Sleeper map above: names, positions and
// NFL teams barely move within a week, so this is cached hard. What makes it
// worth caching harder than anything else in this file is its shape — it is
// ONE GLOBAL request (TYPE=players, every player in the league universe, a
// multi-megabyte response), not one per league, so a warm instance pays it
// once and every MFL league in every later poll reads it for free. It is
// also the only MFL request in this file that is NOT league-scoped, which is
// why it sits outside the Promise.allSettled fan-out below rather than
// inside it.
const MFL_PLAYER_MAP_TTL_MS = 60 * 60 * 1000; // 1 hour
// The current NFL week changes at most once a week — 30 minutes is
// generous rather than measured, same caveat as every other interval in
// this file. currentNflWeek() itself is a public, unauthenticated Sleeper
// read (no league scoping), so this is one small shared cost per poll, not
// per league.
const NFL_WEEK_TTL_MS = 30 * 60 * 1000;
// Projections don't move within a week (see fantasypros.mjs's own note that
// the endpoint carries no last_updated at all), so an hour-plus TTL is
// safe — this keeps the whole feature to a handful of FantasyPros calls a
// day, not one per 30s poll. Invalidated early (see getProjections) the
// moment the cached week no longer matches the current one, so a Tuesday
// rollover can't serve last week's numbers for up to an hour.
const PROJECTIONS_TTL_MS = 60 * 60 * 1000;

async function getSleeperPlayerMap() {
  const age = Date.now() - cache.sleeperPlayerMapAt;
  if (cache.sleeperPlayerMap && age < SLEEPER_PLAYER_MAP_TTL_MS) {
    return cache.sleeperPlayerMap;
  }
  cache.sleeperPlayerMap = await loadSleeperPlayerMap();
  cache.sleeperPlayerMapAt = Date.now();
  return cache.sleeperPlayerMap;
}

// Returns null (never throws) on failure — a missing player map costs the
// drawer its names and positions (it falls back to showing the raw MFL id),
// but must never cost the whole poll its actual scores. Same degrade-not-fail
// posture as getProjections below.
async function getMflPlayerMap(cookie) {
  const age = Date.now() - cache.mflPlayerMapAt;
  if (cache.mflPlayerMap && age < MFL_PLAYER_MAP_TTL_MS) {
    return cache.mflPlayerMap;
  }
  try {
    cache.mflPlayerMap = await loadPlayerMap(cookie);
    cache.mflPlayerMapAt = Date.now();
  } catch {
    // Leave whatever was cached (possibly null) in place and don't stamp the
    // timestamp, so the next poll retries rather than waiting out a full TTL
    // on a failure.
  }
  return cache.mflPlayerMap;
}

async function getCurrentNflWeek() {
  const age = Date.now() - cache.nflWeekAt;
  if (cache.nflWeek && age < NFL_WEEK_TTL_MS) {
    return cache.nflWeek;
  }
  cache.nflWeek = await currentNflWeek();
  cache.nflWeekAt = Date.now();
  return cache.nflWeek;
}

// Returns null (never throws) on any failure — a projections outage must
// degrade the win-probability estimate back to its flat per-minute rate,
// not take down the whole poll. See the handler's own try/catch around this
// call for the no-API-key case, which never gets this far.
async function getProjections(apiKey, week) {
  const age = Date.now() - cache.projectionsAt;
  if (cache.projections && cache.projectionsWeek === week && age < PROJECTIONS_TTL_MS) {
    return cache.projections;
  }
  const { season, inSeason } = nflSeasonPhase();
  cache.projections = await fetchProjections({ apiKey, season, week, inSeason });
  cache.projectionsAt = Date.now();
  cache.projectionsWeek = week;
  return cache.projections;
}

// Builds the per-player projection lookup fetchScoring/fetchEspnScoring/
// fetchSleeperScoring's projectPlayer parameter expects, or undefined when
// no projections index reached this poll — omitting it entirely (rather
// than a function that always returns null) is what tells
// estimateWinProbability to fall back to its original flat per-minute rate
// for every player, unconditionally, the same as before this feature
// existed. `provider` picks the join: MFL players carry `id` (the same
// space fetchProjections' byMflId already joins against); ESPN/Sleeper
// carry `name` only, joined the same normalized way fantasypros.mjs's own
// computeLeaguePower does. `scoring` mirrors rankingSpecForLeague's own
// fallback order minus the sync's detected-format step, which this fast
// path has no access to (config/leagues.json is all it loads) — an
// explicit league.scoring wins, otherwise PPR.
function makeProjectPlayer(values, provider, scoring) {
  if (!values) return undefined;
  const effectiveScoring = scoring || 'PPR';
  return (player) => {
    const entry = provider === 'mfl'
      ? values.byMflId.get(String(player.id))
      : values.byName.get(normalizePlayerName(player.name));
    if (!entry) return null;
    return entry.points[effectiveScoring] ?? entry.points.PPR ?? null;
  };
}

// This path fans out across every league at once (the Promise.allSettled
// below), so a poll leaves as one burst of ~15 simultaneous MFL requests every
// 30 seconds for as long as the Scoring tab is open — and a poll that lands
// mid-sync stacks straight on top of whatever the sync is spending. That is the
// reason for a floor here at all.
//
// Deliberately much smaller than the sync's 300ms, and that difference is the
// point rather than an inconsistency: pacing is opt-in per entry point
// precisely so each can pick an interval matched to its own latency budget. The
// sync is an unattended cron where 30s of extra wall-clock costs nothing; this
// answers a user-facing tab and pays the interval once per league in added
// latency.
//
// 75ms shipped first and turned out to be too low: real production 429s
// landed within the first hour of this cache existing, every one of them on a
// COLD instance (see getMflNames/getMflCookie above — cache is per warm
// instance and does not survive a cold start). A cold poll pays the interval
// twice over, once for the TYPE=league names read and once for liveScoring,
// for every MFL league that isn't cached yet — roughly 2x the request count
// of the steady-state case this constant was originally sized against, and
// mflGet's own retry (up to 3 attempts, 1.5/3/4.5s backoff) still weren't
// enough to outlast it. 150ms doubled that gap, but a cold instance still
// visibly struggled in practice (every MFL league showing "Loading live
// scores…" on a manual refresh, well past what a healthy poll should take) —
// so this doubles again to 300ms, matching the sync's own MFL_REQUEST_INTERVAL_MS.
//
// That match is deliberate this time, not the inconsistency the earlier
// comment here warned against: this file's actual constraint was never "must
// be smaller than the sync's number" on principle, it was "must leave a cold
// burst inside this function's execution ceiling" — and 300ms's worst case
// (~30 MFL requests across every league on a fully cold instance ≈ 9s of
// pacing floor alone, before request latency or a 429 retry chain) no longer
// clears that bar on faith. `maxDuration` below is what actually buys the
// margin now, rather than staying small and hoping the platform default was
// generous enough — which is exactly the gamble that left no room the last
// two times this number needed raising. Still a starting point, not a
// measured limit — the same caveat every number in this pacing scheme
// carries — but now anchored to two rounds of observed failure, not a guess.
//
// Module scope, so it is set once per warm instance alongside the caches above.
const LIVE_SCORING_MFL_INTERVAL_MS = 300;
setMflRequestInterval(LIVE_SCORING_MFL_INTERVAL_MS);

async function getMflCookie(username, password) {
  const age = Date.now() - cache.mflCookieAt;
  if (cache.mflCookie && age < COOKIE_TTL_MS) {
    return cache.mflCookie;
  }
  cache.mflCookie = await mflLogin(username, password);
  cache.mflCookieAt = Date.now();
  return cache.mflCookie;
}

// Returns { nameById, ownerById } — see fetchMflFranchiseNames's own comment.
// ownerById is almost always all-null (MFL only fills owner_name in for a
// league this project's login commissions), but it costs nothing extra to
// cache alongside the names: same TYPE=league response, same TTL.
async function getMflNames(league, cookie) {
  const at = cache.mflNamesAt.get(league.id) || 0;
  const cached = cache.mflNames.get(league.id);
  if (cached && Date.now() - at < NAMES_TTL_MS) {
    return cached;
  }
  const franchiseInfo = await fetchMflFranchiseNames(league, cookie);
  cache.mflNames.set(league.id, franchiseInfo);
  cache.mflNamesAt.set(league.id, Date.now());
  return franchiseInfo;
}

async function loadLeagueConfig() {
  const raw = await readFile(CONFIG_PATH, 'utf8');
  return JSON.parse(raw).leagues || [];
}

// draftonly leagues run a single draft and never produce a real head-to-head
// matchup — MFL's TYPE=liveScoring genuinely has nothing for them, confirmed
// against production: every draftonly MFL league returned "No live scoring
// available yet" on every poll, never real data, while burning a names +
// liveScoring request pair each in the same cold-start burst that trips
// MFL's rate limit for every OTHER league too (see
// LIVE_SCORING_MFL_INTERVAL_MS's own comment). Excluding them here is both
// "this was never going to work" and "this was actively costing the leagues
// that do." The Scoring tab's own Draft Only sub-tab pill disappears on its
// own once no Scoring card carries that data-league-type — same mechanism
// Top Available already uses to skip Draft Only, nothing extra needed there.
function hasLiveScoring(league) {
  return !!league.franchiseId && league.type !== 'draftonly';
}

export default async function handler(req, res) {
  if (applyCors(req, res, { methods: 'GET, OPTIONS' })) return;
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const username = process.env.MFL_USERNAME;
  const password = process.env.MFL_PASSWORD;
  if (!username || !password) {
    res.status(500).json({ error: 'MFL_USERNAME and MFL_PASSWORD are not configured on this deployment.' });
    return;
  }

  let leagues;
  try {
    leagues = await loadLeagueConfig();
  } catch (err) {
    res.status(500).json({ error: `Failed to load league config: ${err.message}` });
    return;
  }

  let mflCookie = null;
  let mflLoginError = null;
  try {
    mflCookie = await getMflCookie(username, password);
  } catch (err) {
    mflLoginError = err.message;
  }

  // The MFL player map, once per poll and shared across every MFL league —
  // never inside the fan-out below (it is a global, non-league-scoped
  // request; see MFL_PLAYER_MAP_TTL_MS). Skipped entirely when the login
  // failed or no MFL league is in play, so an all-ESPN/Sleeper config never
  // pays for it. Null on failure — see getMflPlayerMap.
  const anyMflLeague = leagues.some((l) => hasLiveScoring(l) && (!l.provider || l.provider === 'mfl'));
  let mflPlayerMap = null;
  if (mflCookie && anyMflLeague) {
    mflPlayerMap = await getMflPlayerMap(mflCookie);
  }

  // One shared fetch of the public NFL scoreboard per poll, not one per
  // league — see fetchNflGameClocks' own comment. A failure here must not
  // cost any ESPN/Sleeper league its actual score, so this degrades to an
  // empty map (every minutesRemaining/winProb comes back 0/undefined for
  // this poll) rather than rejecting.
  let nflGames = new Map();
  let nflClocks = new Map();
  try {
    // fetchNflGames is the richer read of the same single scoreboard request
    // fetchNflGameClocks used to make — the clocks are projected out of it
    // (gameClocksFromGames) rather than fetched again, so the drawer's
    // opponent/kickoff line costs nothing beyond what this poll already paid.
    nflGames = await fetchNflGames();
    nflClocks = gameClocksFromGames(nflGames);
  } catch {
    // degrade silently — see comment above. An empty map costs every
    // ESPN/Sleeper league its minutesRemaining/winProb for this poll and the
    // drawer its game line; neither is worth failing the scores over.
  }

  // Projections are an enrichment on top of the win-probability estimate,
  // never a dependency of it: no key configured, the week can't be
  // resolved, or the endpoint is down this poll all land here the same
  // way, leaving `projections` null. Every fetch*Scoring call below already
  // treats a missing projectPlayer as "use the flat per-minute rate", the
  // exact behavior this feature had before FantasyPros entered the picture
  // — so a failure here costs accuracy, never availability.
  let projections = null;
  const apiKey = fantasyProsApiKey();
  if (apiKey) {
    try {
      const week = await getCurrentNflWeek();
      if (week) projections = await getProjections(apiKey, week);
    } catch {
      // degrade silently — see comment above.
    }
  }

  // Sleeper's public per-player weekly stats — the raw-category source
  // behind the drawer's stat-breakdown popover (see SLEEPER_STAT_LABELS'
  // own comment in providers.mjs). League-independent, so fetched once per
  // poll and shared across every Sleeper league below, same pattern as
  // nflGames above; skipped entirely when no Sleeper league is configured.
  // A failure here costs the popover its Sleeper rows for this poll, never
  // the scores themselves — same degrade-not-fail posture as projections.
  let sleeperWeeklyStats = null;
  const anySleeperLeague = leagues.some((l) => hasLiveScoring(l) && l.provider === 'sleeper');
  if (anySleeperLeague) {
    try {
      const week = await getCurrentNflWeek();
      const { season } = nflSeasonPhase();
      if (week) sleeperWeeklyStats = await fetchSleeperWeekStats(season, week);
    } catch {
      // degrade silently — see comment above.
    }
  }

  const results = await Promise.allSettled(
    leagues
      .filter(hasLiveScoring)
      .map(async (league) => {
        if (league.provider === 'espn') {
          const projectPlayer = makeProjectPlayer(projections, 'espn', league.scoring);
          const scoring = await fetchEspnScoring(league, nflClocks, projectPlayer);
          return { id: league.id, name: league.name, scoring, scoringError: null };
        }
        if (league.provider === 'sleeper') {
          const players = await getSleeperPlayerMap();
          const projectPlayer = makeProjectPlayer(projections, 'sleeper', league.scoring);
          const scoring = await fetchSleeperScoring(league, nflClocks, players, projectPlayer, sleeperWeeklyStats);
          return { id: league.id, name: league.name, scoring, scoringError: null };
        }
        if (mflLoginError) {
          throw new Error(mflLoginError);
        }
        const franchiseInfo = await getMflNames(league, mflCookie);
        const projectPlayer = makeProjectPlayer(projections, 'mfl', league.scoring);
        const scoring = await fetchScoring(league, mflCookie, franchiseInfo, projectPlayer, mflPlayerMap);
        return { id: league.id, name: league.name, scoring, scoringError: null };
      })
  );

  const leaguesOut = leagues
    .filter(hasLiveScoring)
    .map((league, i) => {
      const r = results[i];
      if (r.status === 'fulfilled') return r.value;
      return { id: league.id, name: league.name, scoring: null, scoringError: r.reason?.message || 'Unknown error' };
    });

  res.status(200).json({
    generatedAt: new Date().toISOString(),
    // The NFL schedule, once per response rather than stamped onto each of
    // the ~1600 starters a poll covers. The Scoring tab's detail drawer joins
    // it by the `team` already on every player, and the map is keyed under
    // every provider's spelling of each team (see NFL_TEAM_ALIASES) so that
    // join is a plain lookup with nothing to normalize. ~40 keys total.
    games: Object.fromEntries(nflGames),
    leagues: leaguesOut,
  });
}
