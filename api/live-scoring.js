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
  setMflRequestInterval,
} from '../scripts/lib/providers.mjs';
import { applyCors } from './lib/cors.mjs';

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
};

const COOKIE_TTL_MS = 20 * 60 * 1000; // 20 min
const NAMES_TTL_MS = 60 * 60 * 1000; // 1 hour

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

  const results = await Promise.allSettled(
    leagues
      .filter((league) => league.franchiseId)
      .map(async (league) => {
        if (league.provider === 'espn') {
          const scoring = await fetchEspnScoring(league);
          return { id: league.id, name: league.name, scoring, scoringError: null };
        }
        if (league.provider === 'sleeper') {
          const scoring = await fetchSleeperScoring(league);
          return { id: league.id, name: league.name, scoring, scoringError: null };
        }
        if (mflLoginError) {
          throw new Error(mflLoginError);
        }
        const names = await getMflNames(league, mflCookie);
        const scoring = await fetchScoring(league, mflCookie, names);
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
