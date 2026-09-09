// Unit test for fetchScoring and estimateWinProbability in
// scripts/lib/providers.mjs.
//
// Real bug: fetchScoring read liveScoring.franchise as a flat per-franchise
// list. TYPE=liveScoring never actually shapes it that way — franchises sit
// two levels down, under liveScoring.matchup[].franchise[], as confirmed by
// probe-live-scoring-matchup.yml against a real in-progress week (league
// 26696, week 1, 2026-09-07; see scripts/probe-live-scoring-matchup.mjs for
// the captured shape). Reading the flat field meant rows.length was always
// 0, so every MFL league's Scoring tab reported "No live scoring available
// yet" no matter what was actually happening in the games — silent, since
// that string is also the correct, expected message in the far more common
// case of no games being live at all.
//
// This fixture is trimmed from the real captured response: five matchups,
// one a bye-like pairing with no player data yet, mirroring what a
// just-kicked-off week 1 actually looked like. gameSecondsRemaining is
// added on top of the real capture's shape to exercise minutesRemaining and
// the win-probability estimate — see probe-win-probability.mjs for why
// MFL's own number isn't fetchable and estimateWinProbability is a
// homegrown stand-in instead.

import assert from 'node:assert/strict';
import { fetchScoring, estimateWinProbability, estimateRemainingPoints } from './lib/providers.mjs';

function stubFetch(handler) {
	globalThis.fetch = async (url) => handler(String(url));
}

const okJson = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

const liveScoringResponse = {
	liveScoring: {
		week: '1',
		matchup: [
			{
				franchise: [
					{ id: '0010', score: '0.0', isHome: '0', players: {}, gameSecondsRemaining: '0' },
					{ id: '0009', score: '0.0', isHome: '1', players: {}, gameSecondsRemaining: '0' },
				],
			},
			{
				franchise: [
					{
						id: '0001', score: '12.4', isHome: '0', gameSecondsRemaining: '32400',
						players: {
							player: [
								{ id: '9001', score: '6.2', status: 'starter', gameSecondsRemaining: '1800', updatedStats: '' },
								{ id: '9002', score: '0.0', status: 'starter', gameSecondsRemaining: '3600', updatedStats: '' },
								{ id: '9003', score: '4.0', status: 'nonstarter', gameSecondsRemaining: '0', updatedStats: '' },
							],
						},
					},
					{ id: '0008', score: '9.1', isHome: '1', players: {}, gameSecondsRemaining: '28800' },
				],
			},
			{
				franchise: [
					{ id: '0003', score: '0.0', isHome: '0', players: {}, gameSecondsRemaining: '0' },
					{ id: '0004', score: '0.0', isHome: '1', players: {}, gameSecondsRemaining: '0' },
				],
			},
		],
	},
};

{
	stubFetch(() => okJson(liveScoringResponse));

	const league = { id: '26696', franchiseId: '0001' };
	const names = new Map([
		['0010', 'Team A'], ['0009', 'Team B'],
		['0001', 'My Team'], ['0008', 'Team D'],
		['0003', 'Team E'], ['0004', 'Team F'],
	]);

	const result = await fetchScoring(league, 'cookie', names);

	assert.equal(result.week, '1');
	assert.equal(result.teams.length, 6, 'all six franchises across the three matchups are read');
	assert.equal(result.matchups.length, 3, 'one matchup entry per pairing, not per franchise');
	assert.deepEqual(
		result.matchups.map((m) => [...m.teamIds].sort()).sort(),
		[['0001', '0008'], ['0003', '0004'], ['0009', '0010']].sort(),
		'each matchup pairs exactly the two franchises playing each other'
	);

	const me = result.teams.find((t) => t.franchiseId === '0001');
	assert.ok(me, 'my franchise is present');
	assert.equal(me.isMe, true);
	assert.equal(me.teamName, 'My Team');
	assert.equal(me.score, '12.40');
	assert.equal(me.minutesRemaining, 540, '32400 seconds is 540 minutes');
	assert.deepEqual(
		me.players,
		[
			{ id: '9001', secondsRemaining: 1800 },
			{ id: '9002', secondsRemaining: 3600 },
		],
		'the nonstarter is excluded — only starters feed the remaining-points model'
	);

	const teamD = result.teams.find((t) => t.franchiseId === '0008');
	assert.equal(teamD.minutesRemaining, 480, '28800 seconds is 480 minutes');
	assert.deepEqual(teamD.players, [], 'an empty players node ({}) reads as no starters, not a crash');
	assert.equal(me.winProb + teamD.winProb, 100, 'a matchup pair\'s win probabilities always sum to 100');
	assert.ok(me.winProb > 50, 'the team ahead on both score and remaining time is favored');

	const teamA = result.teams.find((t) => t.franchiseId === '0010');
	assert.equal(teamA.minutesRemaining, 0, 'a franchise with no remaining game time reports 0, not undefined');
	assert.equal(teamA.winProb, 50, 'a scoreless, timeless bye-like pairing with an equally scoreless opponent is a coin flip');
}

