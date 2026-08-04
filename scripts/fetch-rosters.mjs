#!/usr/bin/env node
// Pulls rosters/standings/scoring for every league in config/leagues.json —
// from MFL (login + session cookie) and/or ESPN (espn_s2/SWID cookies) — and
// writes it all into one consolidated data/rosters.json for myffl.html to render.
//
// Requires MFL_USERNAME and MFL_PASSWORD env vars (set as GitHub Actions secrets).
// ESPN leagues additionally require ESPN_S2 and ESPN_SWID env vars; leagues
// without a provider are assumed to be 'mfl'.
//
// Fetch logic lives in scripts/lib/providers.mjs, shared with the live-scoring
// Vercel function in api/live-scoring.js — this file is just orchestration.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  YEAR,
  leagueUrl,
  mflLogin,
  loadPlayerMap,
  fetchNflByeWeeks,
  fetchLeagueRoster,
  fetchStandings,
  fetchScoring,
  fetchMflLineup,
  fetchEspnLeagueRoster,
  fetchEspnStandings,
  fetchEspnScoring,
} from './lib/providers.mjs';

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

async function main() {
  if (!USERNAME || !PASSWORD) {
    throw new Error('MFL_USERNAME and MFL_PASSWORD environment variables are required.');
  }

  const LEAGUES = await loadLeagueConfig();
  const previous = await loadPreviousOutput();
  const previousById = new Map((previous?.leagues ?? []).map((l) => [l.id, l]));

  const cookie = await mflLogin(USERNAME, PASSWORD);
  const playerMap = await loadPlayerMap(cookie);

  let byeWeeks = new Map();
  try {
    byeWeeks = await fetchNflByeWeeks(cookie);
  } catch (err) {
    console.error(`Failed to fetch NFL bye weeks: ${err.message}`);
  }

  const leagues = [];
  for (const league of LEAGUES) {
    if (!league.franchiseId) {
      console.log(`Skipping ${league.name}: no franchiseId configured yet`);
      leagues.push({
        id: league.id,
        name: league.name,
        type: league.type,
        format: league.format || null,
        tags: league.tags || [],
        leagueName: league.name,
        franchiseId: null,
        teamName: league.name,
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
        : await fetchLeagueRoster(league, cookie, playerMap, byeWeeks);
      result.tags = league.tags || [];
      leagues.push(result);
      console.log(`Fetched ${league.name}: ${result.players.length} players`);
    } catch (err) {
      console.error(`Failed to fetch ${league.name}: ${err.message}`);
      const prev = previousById.get(league.id);
      leagues.push({
        id: league.id,
        name: league.name,
        type: league.type,
        format: league.format || null,
        tags: league.tags || [],
        leagueName: prev?.leagueName || league.name,
        franchiseId: league.franchiseId,
        teamName: prev?.teamName || league.name,
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
  // this can't affect any other league's data.
  for (const league of LEAGUES) {
    if (!league.lineupPilot || league.provider === 'espn') continue;
    const target = leagues.find((l) => l.id === league.id);
    if (!target || !league.franchiseId) continue;
    try {
      const { week, starterIds } = await fetchMflLineup(league, cookie);
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

  const output = {
    generatedAt: new Date().toISOString(),
    year: YEAR,
    leagues,
  };

  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n');
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
