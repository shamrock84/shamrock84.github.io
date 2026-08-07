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
} from './lib/providers.mjs';
import { attachRankings, fantasyProsApiKey, nflSeasonPhase } from './lib/fantasypros.mjs';

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

// Which season each league is actually read from, resolved per league rather
// than taken from the calendar.
//
// The problem this solves: leagues don't roll over together. An MFL commissioner
// might create the new season in February or in April, entirely at their own
// pace, and a redraft league on ESPN or Sleeper later still. A single global
// year is therefore wrong for somebody for months, and the failure is quiet —
// every card falls back to its previous entry and shows a stale roster.
//
// So: aim at the current NFL season, and fall back to whatever the league was
// last read from until the new season actually exists.
//
//   - Already on the target      -> use it, no probe. This is the common case
//                                   and costs nothing all season long.
//   - Pinned in config           -> use the pin, no probe. Manual override.
//   - Otherwise                  -> ask the provider whether the target season
//                                   exists yet; if not, stay where we were.
//
// Deliberately one-way. A league that has rolled over never goes back, so a
// transient provider hiccup can't drag a league backwards into last season —
// the worst a failed probe can do is leave things exactly as they already are.
export async function resolveSeason(league, previous, target, probes) {
  // An explicit season in config/leagues.json pins the league and opts it out
  // of probing entirely, the same way rankingType opts out of the seasonal
  // ranking flip.
  if (league.season) return { season: String(league.season), pinned: true };

  const last = previous?.season ? String(previous.season) : null;
  if (last === String(target)) return { season: last, rolledOver: false };

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

  const exists = league.provider === 'espn'
    ? await probes.espn(league, String(target))
    : await probes.mfl(league, String(target));

  if (exists) return { season: String(target), rolledOver: Boolean(last) };
  return { season: last || String(target), waiting: true };
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
        leagueName: league.name,
        franchiseId: null,
        teamName: league.name,
        season: league.season,
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
      // Recorded per league because it's what the next sync reads to decide
      // whether this league has already rolled over — see resolveSeason.
      result.season = league.season;
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
        leagueName: prev?.leagueName || league.name,
        franchiseId: league.franchiseId,
        teamName: prev?.teamName || league.name,
        season: league.season,
        url: prev?.url || leagueUrl(league),
        players: prev?.players || [],
        updatedAt: prev?.updatedAt || null,
        error: err.message,
      });
    }
  }

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

  // FantasyPros consensus rankings, layered over whatever rosters we managed
  // to fetch above. Skipped entirely without an API key so the sync behaves
  // exactly as it did before this existed, and never allowed to fail the run
  // — every league keeps its roster whether or not rankings came through.
  const fpApiKey = fantasyProsApiKey();
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
      const summary = await attachRankings(leagues, LEAGUES, { apiKey: fpApiKey, season, now });
      for (const line of summary) console.log(`FantasyPros — ${line}`);
    } catch (err) {
      console.error(`Failed to attach FantasyPros rankings: ${err.message}`);
    }
  }

  const output = {
    generatedAt: new Date().toISOString(),
    // The season being aimed at. Individual leagues can legitimately trail it
    // during the rollover window, so each carries its own `season` too.
    year: String(targetSeason),
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
