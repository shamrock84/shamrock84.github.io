#!/usr/bin/env node
// Asks ESPN what each league's starting lineup REQUIRES, so the sync can emit
// a `startingLineup` string for ESPN leagues the way it already does for MFL
// (formatStartingLineupRequirement). Today ESPN ships `startingLineup: null`,
// which makes the Game-Time Watchlist's swapKeepsLineupLegal filter nothing,
// so a QB is offered as the backup for a WR (LHF, 2026-11-04).
//
// Read-only: one view=mSettings GET plus one view=mRoster GET per ESPN league
// in config/leagues.json. Needs ESPN_S2 and ESPN_SWID, so it runs only from
// probe-espn-lineup-slot-counts.yml (ESPN is unreachable from the sandbox).
//
// What it prints, per league, and what to confirm from it:
//   1. settings.rosterSettings.lineupSlotCounts — {slotId: count}. The
//      hypothesis is the community-documented mapping (0 QB, 2 RB, 4 WR,
//      6 TE, 16 D/ST, 17 K, 23 FLEX, 7 OP/superflex, 20 bench, 21 IR), but
//      NONE of it is verified for our leagues. Slots with a count of 0 are
//      dropped from the printout.
//   2. rosterSettings.positionLimits / lineupSlotStatLimits, in case a
//      league caps a position separately from its slots.
//   3. For each slot id with a count, the lineupSlotId each current roster
//      entry sits in alongside the player's defaultPositionId and
//      `eligibleSlots`. A slot id is only trusted as "RB" if the entries in
//      it really are RBs; FLEX should hold RB/WR/TE and nothing else.
//   4. A line saying which of the hypothesised slot ids the league does NOT
//      use, and any slot id present that the hypothesis has no name for.
//
// RUN 1: not yet run. Record the findings here before writing the mapper.

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

// Hypothesis only. Printed beside the real ids; never imported by the sync.
const HYPOTHESIS = {
  0: 'QB', 2: 'RB', 4: 'WR', 6: 'TE', 7: 'OP (superflex)', 16: 'D/ST', 17: 'K',
  20: 'BENCH', 21: 'IR', 23: 'FLEX (RB/WR/TE)',
};
const POSITION = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'D/ST' };

const label = (slot) => HYPOTHESIS[slot] || '??? (not in hypothesis)';

for (const league of espnLeagues) {
  console.log(`\n=== ${league.name} (${league.id}), franchise ${league.franchiseId} ===`);
  try {
    const settings = await espnGet(league, 'view=mSettings');
    const roster = settings.settings?.rosterSettings;
    if (!roster) {
      console.log('  No settings.rosterSettings in the response. Top-level keys:', Object.keys(settings));
      console.log('  settings keys:', Object.keys(settings.settings || {}));
      continue;
    }
    console.log('  rosterSettings keys:', Object.keys(roster).join(', '));

    const counts = roster.lineupSlotCounts || {};
    console.log('  lineupSlotCounts (raw):', JSON.stringify(counts));
    const used = Object.entries(counts)
      .map(([slot, n]) => [Number(slot), Number(n)])
      .filter(([, n]) => n > 0)
      .sort((a, b) => a[0] - b[0]);
    console.log('  slots with a count > 0:');
    for (const [slot, n] of used) console.log(`    slot ${slot} x${n}  hypothesis: ${label(slot)}`);

    const starterTotal = used.filter(([s]) => s !== 20 && s !== 21).reduce((sum, [, n]) => sum + n, 0);
    console.log(`  starter slots (everything but 20/21): ${starterTotal}`);
    const missing = Object.keys(HYPOTHESIS).map(Number).filter((s) => !used.some(([u]) => u === s));
    console.log(`  hypothesised slots this league does not use: ${missing.join(', ') || 'none'}`);

    if (roster.positionLimits) console.log('  positionLimits:', JSON.stringify(roster.positionLimits));
    if (roster.lineupSlotStatLimits && Object.keys(roster.lineupSlotStatLimits).length) {
      console.log('  lineupSlotStatLimits:', JSON.stringify(roster.lineupSlotStatLimits));
    }
    console.log('  rosterSettings extras:', JSON.stringify(
      Object.fromEntries(Object.entries(roster).filter(([k]) => !['lineupSlotCounts', 'positionLimits', 'lineupSlotStatLimits'].includes(k))),
    ));

    // Cross-check the ids against a real lineup: who sits in each slot.
    const scoreboard = await espnGet(league, 'view=mScoreboard');
    const period = scoreboard.status?.currentMatchupPeriod || 1;
    const data = await espnGet(league, `view=mRoster&rosterForTeamId=${league.franchiseId}&scoringPeriodId=${period}`);
    const team = (data.teams || []).find((t) => String(t.id) === String(league.franchiseId));
    const entries = team?.roster?.entries || [];
    if (entries.length === 0) {
      console.log('  No roster entries to cross-check against.');
      continue;
    }
    const bySlot = new Map();
    for (const e of entries) {
      const p = e.playerPoolEntry?.player;
      const pos = POSITION[p?.defaultPositionId] || `pos${p?.defaultPositionId}`;
      const row = `${p?.fullName || e.playerId} [${pos}] eligibleSlots=${JSON.stringify(p?.eligibleSlots)}`;
      if (!bySlot.has(e.lineupSlotId)) bySlot.set(e.lineupSlotId, []);
      bySlot.get(e.lineupSlotId).push(row);
    }
    console.log(`  week ${period} lineup, by lineupSlotId (check each slot holds the positions its name implies):`);
    for (const [slot, rows] of [...bySlot.entries()].sort((a, b) => a[0] - b[0])) {
      const counted = counts[slot] != null ? `count ${counts[slot]}` : 'NO lineupSlotCounts ENTRY';
      console.log(`    slot ${slot} (${label(slot)}; ${counted}):`);
      for (const r of rows) console.log(`      ${r}`);
    }
  } catch (err) {
    console.log(`  FAILED: ${err.message}`);
  }
}
