#!/usr/bin/env node
// Confirms what fetchEspnLineup (providers.mjs) assumes but has never been
// checked against a real league: that ESPN's fantasy roster entries carry a
// `lineupSlotId` where 20 is always the bench slot and 21 is always IR
// (ESPN_IR_SLOT_ID was already relied on by fetchEspnLeagueRoster before
// this probe existed; ESPN_BENCH_SLOT_ID is the new, community-sourced, not
// yet verified value). If bench turns out to be a different id, every ESPN
// league's lineup pilot would silently show bench players as starters.
//
// Also checks the two-request shape fetchEspnLineup relies on: that
// view=mScoreboard's status.currentMatchupPeriod is a sane current week,
// and that re-fetching view=mRoster scoped to that period (rather than the
// scoringPeriodId=1 fetchEspnLeagueRoster uses for its own, period-agnostic
// purpose) actually changes which players carry which lineupSlotId once a
// manager has set a real lineup.
//
// Read-only: two GETs per ESPN league already in config/leagues.json.
// Requires ESPN_S2 and ESPN_SWID like every other ESPN-authenticated call
// in this project — unreachable from the sandbox this repo is normally
// edited from, so a workflow run is the only place to ask.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { espnGet } from './lib/providers.mjs';

const CONFIG_PATH = fileURLToPath(new URL('../config/leagues.json', import.meta.url));
const { leagues } = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));

const espnLeagues = leagues.filter((l) => l.provider === 'espn');
if (espnLeagues.length === 0) {
  console.log('No ESPN leagues in config/leagues.json — nothing to probe.');
  process.exit(0);
}

const ASSUMED_BENCH_SLOT_ID = 20;
const KNOWN_IR_SLOT_ID = 21;

for (const league of espnLeagues) {
  console.log(`\n=== ${league.name} (${league.id}), franchise ${league.franchiseId} ===`);
  try {
    const scoreboard = await espnGet(league, 'view=mScoreboard');
    const period = scoreboard.status?.currentMatchupPeriod || 1;
    console.log(`  currentMatchupPeriod: ${scoreboard.status?.currentMatchupPeriod} (using ${period})`);

    const data = await espnGet(
      league,
      `view=mRoster&rosterForTeamId=${league.franchiseId}&scoringPeriodId=${period}`
    );
    const team = (data.teams || []).find((t) => String(t.id) === String(league.franchiseId));
    if (!team) {
      console.log(`  SKIP — no team ${league.franchiseId} in the roster response.`);
      continue;
    }

    const entries = team.roster?.entries || [];
    if (entries.length === 0) {
      console.log('  No roster entries yet (league likely hasn\'t drafted).');
      continue;
    }

    const bySlot = new Map();
    for (const e of entries) {
      const slot = e.lineupSlotId;
      if (!bySlot.has(slot)) bySlot.set(slot, []);
      bySlot.get(slot).push(e.playerPoolEntry?.player?.fullName || `player ${e.playerId}`);
    }

    console.log(`  ${entries.length} roster entries, grouped by lineupSlotId:`);
    for (const [slot, names] of [...bySlot.entries()].sort((a, b) => a[0] - b[0])) {
      const tag = slot === ASSUMED_BENCH_SLOT_ID ? ' <- assumed BENCH' : slot === KNOWN_IR_SLOT_ID ? ' <- known IR' : '';
      console.log(`    slot ${slot}${tag}: ${names.join(', ')}`);
    }

    const starters = entries.filter((e) => e.lineupSlotId !== ASSUMED_BENCH_SLOT_ID && e.lineupSlotId !== KNOWN_IR_SLOT_ID);
    console.log(`  fetchEspnLineup would report ${starters.length} starter(s): ${starters.map((e) => e.playerPoolEntry?.player?.fullName).join(', ')}`);
  } catch (err) {
    console.log(`  FAILED: ${err.message}`);
  }
}
