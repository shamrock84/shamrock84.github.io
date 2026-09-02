// Unit test for parseFutureDraftPicks in scripts/lib/providers.mjs — the
// Rosters card's new Draft Picks section (Dynasty/Salary Cap leagues only).
//
// The fixtures below are trimmed from what probe-future-draft-picks.yml
// actually printed against the real MFL API (2026-09, MNMx Dynasty L=26696
// and Iron Bank L=35217), not from documentation, because the shape is
// undocumented and unreachable from a sandbox. The load-bearing findings:
//
//   - TYPE=futureDraftPicks returns EVERY franchise's future picks in one
//     call, keyed by franchise id under futureDraftPicks.franchise[] — this
//     is never re-fetched per franchise, so parseFutureDraftPicks has to
//     pick our own id out of the full list.
//   - Each pick is just {year, round, originalPickFor} — no pick-number or
//     slot field exists anywhere, because draft order isn't set this many
//     months out.
//   - originalPickFor equals the *owning* franchise's own id for a natural
//     pick (Iron Bank's franchise 0001 owns a 2027 R1 with
//     originalPickFor "0001") and names a different franchise when the pick
//     was acquired via trade (that same franchise 0001 also owns a 2027 R1
//     and R2 with originalPickFor "0007" — acquired from WunWun No WinWin).

import assert from 'node:assert/strict';
import { parseFutureDraftPicks } from './lib/providers.mjs';

const nameById = new Map([
	['0001', 'The FOOKING Hand of the King'],
	['0007', 'WunWun No WinWin'],
]);

// --- Own picks plus one acquired via trade, verbatim shape from Iron Bank -----
{
	const data = {
		futureDraftPicks: {
			franchise: [
				{
					id: '0001',
					futureDraftPick: [
						{ originalPickFor: '0001', round: '1', year: '2027' },
						{ round: '2', year: '2027', originalPickFor: '0001' },
						{ year: '2028', round: '1', originalPickFor: '0001' },
						{ originalPickFor: '0007', year: '2027', round: '1' },
						{ round: '2', year: '2027', originalPickFor: '0007' },
					],
				},
				{
					id: '0002',
					futureDraftPick: [{ round: '1', year: '2027', originalPickFor: '0002' }],
				},
			],
		},
	};

	const picks = parseFutureDraftPicks(data, '0001', nameById);
	assert.equal(picks.length, 5);
	// Sorted by year then round, not by the order MFL happened to return them
	// in — the fixture above is deliberately out of order.
	assert.deepEqual(picks.map((p) => `${p.year}.${p.round}`), ['2027.1', '2027.1', '2027.2', '2027.2', '2028.1']);

	// A natural pick (originalPickFor === our own id) carries no "via" —
	// null, not our own team name reflected back at us.
	const own2028 = picks.find((p) => p.year === 2028);
	assert.equal(own2028.originalTeamName, null);

	// An acquired pick names who it came from.
	const traded = picks.filter((p) => p.originalTeamName != null);
	assert.equal(traded.length, 2);
	assert.ok(traded.every((p) => p.originalTeamName === 'WunWun No WinWin'));

	// Franchise 0002's own pick is also a 2027 round 1 — same year/round as
	// two legitimate entries above, so it wouldn't stand out in the mapped
	// list either. The length===5 assertion above is what actually proves
	// it didn't leak in (a leak would make it 6).
}

// --- A franchise id absent from the name map still gets a value -------------
// Falls back to the raw id rather than losing the fact that this WAS a trade —
// a league whose franchise roster changed since the name map was built (a
// dropped/replaced team) shouldn't make an acquired pick look like a natural
// one.
{
	const data = {
		futureDraftPicks: {
			franchise: [
				{ id: '0001', futureDraftPick: [{ year: '2027', round: '3', originalPickFor: '0099' }] },
			],
		},
	};
	const picks = parseFutureDraftPicks(data, '0001', new Map());
	assert.equal(picks.length, 1);
	assert.equal(picks[0].originalTeamName, '0099');
}

// --- MFL's single-element collapse -------------------------------------------
// XML-derived JSON gives a bare object rather than a one-element array for
// both the outer franchise list and the inner pick list — the same trap
// draftStatusFromResults already has to handle.
{
	const data = {
		futureDraftPicks: {
			franchise: { id: '0001', futureDraftPick: { year: '2027', round: '1', originalPickFor: '0001' } },
		},
	};
	const picks = parseFutureDraftPicks(data, '0001', nameById);
	assert.equal(picks.length, 1);
	assert.equal(picks[0].year, 2027);
	assert.equal(picks[0].round, 1);
	assert.equal(picks[0].originalTeamName, null);
}

// --- A franchise with no future picks at all, and a missing franchise --------
// Both real cases, not errors: a franchise can appear with an empty/absent
// futureDraftPick, and a franchise id can simply not be in the response.
{
	const noPicks = { futureDraftPicks: { franchise: [{ id: '0001' }] } };
	assert.deepEqual(parseFutureDraftPicks(noPicks, '0001', nameById), []);

	const notFound = {
		futureDraftPicks: { franchise: [{ id: '0002', futureDraftPick: [{ year: '2027', round: '1', originalPickFor: '0002' }] }] },
	};
	assert.deepEqual(parseFutureDraftPicks(notFound, '0001', nameById), []);
}

// --- Malformed/absent responses degrade to an empty list, never a throw -----
// Mirrors the null-vs-[] distinction the caller (fetchLeagueRoster) draws:
// this function only ever runs when there IS a response to parse — a failed
// fetch is handled by the caller passing null through untouched instead of
// calling this at all — so an empty-but-present response is what this needs
// to survive cleanly.
{
	assert.deepEqual(parseFutureDraftPicks({}, '0001', nameById), []);
	assert.deepEqual(parseFutureDraftPicks({ futureDraftPicks: {} }, '0001', nameById), []);
}

console.log('test-future-draft-picks: all assertions passed');
