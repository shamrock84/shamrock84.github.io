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
} from '../scripts/lib/providers.mjs';

const CONFIG_PATH = fileURLToPath(new URL('../config/leagues.json', import.meta.url));

const ALLOWED_ORIGINS = new Set([
  'https://melbostads.com',
  'https://shamrock84.github.io',
]);

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
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
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
