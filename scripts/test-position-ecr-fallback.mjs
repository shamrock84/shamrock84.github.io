// Unit test for applyPositionEcrFallback in scripts/fetch-rosters.mjs.
//
// FantasyPros' combined ALL-position list under-covers any single position
// relative to querying it directly (probe-fantasypros-ecr-depth.yml: 518 vs.
// 734 total) — a deep backup QB or a rookie WR can be well within
// FantasyPros' own per-position rankings and still miss the ALL join
// attachRankings does entirely, leaving no `ecr` and so no FantasyPros link
// on the roster card. This pins the fallback that reuses the per-position
// pools fetch-rosters.mjs already fetches for the Depth Charts tab.

import assert from 'node:assert/strict';
import { applyPositionEcrFallback } from './fetch-rosters.mjs';
import { buildRankingIndex } from './lib/fantasypros.mjs';

const fpPlayer = (name, rank, pos, team = 'BUF') => ({
	player_name: name,
	rank_ecr: rank,
	player_position_id: pos,
	player_team_id: team,
	player_page_url: `https://www.fantasypros.com/nfl/players/${name.toLowerCase().replace(/\W+/g, '-')}.php`,
});

// --- Fills a player the primary (ALL-list) join left with no ecr at all -------
{
	const positionEcrIndex = new Map([['QB', buildRankingIndex([fpPlayer('Drew Allar', 54, 'QB', 'PIT')])]]);
	const leagues = [{ players: [{ id: '1', name: 'Drew Allar', position: 'QB', team: 'PIT' }] }];

	const matched = applyPositionEcrFallback(leagues, positionEcrIndex);
	assert.equal(matched, 1);
	const { ecr } = leagues[0].players[0];
	assert.ok(ecr, 'the fallback filled in an ecr object');
	assert.equal(ecr.rank, 54);
	assert.equal(ecr.url, 'https://www.fantasypros.com/nfl/players/drew-allar.php');
}

// --- Never overwrites a player the primary join already matched ---------------
{
	const positionEcrIndex = new Map([['QB', buildRankingIndex([fpPlayer('Drew Allar', 54, 'QB', 'PIT')])]]);
	const already = { rank: 12, posRank: 'QB12', tier: 2, delta: 0, url: 'https://www.fantasypros.com/nfl/players/drew-allar.php' };
	const leagues = [{ players: [{ id: '1', name: 'Drew Allar', position: 'QB', team: 'PIT', ecr: already }] }];

	const matched = applyPositionEcrFallback(leagues, positionEcrIndex);
	assert.equal(matched, 0);
	assert.equal(leagues[0].players[0].ecr, already, 'the exact same object, untouched');
}

// --- No pool for the player's position is a no-op, not a crash ----------------
{
	const positionEcrIndex = new Map([['QB', buildRankingIndex([fpPlayer('Drew Allar', 54, 'QB')])]]);
	const leagues = [{ players: [{ id: '1', name: 'Some Kicker', position: 'K', team: 'BUF' }] }];

	assert.equal(applyPositionEcrFallback(leagues, positionEcrIndex), 0);
	assert.equal(leagues[0].players[0].ecr, undefined);
}

// --- A name present in the position pool but not this player is left alone ----
// (name/position/team disambiguation is lookupPlayer's own job — this only
// checks that a genuine miss doesn't get force-matched.)
{
	const positionEcrIndex = new Map([['WR', buildRankingIndex([fpPlayer('Jayden Higgins', 180, 'WR', 'HOU')])]]);
	const leagues = [{ players: [{ id: '1', name: 'Nobody Ranked', position: 'WR', team: 'HOU' }] }];

	assert.equal(applyPositionEcrFallback(leagues, positionEcrIndex), 0);
}

// --- Empty and missing input ----------------------------------------------------
{
	assert.equal(applyPositionEcrFallback([], new Map()), 0);
	assert.equal(applyPositionEcrFallback(null, new Map()), 0);
	assert.equal(applyPositionEcrFallback([{ players: null }], new Map()), 0);
}

console.log('test-position-ecr-fallback: all assertions passed');
