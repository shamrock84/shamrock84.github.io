// Pins attachWeeklyRankings (scripts/lib/fantasypros.mjs): this week's ECR
// attached beside the ROS `ecr` for the Game-Time Watchlist's replacement
// suggestions. Shapes come from probe-fantasypros-weekly-ecr.mjs RUN 1:
// type=WEEKLY&position=ALL is an overall list, an omitted `week` is the live
// one, and the next week answers 200 with ZERO players until published.
//
// Pinned:
//   * a player's rank lands in `weeklyEcr` and the league's week in
//     `weeklyEcrWeek`; the ROS `ecr` is left exactly as it was;
//   * one request per distinct scoring, shared across leagues, always
//     type=WEEKLY&position=ALL with no `week` param;
//   * an empty list, or one that doesn't say its week, attaches nothing
//     (the picker then uses ROS, not "everyone unranked");
//   * out of season nothing is requested;
//   * one league's failure doesn't stop the others.

import assert from 'node:assert/strict';
import { attachWeeklyRankings } from './lib/fantasypros.mjs';

const fp = (name, rank, pos = 'RB', team = 'DAL') => ({
	player_name: name, rank_ecr: rank, pos_rank: `${pos}${rank}`, player_position_id: pos, player_team_id: team,
});

const realFetch = globalThis.fetch;
function mockFetch(handler) {
	const calls = [];
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		const { status = 200, body } = handler(String(url));
		return { ok: status < 400, status, text: async () => JSON.stringify(body) };
	};
	return calls;
}

const IN_SEASON = new Date('2026-11-05T12:00:00Z');
const OFFSEASON = new Date('2026-07-15T12:00:00Z');
const roster = (...names) => names.map((name, i) => ({ id: String(i), name, position: 'RB', team: 'DAL' }));
const configs = [{ id: 'A', scoring: 'PPR' }, { id: 'B', scoring: 'HALF' }, { id: 'C', scoring: 'PPR' }];

try {
	// Two PPR leagues and one HALF: two requests, not three.
	{
		const calls = mockFetch((url) => ({
			body: { week: 9, last_updated: '11/05', total_experts: 17, players: url.includes('scoring=HALF') ? [fp('Yan Runner', 3)] : [fp('Abe Runner', 12), fp('Yan Runner', 40)] },
		}));
		const leagues = [
			{ id: 'A', name: 'A', players: roster('Abe Runner', 'Yan Runner', 'Nobody Known'), ecr: undefined },
			{ id: 'B', name: 'B', players: roster('Abe Runner', 'Yan Runner') },
			{ id: 'C', name: 'C', players: roster('Yan Runner') },
		];
		leagues[0].players[0].ecr = { rank: 99 };
		const summary = await attachWeeklyRankings(leagues, configs, { apiKey: 'k', season: '2026', now: IN_SEASON });
		assert.equal(calls.length, 2, 'one request per distinct scoring, shared across leagues');
		assert.ok(calls.every((u) => /type=WEEKLY/.test(u) && /position=ALL/.test(u) && !/week=/.test(u)), 'WEEKLY, overall, no week param (the live week)');
		assert.deepEqual(leagues[0].players.map((p) => p.weeklyEcr), [12, 40, undefined], 'PPR league: matched players get the rank, an unranked one gets no field');
		assert.deepEqual(leagues[1].players.map((p) => p.weeklyEcr), [undefined, 3], 'HALF league reads the HALF list');
		assert.equal(leagues[2].players[0].weeklyEcr, 40);
		assert.deepEqual(leagues.map((l) => l.weeklyEcrWeek), [9, 9, 9], 'the list week rides on the league');
		assert.deepEqual({ ...leagues[0].players[0].ecr }, { rank: 99 }, 'the ROS ecr is untouched');
		assert.equal(summary.length, 3);
	}

	// Next week's list: 200 with zero players (probe RUN 1). Attach nothing.
	{
		mockFetch(() => ({ body: { week: 10, last_updated: '1/01', total_experts: 0, players: [] } }));
		const leagues = [{ id: 'A', name: 'A', players: roster('Abe Runner') }];
		const summary = await attachWeeklyRankings(leagues, configs, { apiKey: 'k', season: '2026', now: IN_SEASON });
		assert.equal(leagues[0].players[0].weeklyEcr, undefined);
		assert.equal(leagues[0].weeklyEcrWeek, undefined, 'an empty list claims no week');
		assert.match(summary[0], /no weekly list yet/);
	}

	// A list that doesn't say its week can't be matched to a lineup.
	{
		mockFetch(() => ({ body: { players: [fp('Abe Runner', 12)] } }));
		const leagues = [{ id: 'A', name: 'A', players: roster('Abe Runner') }];
		await attachWeeklyRankings(leagues, configs, { apiKey: 'k', season: '2026', now: IN_SEASON });
		assert.equal(leagues[0].players[0].weeklyEcr, undefined);
		assert.equal(leagues[0].weeklyEcrWeek, undefined);
	}

	// Out of season: nothing is requested.
	{
		const calls = mockFetch(() => ({ body: { week: 1, players: [fp('Abe Runner', 1)] } }));
		const leagues = [{ id: 'A', name: 'A', players: roster('Abe Runner') }];
		assert.deepEqual(await attachWeeklyRankings(leagues, configs, { apiKey: 'k', season: '2026', now: OFFSEASON }), []);
		assert.equal(calls.length, 0);
		assert.equal(leagues[0].players[0].weeklyEcr, undefined);
	}

	// A failing scoring doesn't stop the other leagues (400 is not retried).
	{
		mockFetch((url) => (url.includes('scoring=HALF')
			? { status: 400, body: { message: 'bad' } }
			: { body: { week: 9, players: [fp('Abe Runner', 12)] } }));
		const leagues = [
			{ id: 'B', name: 'B', players: roster('Abe Runner') },
			{ id: 'A', name: 'A', players: roster('Abe Runner') },
		];
		const summary = await attachWeeklyRankings(leagues, configs, { apiKey: 'k', season: '2026', now: IN_SEASON });
		assert.match(summary[0], /weekly rankings failed/);
		assert.equal(leagues[0].players[0].weeklyEcr, undefined);
		assert.equal(leagues[1].players[0].weeklyEcr, 12, 'the healthy league still gets its ranks');
	}
} finally {
	globalThis.fetch = realFetch;
}

console.log('weekly ECR tests passed');
