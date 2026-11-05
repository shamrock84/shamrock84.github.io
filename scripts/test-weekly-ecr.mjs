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
//   * one league's failure doesn't stop the others;
//   * the overall list has no QB, K or DST (the first live sync ranked 0 of
//     67 QBs), so those come from their own per-position lists into a
//     DIFFERENT field, `weeklyPosEcr`, because the scale differs. Requests:
//     QB per scoring, K and DST once, only for positions a league rosters; a
//     list for another week than the overall one, or one that fails, is
//     dropped without touching the rest.

import assert from 'node:assert/strict';
import { attachWeeklyRankings } from './lib/fantasypros.mjs';

const GAP = { gapMs: 0 }; // no pacing in tests

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
		const summary = await attachWeeklyRankings(leagues, configs, { apiKey: 'k', season: '2026', now: IN_SEASON, ...GAP });
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
		const summary = await attachWeeklyRankings(leagues, configs, { apiKey: 'k', season: '2026', now: IN_SEASON, ...GAP });
		assert.equal(leagues[0].players[0].weeklyEcr, undefined);
		assert.equal(leagues[0].weeklyEcrWeek, undefined, 'an empty list claims no week');
		assert.match(summary[0], /no weekly list yet/);
	}

	// A list that doesn't say its week can't be matched to a lineup.
	{
		mockFetch(() => ({ body: { players: [fp('Abe Runner', 12)] } }));
		const leagues = [{ id: 'A', name: 'A', players: roster('Abe Runner') }];
		await attachWeeklyRankings(leagues, configs, { apiKey: 'k', season: '2026', now: IN_SEASON, ...GAP });
		assert.equal(leagues[0].players[0].weeklyEcr, undefined);
		assert.equal(leagues[0].weeklyEcrWeek, undefined);
	}

	// Out of season: nothing is requested.
	{
		const calls = mockFetch(() => ({ body: { week: 1, players: [fp('Abe Runner', 1)] } }));
		const leagues = [{ id: 'A', name: 'A', players: roster('Abe Runner') }];
		assert.deepEqual(await attachWeeklyRankings(leagues, configs, { apiKey: 'k', season: '2026', now: OFFSEASON, ...GAP }), []);
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
		const summary = await attachWeeklyRankings(leagues, configs, { apiKey: 'k', season: '2026', now: IN_SEASON, ...GAP });
		assert.ok(summary.some((l) => /weekly ALL\/HALF failed/.test(l)));
		assert.ok(summary.some((l) => /B: no weekly list yet/.test(l)), "the league whose list failed is reported as having none");
		assert.equal(leagues[0].players[0].weeklyEcr, undefined);
		assert.equal(leagues[1].players[0].weeklyEcr, 12, 'the healthy league still gets its ranks');
	}

	// QB, K and DST come from their own lists, into weeklyPosEcr.
	{
		const posOf = (url) => /position=([A-Z]+)/.exec(url)[1];
		const calls = mockFetch((url) => {
			const pos = posOf(url);
			if (pos === 'ALL') return { body: { week: 9, players: [fp('Abe Runner', 12)] } };
			if (pos === 'QB') return { body: { week: 9, players: [fp('Joe Burrow', 3, 'QB'), fp('Backup Qb', 20, 'QB')] } };
			if (pos === 'K') return { body: { week: 9, players: [fp('Chase McLaughlin', 4, 'K')] } };
			return { body: { week: 9, players: [fp('Detroit Lions', 2, 'DST', 'DET')] } };
		});
		const mk = (id, name) => ({ id, name, players: [
			{ id: '1', name: 'Abe Runner', position: 'RB', team: 'DAL' },
			{ id: '2', name: 'Joe Burrow', position: 'QB', team: 'DAL' },
			{ id: '3', name: 'Backup Qb', position: 'QB', team: 'DAL' },
			{ id: '4', name: 'Chase McLaughlin', position: 'PK', team: 'DAL' },
			{ id: '5', name: 'Detroit Lions', position: 'Def', team: 'DET' },
		] });
		const leagues = [mk('A', 'A'), mk('C', 'C')]; // both PPR
		await attachWeeklyRankings(leagues, configs, { apiKey: 'k', season: '2026', now: IN_SEASON, ...GAP });
		assert.deepEqual(calls.map(posOf).sort(), ['ALL', 'DST', 'K', 'QB'], 'one request per list, shared by both PPR leagues');
		const p = leagues[0].players;
		assert.equal(p[0].weeklyEcr, 12, 'RB: overall rank');
		assert.equal(p[0].weeklyPosEcr, undefined);
		assert.deepEqual(p.slice(1).map((x) => x.weeklyPosEcr), [3, 20, 4, 2], 'QB, K and Def: rank within their own list');
		assert.deepEqual(p.slice(1).map((x) => x.weeklyEcr), [undefined, undefined, undefined, undefined], 'never written to the overall field');
		assert.equal(leagues[1].players[1].weeklyPosEcr, 3);

		// A QB list for another week is dropped; the overall ranks stay.
		mockFetch((url) => (posOf(url) === 'QB' ? { body: { week: 10, players: [fp('Joe Burrow', 3, 'QB')] } } : { body: { week: 9, players: [fp('Abe Runner', 12)] } }));
		const stale = [mk('A', 'A')];
		await attachWeeklyRankings(stale, configs, { apiKey: 'k', season: '2026', now: IN_SEASON, ...GAP });
		assert.equal(stale[0].players[0].weeklyEcr, 12);
		assert.equal(stale[0].players[1].weeklyPosEcr, undefined, 'a position list for a different week is ignored');

		// A failing position list leaves the rest alone, and is not retried per league.
		const failCalls = mockFetch((url) => (posOf(url) === 'QB' ? { status: 400, body: { message: 'bad' } } : { body: { week: 9, players: [fp('Abe Runner', 12)] } }));
		const hurt = [mk('A', 'A'), mk('C', 'C')];
		const summary = await attachWeeklyRankings(hurt, configs, { apiKey: 'k', season: '2026', now: IN_SEASON, ...GAP });
		assert.equal(hurt[1].players[0].weeklyEcr, 12);
		assert.equal(hurt[0].players[1].weeklyPosEcr, undefined);
		assert.equal(failCalls.filter((u) => posOf(u) === 'QB').length, 1, 'the failed list is remembered, not re-requested for each league');
		assert.ok(summary.some((l) => /weekly QB\/PPR failed/.test(l)));
	}
} finally {
	globalThis.fetch = realFetch;
}

console.log('weekly ECR tests passed');
