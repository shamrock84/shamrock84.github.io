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
import { fetchScoring, estimateWinProbability } from './lib/providers.mjs';

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
