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
  fetchEspnScoring,
  fetchSleeperScoring,
  fetchNflGameClocks,
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

// Module-level cache — persists across warm invocations of this function
// instance (not guaranteed across cold starts, which is fine: worst case we
// just re-login / re-fetch names once). Keeps steady-state polling down to
// one cheap request per league instead of re-authenticating and re-fetching
// static franchise names on every single poll.
const cache = {
  mflCookie: null,
  mflCookieAt: 0,
  mflNames: new Map(), // leagueId -> Map<franchiseId, name>
  mflNamesAt: new Map(), // leagueId -> timestamp
  sleeperPlayerMap: null,
  sleeperPlayerMapAt: 0,
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
// latency. At 75ms a steady-state poll spreads ~15 requests over about a
// second, which the 30s cadence absorbs without the tab feeling slower.
//
// Keep it small for a second reason: no maxDuration is configured in
// vercel.json, so this runs under Vercel's default ceiling. A cold start pays
// the interval twice over — once for the TYPE=league names read, once for
// liveScoring — and the gate must stay a rounding error against that budget,
// not a meaningful slice of it.
//
// Module scope, so it is set once per warm instance alongside the caches above.
// 75ms is a starting point chosen against those two constraints, not a measured
// limit — the same caveat that applies to the sync's number.
const LIVE_SCORING_MFL_INTERVAL_MS = 75;
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

async function getMflNames(league, cookie) {
  const at = cache.mflNamesAt.get(league.id) || 0;
  const cached = cache.mflNames.get(league.id);
  if (cached && Date.now() - at < NAMES_TTL_MS) {
    return cached;
  }
  const names = await fetchMflFranchiseNames(league, cookie);
  cache.mflNames.set(league.id, names);
  cache.mflNamesAt.set(league.id, Date.now());
  return names;
}

async function loadLeagueConfig() {
  const raw = await readFile(CONFIG_PATH, 'utf8');
  return JSON.parse(raw).leagues || [];
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

  // One shared fetch of the public NFL scoreboard per poll, not one per
  // league — see fetchNflGameClocks' own comment. A failure here must not
  // cost any ESPN/Sleeper league its actual score, so this degrades to an
  // empty map (every minutesRemaining/winProb comes back 0/undefined for
  // this poll) rather than rejecting.
  let nflClocks = new Map();
  try {
    nflClocks = await fetchNflGameClocks();
  } catch {
    // degrade silently — see comment above.
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

  const results = await Promise.allSettled(
    leagues
      .filter((league) => league.franchiseId)
      .map(async (league) => {
        if (league.provider === 'espn') {
          const projectPlayer = makeProjectPlayer(projections, 'espn', league.scoring);
          const scoring = await fetchEspnScoring(league, nflClocks, projectPlayer);
          return { id: league.id, name: league.name, scoring, scoringError: null };
        }
        if (league.provider === 'sleeper') {
          const players = await getSleeperPlayerMap();
          const projectPlayer = makeProjectPlayer(projections, 'sleeper', league.scoring);
          const scoring = await fetchSleeperScoring(league, nflClocks, players, projectPlayer);
          return { id: league.id, name: league.name, scoring, scoringError: null };
        }
        if (mflLoginError) {
          throw new Error(mflLoginError);
        }
        const names = await getMflNames(league, mflCookie);
        const projectPlayer = makeProjectPlayer(projections, 'mfl', league.scoring);
        const scoring = await fetchScoring(league, mflCookie, names, projectPlayer);
        return { id: league.id, name: league.name, scoring, scoringError: null };
      })
  );

  const leaguesOut = leagues
    .filter((league) => league.franchiseId)
    .map((league, i) => {
      const r = results[i];
      if (r.status === 'fulfilled') return r.value;
      return { id: league.id, name: league.name, scoring: null, scoringError: r.reason?.message || 'Unknown error' };
    });

  res.status(200).json({
    generatedAt: new Date().toISOString(),
    leagues: leaguesOut,
  });
}
