// Unit test for the MFL half of the Scoring tab's nested "Show bench"
// drawer — fetchMflLeagueRosterIds, fetchMflWeekPlayerScores and
// mflBenchFromRoster in scripts/lib/providers.mjs.
//
// Real bug: the drawer originally shipped reading `bench` off a
// 'nonstarter' filter over TYPE=liveScoring's players.player list — the
// same list mflLiveStarters reads for starters. That assumption ("this
// list carries the WHOLE roster") was already flagged wrong by a probe run
// left in scripts/probe-live-scoring-players.mjs (RUN 1, 2026-09-10:
// 9 entries, all starters, zero nonstarters, for a league that certainly
// has a bench) — a warning nobody re-checked before building bench on top
// of it. A second run on 2026-09-14, days later with the week's games long
// final, confirmed the same thing again for the same league: 9 entries,
// all status 'starter'. So the original bench feature filtered a list that
// structurally never contains what it was looking for, and every MFL
// league's "Show bench" drawer said "waiting on the next live update"
// forever.
//
// The fix: bench identity comes from TYPE=rosters (who's even on a
// franchise at all — fetchMflLeagueRosterIds) and bench points come from
// TYPE=playerScores&RULES=1 (this league's own recalculated score for
// every player it knows about, not just this franchise's lineup —
// fetchMflWeekPlayerScores), both confirmed live by
// probe-live-scoring-players.yml RUN 4 (playerScores) and the sync's own
// existing TYPE=rosters use (fetchMflRosteredNames). mflBenchFromRoster
// joins the two against the starter ids mflLiveStarters already found.

import assert from 'node:assert/strict';
import { fetchMflLeagueRosterIds, fetchMflWeekPlayerScores, fetchScoring } from './lib/providers.mjs';

function stubFetch(handler) {
	globalThis.fetch = async (url) => handler(String(url));
}

const okJson = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

// --- fetchMflLeagueRosterIds ---
{
	// Real TYPE=rosters shape: an array of franchises when there's more than
	// one, each franchise's own `player` object-or-array-or-absent (see
	// mflRosterPlayers' own comment) — a bare object for a one-player
	// roster, nothing at all for an empty one.
	const data = {
		rosters: {
			franchise: [
				{ id: '0001', player: [{ id: '9001', status: 'ROSTER' }, { id: '9003', status: 'TAXI_SQUAD' }] },
				{ id: '0002', player: { id: '9010', status: 'ROSTER' } }, // single player: bare object, not an array
				{ id: '0003' }, // no players at all: the key is simply absent
			],
		},
	};
	stubFetch(() => okJson(data));
	const league = { id: '26696' };
	const byFranchise = await fetchMflLeagueRosterIds(league, 'cookie');

	assert.deepEqual(byFranchise.get('0001'), ['9001', '9003']);
	assert.deepEqual(byFranchise.get('0002'), ['9010'], 'a single-player roster (bare object, not an array) still returns an array of ids');
	assert.deepEqual(byFranchise.get('0003'), [], 'an empty roster is an empty array, not a missing key');

	// A league with exactly one franchise total: TYPE=rosters' own
	// franchise node is a bare object too, same array-or-object-or-absent
	// convention every other MFL export in this project follows.
	stubFetch(() => okJson({ rosters: { franchise: { id: '0001', player: { id: '9001' } } } }));
	const single = await fetchMflLeagueRosterIds(league, 'cookie');
	assert.deepEqual(single.get('0001'), ['9001']);
}

// --- fetchMflWeekPlayerScores ---
{
	// Real shape confirmed by probe-live-scoring-players.yml RUN 4:
	// {id, isAvailable, score, week} — no per-rule breakdown, just the one
	// recalculated total under this league's own rules.
	const data = {
		playerScores: {
			playerScore: [
				{ id: '9001', isAvailable: '0', score: '24.5', week: '1' },
				{ id: '9010', isAvailable: '0', score: '0.0', week: '1' }, // a genuine zero must survive as 0
				{ id: '9099', isAvailable: '1', score: '', week: '1' }, // empty score: hasn't been recalculated at all
				{ id: '9100', isAvailable: '1', week: '1' }, // score key absent entirely
			],
		},
	};
	stubFetch(() => okJson(data));
	const league = { id: '26696' };
	const scores = await fetchMflWeekPlayerScores(league, '1', 'cookie');

	assert.equal(scores.get('9001'), 24.5);
	assert.equal(scores.get('9010'), 0, 'a genuine 0.0 survives as a real 0, not dropped as falsy');
	assert.equal(scores.has('9099'), false, 'an empty score string is not a real value');
	assert.equal(scores.has('9100'), false, 'a missing score key is not a real value');

	// A single-entry response: playerScore is a bare object, same
	// object-or-array-or-absent convention.
	stubFetch(() => okJson({ playerScores: { playerScore: { id: '9001', score: '5.0', week: '1' } } }));
	const one = await fetchMflWeekPlayerScores(league, '1', 'cookie');
	assert.equal(one.get('9001'), 5);
}

