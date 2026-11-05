// Pins espnStartingLineupRequirement (providers.mjs): ESPN's view=mSettings
// lineupSlotCounts -> the "1 QB, 2-3 RB, ..." string the Game-Time Watchlist's
// swap check reads. Born from LHF offering a QB as a WR's backup because ESPN
// leagues shipped startingLineup: null, which filters nothing.
//
// The counts below are the REAL ones from probe-espn-lineup-slot-counts.mjs
// RUN 1 (2026-11-05). Pinned:
//   * the two real leagues map to the expected strings. They use DIFFERENT
//     slot ids for receivers (LHF's WRs sit in slot 5, WR/TE; the other
//     league's in slot 4, WR only), so a fixed id->position guess is wrong.
//   * bench (20) and IR (21) are not lineup slots.
//   * any slot id we can't name, with a count, makes the result null rather
//     than a partial string; no settings is null too.
//   * end to end: with LHF's string, the push's resolveBackup (a duplicate
//     of the page's picker rule, pinned against it elsewhere) refuses a QB
//     for a WR, while still allowing the legal swaps.

import assert from 'node:assert/strict';
import { espnStartingLineupRequirement } from './lib/providers.mjs';
import { resolveBackup } from '../api/_lib/gametime.mjs';

const counts = (o) => ({ lineupSlotCounts: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [String(i), o[i] || 0])) });

// LHF (421871710): 1 QB, 2 RB, 2 WR/TE, 1 FLEX, D/ST, K, 7 bench, 1 IR.
const LHF = counts({ 0: 1, 2: 2, 5: 2, 16: 1, 17: 1, 20: 7, 21: 1, 23: 1 });
assert.equal(espnStartingLineupRequirement(LHF), '1 QB, 2-3 RB, 0-3 WR, 0-3 TE, 1 PK, 1 Def');

// The other ESPN league (1966972): 1 QB, 2 RB, 2 WR, 1 TE, 1 FLEX, D/ST, K.
const OTHER = counts({ 0: 1, 2: 2, 4: 2, 6: 1, 16: 1, 17: 1, 20: 6, 23: 1 });
assert.equal(espnStartingLineupRequirement(OTHER), '1 QB, 2-3 RB, 2-3 WR, 1-2 TE, 1 PK, 1 Def');

// Superflex (7) lets a QB in, and a RB/WR slot (3) widens both.
assert.equal(espnStartingLineupRequirement(counts({ 0: 1, 2: 2, 4: 2, 7: 1, 16: 1, 17: 1 })), '1-2 QB, 2-3 RB, 2-3 WR, 0-1 TE, 1 PK, 1 Def');
assert.equal(espnStartingLineupRequirement(counts({ 0: 1, 3: 1, 6: 1 })), '1 QB, 0-1 RB, 0-1 WR, 1 TE');

// Unknown slot with a count (8 = an IDP slot): never a partial guess.
assert.equal(espnStartingLineupRequirement(counts({ 0: 1, 2: 2, 8: 1 })), null);
// Unknown slot with a zero count is just ESPN listing every id.
assert.equal(espnStartingLineupRequirement(counts({ 0: 1, 2: 2, 8: 0 })), '1 QB, 2 RB');
// Missing or empty settings.
assert.equal(espnStartingLineupRequirement(undefined), null);
assert.equal(espnStartingLineupRequirement({}), null);
assert.equal(espnStartingLineupRequirement(counts({ 20: 7, 21: 1 })), null, 'bench and IR alone are not a lineup');

// End to end against LHF's roster shape.
const p = (id, name, position, extra = {}) => ({ id, name, position, team: 'DAL', status: 'ROSTER', ...extra });
const league = {
  startingLineup: espnStartingLineupRequirement(LHF),
  starters: ['qb', 'rb1', 'rb2', 'wr1', 'wr2', 'flex', 'dst', 'k'],
  players: [
    p('qb', 'Joe Burrow', 'QB'), p('rb1', 'James Cook', 'RB'), p('rb2', 'Kyren Williams', 'RB'),
    p('wr1', 'CeeDee Lamb', 'WR'), p('wr2', 'Christian Watson', 'WR'), p('flex', 'Chris Olave', 'WR'),
    p('dst', 'Lions', 'D/ST'), p('k', 'Chase McLaughlin', 'K'),
    p('maye', 'Drake Maye', 'QB'), p('corum', 'Blake Corum', 'RB'), p('downs', 'Josh Downs', 'WR'), p('love', 'Colston Loveland', 'TE'),
  ],
};
const lamb = league.players.find((x) => x.id === 'wr1');
const pick = (id) => resolveBackup(league, lamb, id, new Map()).source === 'chosen';
assert.equal(pick('maye'), false, 'a QB can never replace a WR here: the one QB slot is taken');
assert.equal(pick('downs'), true, 'a WR can');
assert.equal(pick('love'), true, 'a TE can (WR/TE slot)');
assert.equal(pick('corum'), true, 'a RB can (the FLEX widens RB to 2-3)');

// The old behaviour, for contrast: no string, nothing filtered.
const bare = { ...league, startingLineup: null };
assert.equal(resolveBackup(bare, lamb, 'maye', new Map()).source, 'chosen', 'without the string the QB slips through');

console.log('espn lineup requirement: ok');
