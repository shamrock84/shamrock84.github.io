// Best-ball win probability (bestBallLineupSpec / bestBallLineupTotal /
// bestBallProjection, wired through fetchScoring). Pins: the lineup fill
// respects each position's min and max and the league total; a bench player
// yet to play can displace a starter; a league without the BestBall tag (or
// without a readable lineup) keeps the starter-only estimate.

import assert from 'node:assert/strict';
import { bestBallLineupSpec, bestBallLineupTotal, bestBallProjection, fetchScoring } from './lib/providers.mjs';

const leagueData = (positions, count) => ({ league: { starters: { count: String(count), position: positions } } });

// --- spec ---
const spec = bestBallLineupSpec(leagueData([
	{ name: 'QB', limit: '1-2' }, { name: 'RB', limit: '2-4' }, { name: 'WR', limit: '3-5' }, { name: 'TE', limit: '1-3' },
], 9));
assert.deepEqual(spec, { positions: { QB: { min: 1, max: 2 }, RB: { min: 2, max: 4 }, WR: { min: 3, max: 5 }, TE: { min: 1, max: 3 } }, total: 9 });
assert.equal(bestBallLineupSpec(leagueData([{ name: 'RB+WR', limit: '1-1' }], 9)), null, 'a flex slot is unsupported: null, not a guess');
assert.equal(bestBallLineupSpec(leagueData([{ name: 'QB', limit: '1-1' }], 'x')), null, 'no readable total');
assert.equal(bestBallLineupSpec(undefined), null);

// --- fill: mins first, then best remaining under each max ---
const small = { positions: { QB: { min: 1, max: 1 }, RB: { min: 1, max: 2 }, WR: { min: 1, max: 3 } }, total: 4 };
const e = (position, value) => ({ position, value });
assert.equal(
	bestBallLineupTotal([e('QB', 20), e('QB', 30), e('RB', 5), e('RB', 40), e('RB', 35), e('WR', 1), e('WR', 2)], small),
	30 + 40 + 2 + 35,
	'QB max 1 keeps the 20 out; the free slot goes to the next-best RB (35), not the WR',
);
assert.equal(
	bestBallLineupTotal([e('QB', 10), e('RB', 10), e('RB', 9), e('RB', 8), e('WR', 1)], small),
	10 + 10 + 1 + 9,
	'RB max 2 blocks the third RB; the minimums are seated even when a bench RB scores more',
);
assert.equal(bestBallLineupTotal([e('QB', 10), e('K', 99)], small), 10, 'a position outside the spec never seats; a short roster seats fewer');

// --- projection: a bench player who has not played can displace a starter ---
const projectPlayer = (p) => ({ S: 10, B: 25 }[p.id] ?? null);
const oneSlot = { positions: { RB: { min: 1, max: 1 } }, total: 1 };
const clocks = new Map([['DAL', 3600], ['MIA', 0]]);
const team = {
	players: [{ id: 'S', position: 'RB', team: 'MIA', points: 8, secondsRemaining: 0 }],
	bench: [{ id: 'B', position: 'RB', team: 'DAL', points: null, secondsRemaining: 0 }],
};
const proj = bestBallProjection(team, oneSlot, projectPlayer, clocks);
assert.equal(proj.projectedScore, 25, 'unplayed bench RB (25 proj) beats the finished starter (8)');
assert.equal(proj.minutes, 60, 'only the bench player still has a game to play');
// Same bench player, game already over with a lower score: the starter stays.
assert.equal(bestBallProjection({ ...team, bench: [{ ...team.bench[0], points: 3 }] }, oneSlot, projectPlayer, new Map([['DAL', 0]])).projectedScore, 8);
// Half-played: actual + prorated projection.
assert.equal(bestBallProjection({ players: [{ id: 'S', position: 'RB', team: 'X', points: 4, secondsRemaining: 1800 }], bench: [] }, oneSlot, projectPlayer, new Map()).projectedScore, 4 + 10 * 0.5);
assert.equal(bestBallProjection({ players: [{ id: 'S', position: null, points: 1, secondsRemaining: 0 }], bench: [] }, oneSlot, projectPlayer, clocks), null, 'no positions (the sync has no player map): null');

// --- through fetchScoring ---
const okJson = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const live = {
	liveScoring: {
		week: '5',
		matchup: [{
			franchise: [
				{ id: '0001', score: '8', gameSecondsRemaining: '0', players: { player: [
					{ id: 'S', score: '8', status: 'starter', gameSecondsRemaining: '0' },
					{ id: 'B', status: 'nonstarter', gameSecondsRemaining: '0' },
				] } },
				{ id: '0002', score: '15', gameSecondsRemaining: '0', players: { player: [
					{ id: 'O', score: '15', status: 'starter', gameSecondsRemaining: '0' },
				] } },
			],
		}],
	},
};
globalThis.fetch = async () => okJson(live);
const playerMap = new Map([
	['S', { name: 'Starter', position: 'RB', team: 'MIA' }],
	['B', { name: 'Bencher', position: 'RB', team: 'DAL' }],
	['O', { name: 'Opp', position: 'RB', team: 'MIA' }],
]);
const info = (lineupSpec) => ({ nameById: new Map([['0001', 'Me'], ['0002', 'Them']]), ownerById: new Map(), lineupSpec });
const scoringFor = async (tags, lineupSpec) => {
	const r = await fetchScoring({ id: '1', franchiseId: '0001', tags }, 'c', info(lineupSpec), projectPlayer, playerMap, undefined, undefined, clocks);
	assert.ok(r.teams.every((t) => !('bestBall' in t)), 'intermediate state is never returned');
	return r.teams.find((t) => t.franchiseId === '0001');
};
const winProbFor = async (tags, lineupSpec) => (await scoringFor(tags, lineupSpec)).winProb;
const plain = await winProbFor([], oneSlot);
const bestBall = await winProbFor(['BestBall'], oneSlot);
const noSpec = await winProbFor(['BestBall'], null);
// Starter-only: my only starter is done at 8 vs 15, only DAL... nothing left -> resolved 0.
assert.equal(plain, 0, 'starter-only estimate: no minutes left on either side, 8 < 15 is decided');
assert.equal(noSpec, plain, 'BestBall without a lineup spec falls back');
// Best ball: my unplayed bench RB projects to 25 > their final 15, so I am the favorite.
assert.ok(bestBall > 50, `bench RB yet to play makes best-ball favorite (got ${bestBall})`);

// --- min left counts the bench in best ball ---
assert.equal((await scoringFor([], oneSlot)).minutesRemaining, 0, 'starter-only: MFL\'s own starters clock');
assert.equal((await scoringFor(['BestBall'], null)).minutesRemaining, 0, 'no lineup spec: unchanged');
assert.equal((await scoringFor(['BestBall'], oneSlot)).minutesRemaining, 60, 'best ball: the unplayed bench RB\'s game counts');
// A position the lineup can't seat never counts toward min left.
assert.equal(bestBallProjection({ players: [], bench: [{ id: 'K', position: 'PK', team: 'DAL', points: null }] }, oneSlot, projectPlayer, clocks).minutes, 0);

console.log('test-best-ball-win-prob: all assertions passed');