// --- mflBenchFromRoster, exercised through fetchScoring ---
const liveScoringResponse = {
	liveScoring: {
		week: '1',
		matchup: [
			{
				franchise: [
					{
						id: '0001', score: '12.4', isHome: '0', gameSecondsRemaining: '32400',
						players: {
							player: [
								{ id: '9001', score: '6.2', status: 'starter', gameSecondsRemaining: '1800' },
								{ id: '9002', score: '0.0', status: 'starter', gameSecondsRemaining: '3600' },
							],
						},
					},
					{ id: '0008', score: '9.1', isHome: '1', players: {}, gameSecondsRemaining: '28800' },
				],
			},
		],
	},
};

{
	stubFetch(() => okJson(liveScoringResponse));
	const league = { id: '26696', franchiseId: '0001' };
	const names = { nameById: new Map([['0001', 'My Team'], ['0008', 'Team D']]), ownerById: new Map() };

	// Franchise 0001's roster (TYPE=rosters, pre-fetched by the caller —
	// see fetchScoring's own comment on why this is a parameter, not fetched
	// inside) carries the two starters ALSO in liveScoring plus two more —
	// 9010 (a real bench player with a live score) and 9099 (rostered but
	// weekScores has nothing for yet, e.g. hasn't played).
	const mflRosterIds = new Map([
		['0001', ['9001', '9002', '9010', '9099']],
		['0008', ['9020']],
	]);
	const mflWeekScores = new Map([
		['9001', 6.2], ['9002', 0], ['9010', 14.3],
		// 9099 deliberately absent — no score yet.
	]);
	const playerMap = new Map([
		['9010', { name: 'Bench Guy', position: 'WR', team: 'MIA' }],
		['9099', { name: 'No Score Yet', position: 'RB', team: 'DAL' }],
	]);

	const result = await fetchScoring(league, 'cookie', names, undefined, playerMap, undefined, undefined, mflRosterIds, mflWeekScores);
	const me = result.teams.find((t) => t.franchiseId === '0001');

	assert.deepEqual(
		me.bench,
		[
			{ id: '9010', secondsRemaining: 0, name: 'Bench Guy', position: 'WR', team: 'MIA', points: 14.3, stats: [] },
			{ id: '9099', secondsRemaining: 0, name: 'No Score Yet', position: 'RB', team: 'DAL', points: null, stats: [] },
		],
		'9001/9002 are excluded (already starters); 9010 carries its live score; 9099 has none yet and reads null, not 0'
	);

	// Franchise 0008 has a roster entry (9020) that never appears in
	// weekScores at all — still renders, with a null (not zero) score.
	const teamD = result.teams.find((t) => t.franchiseId === '0008');
	assert.deepEqual(
		teamD.bench,
		[{ id: '9020', secondsRemaining: 0, name: null, position: null, team: null, points: null, stats: [] }],
		'a roster id with no playerMap entry and no week score still renders, unresolved rather than dropped'
	);
}

// --- Graceful absence: either input missing degrades bench to [], never throws ---
{
	stubFetch(() => okJson(liveScoringResponse));
	const league = { id: '26696', franchiseId: '0001' };
	const names = { nameById: new Map([['0001', 'My Team'], ['0008', 'Team D']]), ownerById: new Map() };
	const mflRosterIds = new Map([['0001', ['9001', '9002', '9010']]]);

	// mflRosterIds without mflWeekScores: the bench roster is known, but
	// every one of its live points is unknowable this poll.
	const withoutScores = await fetchScoring(league, 'cookie', names, undefined, undefined, undefined, undefined, mflRosterIds);
	const me1 = withoutScores.teams.find((t) => t.franchiseId === '0001');
	assert.deepEqual(
		me1.bench,
		[{ id: '9010', secondsRemaining: 0, name: null, position: null, team: null, points: null, stats: [] }]
	);

	// mflWeekScores without mflRosterIds: no roster to diff starters
	// against at all, so bench is simply empty rather than throwing.
	const withoutRoster = await fetchScoring(
		league, 'cookie', names, undefined, undefined, undefined, undefined, undefined, new Map([['9010', 14.3]])
	);
	const me2 = withoutRoster.teams.find((t) => t.franchiseId === '0001');
	assert.deepEqual(me2.bench, []);
}

console.log('test-mfl-bench.mjs OK');