// projectPlayer, threaded through to attachWinProbabilities/
// estimateRemainingPoints: a team whose still-playing starters are
// individually projected high should out-favor the flat per-minute rate
// would have given it, even though nothing about score/minutesRemaining
// changed.
{
	stubFetch(() => okJson(liveScoringResponse));
	const league = { id: '26696', franchiseId: '0001' };
	const names = new Map([['0001', 'My Team'], ['0008', 'Team D']]);

	// 9001 projects far above the flat rate (0.185/min -> ~5.6pts for 1800s);
	// 9002 has no entry at all, so it must fall back to the flat rate
	// individually rather than dragging 9001's real projection down with it.
	const projectPlayer = (p) => (p.id === '9001' ? 40 : null);

	const withoutProjections = await fetchScoring(league, 'cookie', names);
	const withProjections = await fetchScoring(league, 'cookie', names, projectPlayer);

	const meBare = withoutProjections.teams.find((t) => t.franchiseId === '0001');
	const meProjected = withProjections.teams.find((t) => t.franchiseId === '0001');
	assert.ok(
		meProjected.winProb > meBare.winProb,
		'a starter projected well above the flat rate raises this team\'s win probability over the flat-rate baseline'
	);
}

// estimateRemainingPoints in isolation.
{
	const players = [
		{ id: 'a', secondsRemaining: 3600 }, // full game left, has a projection
		{ id: 'b', secondsRemaining: 1800 }, // half a game left, no projection -> flat-rate fallback
		{ id: 'c', secondsRemaining: 0 }, // done playing -> contributes nothing regardless
	];
	const projectPlayer = (p) => (p.id === 'a' ? 20 : null);

	const total = estimateRemainingPoints(players, projectPlayer);
	// a: 20 * (3600/3600) = 20; b: WP_POINTS_PER_MINUTE(0.185) * 30min = 5.55; c: 0.
	assert.ok(Math.abs(total - 25.55) < 0.001, `expected ~25.55, got ${total}`);

	assert.equal(
		estimateRemainingPoints(players, undefined),
		estimateRemainingPoints(players, () => null),
		'omitting projectPlayer entirely behaves the same as one that always misses'
	);

	assert.equal(estimateRemainingPoints([], projectPlayer), 0, 'no players left to play is zero remaining, not NaN');
}

// estimateWinProbability's remainingA/remainingB override.
{
	// Same score/minutes on both sides (a coin flip under the flat rate), but
	// B's own remaining points are projected far higher than A's — B should
	// be favored despite an identical minutesRemaining split.
	const flat = estimateWinProbability(50, 200, 50, 200);
	assert.equal(flat, 50, 'identical score and minutes with no override is still a coin flip');

	const overridden = estimateWinProbability(50, 200, 50, 200, 5, 60);
	assert.ok(overridden < 50, 'B\'s own higher projected remaining points favors B despite equal minutesRemaining');
}

{
	// No matchups at all (empty week) still throws the same "not available
	// yet" error the flat-shape bug always threw — just now for the right
	// reason instead of by accident.
	stubFetch(() => okJson({ liveScoring: { week: '1' } }));
	const league = { id: '26696', franchiseId: '0001' };
	await assert.rejects(
		() => fetchScoring(league, 'cookie', new Map()),
		/No live scoring available yet/
	);
}

// estimateWinProbability's own edge cases, isolated from the network stub.
{
	assert.equal(estimateWinProbability(0, 540, 0, 540), 50, 'a tied, untouched matchup is a coin flip');
	assert.equal(estimateWinProbability(100, 0, 100, 0), 50, 'a finished, tied matchup is a coin flip, not clamped');
	assert.equal(estimateWinProbability(101, 0, 100, 0), 100, 'a finished matchup resolves to the actual winner, unclamped');
	assert.equal(estimateWinProbability(100, 0, 101, 0), 0, 'a finished matchup resolves to the actual loser, unclamped');

	// While ANY player-minute of either side remains, the estimate never
	// reads as a sure thing — even a blowout margin with almost no time
	// left stays inside [1, 99], the same guard mfl_win_prob.js applies.
	const nearCertain = estimateWinProbability(200, 1, 0, 0);
	assert.ok(nearCertain <= 99, 'never 100 while a player-minute remains anywhere in the matchup');
	const nearImpossible = estimateWinProbability(0, 0, 200, 1);
	assert.ok(nearImpossible >= 1, 'never 0 while a player-minute remains anywhere in the matchup');

	// A trailing team that still has (nearly) a full lineup left to play can
	// out-project a leader who is already done — the model reads remaining
	// playing time as upside, not just as uncertainty.
	const aheadButDone = estimateWinProbability(90, 0, 70, 500);
	assert.ok(aheadButDone < 50, 'a current lead from a fully-finished team loses to an opponent with a full game left');
}

console.log('test-live-scoring-matchup.mjs OK');
