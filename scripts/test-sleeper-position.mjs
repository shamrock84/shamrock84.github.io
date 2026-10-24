// sleeperFantasyPosition / positionFromPosRank in scripts/lib/providers.mjs.
//
// Sleeper lists a two-way player (Travis Hunter) under a defensive position,
// and taking fantasy_positions[0] blindly put a lone `DB` in the snapshot of a
// fantasy league with no IDP scoring. The rule pinned here: prefer the first
// offensive position Sleeper lists, then `position` if offensive, then
// whatever is listed; and a FantasyPros position rank can vouch for a skill
// position when Sleeper offers none (fetch-rosters.mjs applies that).
// Sleeper's raw payload was not reachable from the sandbox, so both of the
// shapes it could plausibly take for him are covered.

import assert from 'node:assert/strict';
import { sleeperFantasyPosition, positionFromPosRank } from './lib/providers.mjs';

assert.equal(sleeperFantasyPosition({ position: 'WR', fantasy_positions: ['WR'] }), 'WR', 'ordinary player unchanged');
assert.equal(sleeperFantasyPosition({ position: 'DB', fantasy_positions: ['DB', 'WR'] }), 'WR', 'offensive listing beats a leading DB');
assert.equal(sleeperFantasyPosition({ position: 'WR', fantasy_positions: ['DB'] }), 'WR', 'offensive position field beats a lone DB listing');
assert.equal(sleeperFantasyPosition({ position: 'DB', fantasy_positions: ['DB'] }), 'DB', 'nothing offensive: left for the posRank repair');
assert.equal(sleeperFantasyPosition({ position: 'RB', fantasy_positions: [] }), 'RB', 'no fantasy_positions: position');
assert.equal(sleeperFantasyPosition({ fantasy_positions: ['K'] }), 'K', 'kicker kept');
assert.equal(sleeperFantasyPosition({}), '', 'nothing at all is empty, as before');

assert.equal(positionFromPosRank('WR89'), 'WR');
assert.equal(positionFromPosRank('TE1'), 'TE');
assert.equal(positionFromPosRank('K12'), null, 'only skill positions vouch');
assert.equal(positionFromPosRank('DB3'), null);
assert.equal(positionFromPosRank(null), null);

console.log('test-sleeper-position: ok');
