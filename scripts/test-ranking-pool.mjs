// Unit test for buildRankingList in scripts/lib/fantasypros.mjs — the pool the
// Top Available card is filtered from.
//
// Two decisions worth pinning, both silent when wrong:
//
//   - kickers and defenses are excluded, because nobody rosters them in a
//     keeper league and they are therefore permanently on every wire. They
//     were 38% of the Dynasty/Salary Cap card before this;
//   - the exclusion happens *before* the truncation, so RANKING_POOL_SIZE buys
//     250 claimable players rather than 250 minus whatever kickers happened to
//     rank inside it. Getting that order wrong costs reach without any visible
//     symptom — the card just quietly stops a little shallower.
//
// What this must NOT do is filter the ECR lookup: a kicker on your own roster
// still gets his rank on the roster card. That's buildRankingIndex, a separate
// path over the same response, and the guard for it is at the bottom.

import assert from 'node:assert/strict';
import { buildRankingList, buildRankingIndex, RANKING_POOL_SIZE } from './lib/fantasypros.mjs';

// FantasyPros' consensus-rankings shape, trimmed to the fields read here.
const fpPlayer = (name, rank, pos) => ({
	player_name: name,
	rank_ecr: rank,
	player_position_id: pos,
	player_team_id: 'BUF',
	player_page_url: `https://www.fantasypros.com/nfl/players/${name.toLowerCase().replace(/\W+/g, '-')}.php`,
});

// --- Kickers and defenses are dropped -----------------------------------------
{
	const list = buildRankingList([
		fpPlayer('Skill Guy', 1, 'WR'),
		fpPlayer('Justin Tucker', 2, 'K'),
		fpPlayer('Ravens', 3, 'DST'),
		fpPlayer('Another Skill Guy', 4, 'RB'),
	]);
	assert.deepEqual(list.map((p) => p.name), ['Skill Guy', 'Another Skill Guy']);
}

// --- The aliases are canonicalised before the check ---------------------------
// MFL and ESPN spell these differently; POSITION_ALIASES folds PK -> K and
// DEF / D/ST -> DST. Filtering on the raw string would let the aliases through.
{
	const list = buildRankingList([
		fpPlayer('Kicker By Another Name', 1, 'PK'),
		fpPlayer('Defense By Another Name', 2, 'DEF'),
		fpPlayer('Slash Defense', 3, 'D/ST'),
		fpPlayer('Real Player', 4, 'TE'),
	]);
	assert.deepEqual(list.map((p) => p.name), ['Real Player']);
}

// --- The filter runs before the truncation ------------------------------------
// Interleave a kicker every third entry across more than a full pool's worth.
// If the slice ran first the list would come back short on real players.
{
	const players = [];
	for (let i = 1; i <= RANKING_POOL_SIZE * 2; i++) {
		players.push(fpPlayer(i % 3 === 0 ? `Kicker ${i}` : `Player ${i}`, i, i % 3 === 0 ? 'K' : 'WR'));
	}
	const list = buildRankingList(players);
	assert.equal(list.length, RANKING_POOL_SIZE, 'the pool still fills to its full depth');
	assert.equal(list.filter((p) => p.position === 'K').length, 0);
	assert.equal(list[0].name, 'Player 1', 'and is still ordered best first');
}

// --- Unranked players are dropped, ranked ones are ordered --------------------
{
	const list = buildRankingList([
		fpPlayer('Late', 50, 'WR'),
		fpPlayer('Unranked', null, 'WR'),
		{ player_name: 'No Rank Field', player_position_id: 'RB' },
		fpPlayer('Early', 2, 'RB'),
		{ rank_ecr: 1, player_position_id: 'WR' },
	]);
	assert.deepEqual(list.map((p) => p.name), ['Early', 'Late']);
}

// --- URLs are stored site-relative --------------------------------------------
// The origin repeated 750 times is 40KB of nothing; the page puts it back.
{
	const [only] = buildRankingList([fpPlayer('Ja Marr Chase', 1, 'WR')]);
	assert.equal(only.url, '/nfl/players/ja-marr-chase.php');
	assert.ok(!only.url.startsWith('http'), 'never the absolute form');
}

// --- Every entry carries an NFL team, canonicalised, never blank ---------------
// The page prints this beside the name the way the roster tables do, and it has
// to come off the pool entry because a row on that card is by definition a
// player no roster of ours holds. 'FA' rather than '' when FantasyPros has no
// team for someone: the page reads an *absent* team as "synced before this
// existed, say nothing" and a present one as a fact, so an empty string would
// land a player with no NFL team in the wrong bucket. Codes are canonicalised
// for the same reason they are in buildRankingIndex.
{
	const list = buildRankingList([
		fpPlayer('Buffalo Guy', 1, 'WR'),
		{ ...fpPlayer('Raider', 2, 'RB'), player_team_id: 'LVR' },
		{ ...fpPlayer('Unsigned', 3, 'RB'), player_team_id: '' },
		{ ...fpPlayer('No Field At All', 4, 'TE'), player_team_id: undefined },
	]);
	assert.deepEqual(list.map((p) => p.team), ['BUF', 'LV', 'FA', 'FA']);
	assert.ok(list.every((p) => typeof p.team === 'string' && p.team.length > 0), 'never blank, never absent');
}

// --- Empty and missing input ---------------------------------------------------
{
	assert.deepEqual(buildRankingList([]), []);
	assert.deepEqual(buildRankingList(null), []);
	assert.deepEqual(buildRankingList(undefined), []);
	assert.deepEqual(buildRankingList([fpPlayer('Only A Kicker', 1, 'K')]), []);
}

// --- The ECR lookup is deliberately NOT filtered -------------------------------
// Same response, different path. A kicker or defense on your own roster still
// gets a rank in the ECR column of the roster card — dropping them from the
// pool is about what the *wire* shows, not about what your team is worth.
// Filtering both would be the easy mistake, and it would blank a column rather
// than shortening a list, so it's worth a guard of its own.
{
	const players = [fpPlayer('Justin Tucker', 2, 'K'), fpPlayer('Ravens', 3, 'DST'), fpPlayer('Skill Guy', 1, 'WR')];
	assert.equal(buildRankingList(players).length, 1, 'the pool drops them');

	const index = buildRankingIndex(players);
	assert.ok(index.get('justin tucker'), 'the ECR lookup keeps the kicker');
	assert.equal(index.get('justin tucker')[0].ecr, 2);
	assert.ok(index.get('ravens'), 'and the defense');
	assert.equal(index.get('ravens')[0].ecr, 3);
}

console.log('test-ranking-pool: all assertions passed');
