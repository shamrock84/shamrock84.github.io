// Unit test for draft detection — draftStatusFromResults and
// sleeperDraftInProgress in scripts/lib/providers.mjs.
//
// A league mid-draft reports every unpicked player as a free agent. That is
// true at the instant it was read and useless: they aren't claimable off a
// wire, they're about to be drafted by somebody. So Top Available hides a
// league until its draft is done, and this is what decides "done".
//
// The fixtures below are copied from what probe-draft-status.yml actually
// printed against the real MFL API, not from the documentation, because the
// shape is undocumented and unreachable from a sandbox. The one that matters
// is August Judgment Day: MFL returns *every* pick in the draft, and an unmade
// one comes back with an empty `player` and an empty `timestamp`. Reading only
// the finished leagues would suggest unmade picks are simply absent — they
// aren't, and a detector written on that assumption would never fire.
//
// The three-state answer is the load-bearing part. `null` means "couldn't
// tell" and must never be treated as "not finished", or a league whose draft
// MFL doesn't carry would vanish from the card permanently on a guess.

import assert from 'node:assert/strict';
import { draftStatusFromResults, sleeperDraftInProgress } from './lib/providers.mjs';
import { draftIsSettled } from './fetch-rosters.mjs';

// MFL's XML-derived JSON: a pick is made when `player` is a non-empty id.
const madePick = (round, pick, player) => ({ round, pick, player, franchise: '0001', comments: '', timestamp: '1786110151' });
const unmadePick = (round, pick) => ({ round, pick, player: '', franchise: '0003', comments: '', timestamp: '' });

const results = (picks, extra = {}) => ({
	draftResults: {
		draftUnit: { unit: 'LEAGUE', draftType: '3RDROUND', ...extra, draftPick: picks },
	},
});

// --- A draft in progress: some picks made, the rest empty ---------------------
// August Judgment Day, verbatim proportions from the probe: 216 picks, 65 made.
{
	const picks = [
		...Array.from({ length: 65 }, (_, i) => madePick('01', String(i + 1), String(16000 + i))),
		...Array.from({ length: 151 }, (_, i) => unmadePick('06', String(i + 1))),
	];
	const status = draftStatusFromResults(results(picks));
	assert.equal(status.made, 65);
	assert.equal(status.unmade, 151);
	assert.equal(status.complete, false, 'one unmade pick is enough to call the draft unfinished');
}

// --- A finished draft: every pick carries a player ----------------------------
// May Rookies returned 216/0, MNMx Dynasty 41/0. Note the finished leagues are
// the ones that would mislead you into thinking unmade picks are never listed.
{
	const picks = Array.from({ length: 41 }, (_, i) => madePick('01', String(i + 1), String(17000 + i)));
	const status = draftStatusFromResults(results(picks));
	assert.equal(status.made, 41);
	assert.equal(status.unmade, 0);
	assert.equal(status.complete, true);
}

// --- A draft that hasn't started: scheduled, nothing picked -------------------
// Treated the same as mid-draft, deliberately. Every ranked player would read
// as a free agent, which is a draft board rather than a wire.
{
	const picks = Array.from({ length: 216 }, (_, i) => unmadePick('01', String(i + 1)));
	const status = draftStatusFromResults(results(picks));
	assert.equal(status.made, 0);
	assert.equal(status.complete, false);
}

// --- No draft at all is "couldn't tell", never "unfinished" -------------------
// Worlds Collide returned zero picks and an empty round1DraftOrder. A league
// with no draft data keeps its wire rather than disappearing on a guess.
{
	assert.equal(draftStatusFromResults(results([], { round1DraftOrder: '' })), null);
	assert.equal(draftStatusFromResults({ draftResults: {} }), null);
	assert.equal(draftStatusFromResults({}), null);
	assert.equal(draftStatusFromResults(null), null);
}

// --- Every draft unit has to be finished --------------------------------------
// A league can run more than one (a per-division draft). Reading only the first
// would call the league done while half of it is still picking.
{
	const done = { unit: 'DIVISION00', draftPick: [madePick('01', '1', '16162')] };
	const running = { unit: 'DIVISION01', draftPick: [madePick('01', '1', '16163'), unmadePick('01', '2')] };
	const status = draftStatusFromResults({ draftResults: { draftUnit: [done, running] } });
	assert.equal(status.made, 2);
	assert.equal(status.unmade, 1);
	assert.equal(status.complete, false);
	// Both finished is finished.
	assert.equal(draftStatusFromResults({ draftResults: { draftUnit: [done, done] } }).complete, true);
}

// --- MFL's single-element collapse --------------------------------------------
// XML-derived JSON gives a bare object rather than a one-element array, the
// same trap the roster parsing already has to handle.
{
	const one = draftStatusFromResults({ draftResults: { draftUnit: { unit: 'LEAGUE', draftPick: madePick('01', '1', '16162') } } });
	assert.equal(one.made, 1);
	assert.equal(one.complete, true);
	const oneUnmade = draftStatusFromResults({ draftResults: { draftUnit: { unit: 'LEAGUE', draftPick: unmadePick('01', '1') } } });
	assert.equal(oneUnmade.unmade, 1);
	assert.equal(oneUnmade.complete, false);
}

// --- Sleeper says so on the league object -------------------------------------
{
	assert.equal(sleeperDraftInProgress('pre_draft'), true);
	assert.equal(sleeperDraftInProgress('drafting'), true);
	assert.equal(sleeperDraftInProgress('in_season'), false);
	assert.equal(sleeperDraftInProgress('complete'), false);
	// An unrecognised status is a finished draft rather than a hidden league:
	// Sleeper's lifecycle can gain names, and the two that mean "not drafted
	// yet" are the ones worth naming. Missing entirely is "couldn't tell".
	assert.equal(sleeperDraftInProgress('post_season'), false);
	assert.equal(sleeperDraftInProgress(null), null);
	assert.equal(sleeperDraftInProgress(undefined), null);
	assert.equal(sleeperDraftInProgress(''), null);
}

// --- Not asking twice about a draft that has already finished ------------------
// The draft check runs on every sync so a league that starts drafting is
// noticed within four hours rather than twenty. What keeps that affordable is
// that a finished draft never unfinishes, so a league already seen complete
// this season is never asked again — in the steady state that's every league,
// and the check costs nothing at all.
{
	const settled = { draftInProgress: false, season: '2026' };
	assert.equal(draftIsSettled(settled, '2026'), true, 'asked and answered');

	// Anything short of a definite "finished" is asked again.
	assert.equal(draftIsSettled({ draftInProgress: true, season: '2026' }, '2026'), false, 'still drafting');
	assert.equal(draftIsSettled({ season: '2026' }, '2026'), false, 'never checked');
	assert.equal(draftIsSettled({ draftInProgress: null, season: '2026' }, '2026'), false, 'check failed');
	assert.equal(draftIsSettled(undefined, '2026'), false, 'no previous entry at all');

	// A rolled-over league has a new draft to run, and last season's answer
	// says nothing about it — the same reasoning that keys scoringDetected to
	// the season. Getting this wrong would hide a live draft for a whole year.
	assert.equal(draftIsSettled(settled, '2027'), false, 'new season, new draft');
	assert.equal(draftIsSettled({ draftInProgress: false, season: 2026 }, '2026'), true, 'numeric seasons compare equal');
	assert.equal(draftIsSettled({ draftInProgress: false }, '2026'), false, 'no recorded season is not a match');

	// The manual override re-asks everything.
	assert.equal(draftIsSettled(settled, '2026', true), false, 'refresh_availability forces the check');
}

console.log('test-draft-status: all assertions passed');
