// Unit test for applySleepers/attachSleepers in scripts/lib/fantasypros.mjs —
// the "Sleepers" enrichment behind the Power Rankings card's Sleepers
// sub-line in myffl.html.
//
// Confirmed by probe-fantasypros-sleepers.yml against the real API:
// type=SLEEPERS (plural) on the same consensus-rankings endpoint
// attachRankings already calls is a genuine, distinct list — 79 players,
// 17 experts, shaped identically to every other consensus-rankings response.
// type=SLEEPER (singular) is NOT an error; FantasyPros silently serves the
// Draft list back instead, which is why that literal string is worth
// re-checking against the probe rather than "fixing" a typo by feel.
//
// What's pinned here is the join, which is deliberately identical to ECR's
// (buildRankingIndex/lookupPlayer, by normalized name) — nothing about
// attaching a second, independent list needed a different join.

import assert from 'node:assert/strict';
import { buildRankingIndex, applySleepers } from './lib/fantasypros.mjs';

const fpPlayer = (name, rank, pos, team = 'BUF') => ({
	player_name: name,
	rank_ecr: rank,
	pos_rank: `${pos}${rank}`,
	tier: 1,
	player_position_id: pos,
	player_team_id: team,
	player_page_url: `https://www.fantasypros.com/nfl/players/${name.toLowerCase().replace(/\W+/g, '-')}.php`,
});
const rosterPlayer = (name, position, team = 'BUF') => ({ name, position, team });

{
	const index = buildRankingIndex([
		fpPlayer('Breakout Guy', 3, 'WR'),
		fpPlayer('Deep Sleeper', 41, 'RB'),
	]);
	const leagues = [
		{ id: 'A', players: [
			rosterPlayer('Breakout Guy', 'WR'),
			rosterPlayer('Not A Sleeper', 'QB'),
		] },
	];
	const matched = applySleepers(leagues, index);
	assert.equal(matched, 1, 'only the roster player who is actually on the list counts');

	const [breakout, notASleeper] = leagues[0].players;
	assert.deepEqual({ ...breakout.sleeper }, { rank: 3, posRank: 'WR3', tier: 1, url: breakout.sleeper.url },
		'shaped exactly like ecr — the page reuses the same rendering either way');
	assert.equal(notASleeper.sleeper, undefined, 'a player off the list gets no field at all, not a null one');
}

{
	// The same index reused across every league in one sync — the whole
	// reason this is one fetch total rather than one per league.
	const index = buildRankingIndex([fpPlayer('Shared Sleeper', 5, 'TE')]);
	const leagues = [
		{ id: 'A', players: [rosterPlayer('Shared Sleeper', 'TE')] },
		{ id: 'B', players: [rosterPlayer('Shared Sleeper', 'TE'), rosterPlayer('Someone Else', 'RB')] },
	];
	const matched = applySleepers(leagues, index);
	assert.equal(matched, 2, 'the same player rostered in two leagues counts once per league, not once total');
	assert.equal(leagues[0].players[0].sleeper.rank, 5);
	assert.equal(leagues[1].players[0].sleeper.rank, 5);
}

{
	// Same tombstone rule as every other FantasyPros join here: a shared name
	// resolves to nobody rather than a guess, unless position/team break the
	// tie — pinned via applySleepers rather than re-deriving lookupPlayer's
	// own tests (already covered where buildRankingIndex is tested).
	const index = buildRankingIndex([
		fpPlayer('Josh Allen', 1, 'QB', 'BUF'),
		fpPlayer('Josh Allen', 99, 'LB', 'JAX'),
	]);
	const leagues = [{ id: 'A', players: [rosterPlayer('Josh Allen', 'RB', 'KC')] }];
	const matched = applySleepers(leagues, index);
	assert.equal(matched, 0, "position AND team both miss, so it's still ambiguous — no attach");
	assert.equal(leagues[0].players[0].sleeper, undefined);
}

{
	// No crash on the edges: a league with no players array, and an empty
	// index (an empty or malformed API response).
	assert.equal(applySleepers([{ id: 'X' }], buildRankingIndex([])), 0);
	assert.equal(applySleepers([], buildRankingIndex(undefined)), 0);
}

console.log('test-sleepers: all assertions passed');
