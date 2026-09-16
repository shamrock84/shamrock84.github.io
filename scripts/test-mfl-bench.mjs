// Unit test for the MFL half of the Scoring tab's nested "Show bench"
// drawer — mflNonstarterBench in scripts/lib/providers.mjs, exercised
// through fetchScoring.
//
// Three approaches were tried here, in order, each replaced for a real bug:
//
// 1. Filtering TYPE=liveScoring's plain (no-argument) players.player list
//    for status === 'nonstarter'. Wrong on arrival: probe-live-scoring-
//    players.mjs RUN 1 (2026-09-10) found that list carrying only the 9
//    starters, zero nonstarters, for a league that certainly has a bench —
//    a warning nobody re-checked before shipping a drawer that said
//    "waiting on the next live update" forever.
//
// 2. TYPE=rosters (identity) joined against TYPE=playerScores&RULES=1
//    (points, this league's own recalculated score for a player) — two
//    extra MFL requests per league, every poll a bench drawer was open.
//    This shipped, then broke twice: first because playerScores was asked
//    for api/live-scoring.js's own independently-resolved "current week"
//    (Sleeper's /state/nfl) rather than this response's own week, so a
//    week mismatch (RUN 9, 2026-09-16, a Wednesday with week 1 final but
//    Sleeper's state already on week 2) made every bench score read null.
//    Re-pointed at the right week, it broke again: RUN 10 (2026-09-16)
//    found playerScores&RULES=1 itself unreliable for nonstarters — of 137
//    ids present in both playerScores and (see below) liveScoring&
//    DETAILS=1, only 8 agreed and 129 disagreed, every disagreement
//    playerScores confidently reporting 0 for a player DETAILS=1 showed a
//    real, often large score.
//
// 3. TYPE=liveScoring&DETAILS=1 — the fix. Confirmed live by RUN 9: 227
//    total entries (79 starter, 148 nonstarter), every nonstarter carrying
//    a real, non-null score. Same single request fetchScoring already
//    makes for starters, so bench costs nothing extra — the same "for
//    free" posture ESPN's mRoster and Sleeper's matchups already had.
// Never resurrect approaches 1 or 2; see mflPlayerEntry's own comment in
// providers.mjs and mfl/README.md's DETAILS=1 bullet for the same history.

import assert from 'node:assert/strict';
import { fetchScoring } from './lib/providers.mjs';

function stubFetch(handler) {
	globalThis.fetch = async (url) => handler(String(url));
}

const okJson = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

// Real shape confirmed by probe-live-scoring-players.mjs RUN 8/9/10 against
// league 26696: players.player carries BOTH statuses under DETAILS=1, each
// with its own real `score`.
const liveScoringResponse = {
	liveScoring: {
		week: '1',
		matchup: [
			{
				franchise: [
					{
						id: '0001', score: '20.5', isHome: '0', gameSecondsRemaining: '32400',
						players: {
							player: [
								{ id: '9001', score: '6.2', status: 'starter', gameSecondsRemaining: '1800' },
								{ id: '9002', score: '0.0', status: 'starter', gameSecondsRemaining: '3600' },
								{ id: '9010', score: '14.3', status: 'nonstarter', gameSecondsRemaining: '0' },
								// A rostered bench player whose game hasn't produced a
								// score yet — absent field, not a zero.
								{ id: '9099', status: 'nonstarter', gameSecondsRemaining: '0' },
							],
						},
					},
					{
						id: '0008', score: '9.1', isHome: '1', gameSecondsRemaining: '28800',
						players: {
							// A single-nonstarter roster: bare object, not an array —
							// same object-or-array-or-absent convention every other
							// MFL list export in this project follows.
							player: { id: '9020', status: 'nonstarter', score: '', gameSecondsRemaining: '0' },
						},
					},
				],
			},
		],
	},
};

{
	stubFetch((url) => {
		if (url.includes('TYPE=liveScoring')) return okJson(liveScoringResponse);
		throw new Error(`test-mfl-bench.mjs: unexpected fetch ${url} — bench must not cost a second request`);
	});
	const league = { id: '26696', franchiseId: '0001' };
	const names = { nameById: new Map([['0001', 'My Team'], ['0008', 'Team D']]), ownerById: new Map() };
	const playerMap = new Map([
		['9010', { name: 'Bench Guy', position: 'WR', team: 'MIA' }],
		['9099', { name: 'No Score Yet', position: 'RB', team: 'DAL' }],
	]);

	const result = await fetchScoring(league, 'cookie', names, undefined, playerMap);
	const me = result.teams.find((t) => t.franchiseId === '0001');

	assert.deepEqual(
		me.bench,
		[
			{ id: '9010', secondsRemaining: 0, name: 'Bench Guy', position: 'WR', team: 'MIA', points: 14.3, stats: [] },
			{ id: '9099', secondsRemaining: 0, name: 'No Score Yet', position: 'RB', team: 'DAL', points: null, stats: [] },
		],
		'9001/9002 are excluded (status starter); 9010 carries its real DETAILS=1 score; 9099 has none yet and reads null, not 0 — and secondsRemaining is always 0 regardless of the raw gameSecondsRemaining field'
	);

	// Franchise 0008's single nonstarter (bare object, not an array) with an
	// empty score string still renders, unresolved rather than dropped.
	const teamD = result.teams.find((t) => t.franchiseId === '0008');
	assert.deepEqual(
		teamD.bench,
		[{ id: '9020', secondsRemaining: 0, name: null, position: null, team: null, points: null, stats: [] }],
		'a bare-object nonstarter with no playerMap entry and an empty score string still renders, unresolved rather than dropped'
	);
}

// --- No second request, ever — bench is never gated on anything ---
{
	let fetchCount = 0;
	stubFetch((url) => {
		fetchCount++;
		if (url.includes('TYPE=liveScoring')) return okJson(liveScoringResponse);
		throw new Error(`test-mfl-bench.mjs: unexpected fetch ${url}`);
	});
	const league = { id: '26696', franchiseId: '0001' };
	const names = { nameById: new Map([['0001', 'My Team'], ['0008', 'Team D']]), ownerById: new Map() };
	const result = await fetchScoring(league, 'cookie', names);
	const me = result.teams.find((t) => t.franchiseId === '0001');
	assert.equal(fetchCount, 1, 'fetchScoring must make exactly one request regardless of whether playerMap/bench-only inputs are supplied');
	assert.equal(me.bench.length, 2, 'bench is always populated — no opt-in parameter gates it');
}

// --- The DETAILS=1 request itself ---
{
	let sawUrl = null;
	stubFetch((url) => {
		sawUrl = url;
		return okJson(liveScoringResponse);
	});
	const league = { id: '26696', franchiseId: '0001' };
	const names = { nameById: new Map([['0001', 'My Team'], ['0008', 'Team D']]), ownerById: new Map() };
	await fetchScoring(league, 'cookie', names);
	assert.ok(sawUrl && /[?&]DETAILS=1(&|$)/.test(sawUrl), `fetchScoring must request DETAILS=1 for bench to appear at all, got: ${sawUrl}`);
}

console.log('test-mfl-bench.mjs OK');
