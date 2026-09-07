// Unit test for fetchScoring in scripts/lib/providers.mjs.
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
// just-kicked-off week 1 actually looked like.

import assert from 'node:assert/strict';
import { fetchScoring } from './lib/providers.mjs';

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
					{ id: '0010', score: '0.0', isHome: '0', players: {} },
					{ id: '0009', score: '0.0', isHome: '1', players: {} },
				],
			},
			{
				franchise: [
					{ id: '0001', score: '12.4', isHome: '0', players: {} },
					{ id: '0008', score: '9.1', isHome: '1', players: {} },
				],
			},
			{
				franchise: [
					{ id: '0003', score: '0.0', isHome: '0', players: {} },
					{ id: '0004', score: '0.0', isHome: '1', players: {} },
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

console.log('test-live-scoring-matchup.mjs OK');
