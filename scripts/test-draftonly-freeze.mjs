// Unit test for the finished-draft-only roster freeze —
// draftonlyRosterIsSettled in scripts/fetch-rosters.mjs.
//
// A `draftonly` league drafts once and is then done assembling its roster, so
// once the draft is confirmed finished the sync stops re-reading it and carries
// the last one forward. That is the largest single saving in the run: eight of
// the fifteen MFL leagues, three requests each every four hours (the franchise
// roster plus this season's and last season's player scores), for a list that
// does not change again — across fourteen consecutive snapshots every
// draft-only roster was byte-identical for as long as its draft was finished.
//
// Standings and live scoring are deliberately still fetched every sync — they
// move every week of the season and are the whole point of these leagues. Only
// the roster block is frozen. That split is a decision, not an accident, and
// the integration assertion at the bottom of this file is what holds it.
//
// Every negative case below is a way the frozen answer would be *wrong*, and
// each fails silently if it regresses: a league stuck showing last season's
// roster, or an empty one, looks exactly like a league with nothing new.
//
// The mid-draft cases carry the most weight, and the reason is a real league.
// Worlds Collide grew 16 -> 19 players over two days and read as a league
// taking free agents after its draft; `draftInProgress` was `true` for every
// one of those snapshots and only flipped to `false` once the roster settled.
// Slow drafts run for days here, so roster growth alone proves nothing — and a
// gate that trusted anything weaker than a confirmed-finished draft would have
// frozen that league mid-draft, at 16 players, for the rest of the season.

import assert from 'node:assert/strict';
import { draftonlyRosterIsSettled, draftIsSettled } from './fetch-rosters.mjs';

const league = (over = {}) => ({ id: '56191', type: 'draftonly', season: '2026', ...over });
const prev = (over = {}) => ({
	id: '56191',
	season: '2026',
	draftInProgress: false,
	error: null,
	players: [{ id: '13176', name: 'Player, Some' }],
	...over,
});

// --- The steady state: finished draft, good previous roster -------------------
{
	assert.equal(draftonlyRosterIsSettled(league(), prev()), true, 'a finished draft-only roster is frozen');
}

// --- Only draft-only leagues ---------------------------------------------------
// A dynasty or salary-cap roster changes all season; redraft has waivers. The
// type gate is the difference between a saving and silently stale rosters.
for (const type of ['dynasty', 'salarycap', 'redraft', undefined]) {
	assert.equal(
		draftonlyRosterIsSettled(league({ type }), prev()),
		false,
		`${type} leagues are never frozen`
	);
}

// --- An unfinished or unknown draft is still filling the roster ---------------
{
	assert.equal(draftonlyRosterIsSettled(league(), prev({ draftInProgress: true })), false, 'mid-draft is not frozen');
	assert.equal(
		draftonlyRosterIsSettled(league(), prev({ draftInProgress: undefined })),
		false,
		'never having checked the draft is not the same as it being finished'
	);
	assert.equal(
		draftonlyRosterIsSettled(league(), prev({ draftInProgress: null })),
		false,
		'a failed draft check is not a finished draft'
	);
}

// --- A real slow draft, snapshot by snapshot ----------------------------------
// Worlds Collide (56191) as the sync actually recorded it over two days. The
// roster grows on four separate syncs while the draft is live, then settles.
// Nothing may freeze until draftInProgress flips, and everything after must —
// a gate keying off "the roster stopped growing" would have frozen at 17
// players on 09-05T00:00 and never recovered.
{
	const observed = [
		['2026-09-04T14:49', 16, true],
		['2026-09-04T19:00', 17, true],
		['2026-09-04T22:23', 17, true],
		['2026-09-05T00:00', 17, true],
		['2026-09-05T00:32', 17, true],
		['2026-09-05T02:20', 17, true],
		['2026-09-05T04:26', 18, true],
		['2026-09-05T06:57', 18, true],
		['2026-09-05T11:53', 18, true],
		['2026-09-05T15:14', 18, true],
		['2026-09-05T19:44', 19, true],
		['2026-09-05T22:04', 19, false],
		['2026-09-06T04:38', 19, false],
		['2026-09-06T07:09', 19, false],
	];
	let froze = 0;
	for (const [at, count, drafting] of observed) {
		const snapshot = prev({
			draftInProgress: drafting,
			players: Array.from({ length: count }, (_, i) => ({ id: String(i), name: `P${i}` })),
		});
		const result = draftonlyRosterIsSettled(league(), snapshot);
		assert.equal(result, !drafting, `${at}: frozen should be ${!drafting} while drafting=${drafting}`);
		if (result) froze += 1;
	}
	assert.equal(froze, 3, 'only the three settled snapshots freeze');
	// While drafting, `available` is null (a draft board is not a wire), and the
	// freeze must not depend on it either way — it is the draft flag that decides.
	assert.equal(
		draftonlyRosterIsSettled(league(), prev({ draftInProgress: true, available: null })),
		false
	);
}

// --- Rollover unfreezes the league by itself ----------------------------------
// The load-bearing case. Without it a draft-only league would keep serving its
// previous season's roster forever, and nothing on the page would say so — the
// data would simply be a year old. draftIsSettled keys to the season, and this
// inherits that, which is why no separate season handling exists here.
{
	assert.equal(
		draftonlyRosterIsSettled(league({ season: '2027' }), prev({ season: '2026' })),
		false,
		'a league that has rolled over must be read fresh'
	);
	assert.equal(
		draftIsSettled(prev({ season: '2026' }), '2027'),
		false,
		'...because the draft-settled check itself is season-keyed'
	);
	// And once the new season's draft finishes, it freezes again on its own.
	assert.equal(
		draftonlyRosterIsSettled(league({ season: '2027' }), prev({ season: '2027' })),
		true,
		'the new season re-freezes once its own draft is done'
	);
}

// --- Nothing worth keeping ----------------------------------------------------
{
	assert.equal(draftonlyRosterIsSettled(league(), undefined), false, 'a first sync has nothing to freeze');
	assert.equal(draftonlyRosterIsSettled(league(), prev({ players: [] })), false, 'an empty roster is not worth keeping');
	assert.equal(draftonlyRosterIsSettled(league(), prev({ players: undefined })), false, 'nor a missing one');
	assert.equal(
		draftonlyRosterIsSettled(league(), prev({ error: 'MFL request failed (429)' })),
		false,
		'an errored entry is stale fallback, not a good read to freeze'
	);
}

// --- REFRESH_AVAILABILITY forces a real read ----------------------------------
// Which makes the sync workflow's existing button the manual way to pull a
// frozen league forward, with no new switch to learn.
{
	assert.equal(draftonlyRosterIsSettled(league(), prev(), true), false, 'force overrides the freeze');
}

// --- The freeze covers the roster block and nothing else ----------------------
// Read the source rather than trusting the comment: standings and scoring must
// still be fetched for every league each sync, so their call sites must not be
// gated on the freeze. If someone later "optimises" by skipping those too, this
// is what says no — the leagues would quietly stop scoring mid-season.
{
	const src = await (await import('node:fs/promises')).readFile(
		new URL('./fetch-rosters.mjs', import.meta.url), 'utf8'
	);
	const body = src.slice(src.indexOf('async function main()'));
	for (const [call, label] of [['fetchStandings(league, cookie', 'standings'], ['fetchScoring(league, cookie', 'scoring']]) {
		const at = body.indexOf(call);
		assert.ok(at > 0, `${label} is still fetched`);
		// Scoped to this pass's own loop — from its `for` header to the call —
		// rather than a fixed window, which would also catch the roster pass's
		// summary log sitting just above and fail for the wrong reason.
		const loopAt = body.lastIndexOf('for (const league of LEAGUES)', at);
		assert.ok(loopAt > 0, `${label} runs inside a per-league loop`);
		const guard = body.slice(loopAt, at);
		assert.ok(
			!/frozen|draftonlyRosterIsSettled/.test(guard),
			`${label} must not be gated on the draft-only freeze`
		);
	}
	// And the freeze must actually be wired into the roster pass.
	assert.ok(
		/draftonlyRosterIsSettled\(league, prevEntry/.test(body),
		'the roster pass consults the freeze'
	);
}

console.log('test-draftonly-freeze: all assertions passed');
