// Unit test for the sync half of the Injury Exposure card's detail line: what
// normalizeInjuryStatus makes of the designations MFL actually publishes, and
// what injuryEntryFromRow keeps off a row of its injury report.
//
// Both are pure, and both are the kind of thing that fails silently. A
// mis-normalised designation renders as a plausible badge and sorts wrong; a
// detail field kept when it shouldn't be spends a line of the card saying
// nothing. Neither shows up as an error anywhere.
//
// The vocabulary pinned below is not invented — it is what
// probe-injury-detail.yml read off the real report in August 2026: 325 rows,
// 220 Questionable, 43 Out, 34 IR, 19 RETIRED, 4 Suspended, 2 Holdout, 2
// IR-PUP and 1 IR-NFI.

import assert from 'node:assert/strict';
import { normalizeInjuryStatus, injuryEntryFromRow } from './lib/providers.mjs';
import { attachInjuryDetail } from './fetch-rosters.mjs';

// --- The designations MFL actually publishes ---------------------------------
{
	assert.equal(normalizeInjuryStatus('Questionable'), 'Q');
	assert.equal(normalizeInjuryStatus('Out'), 'O');
	assert.equal(normalizeInjuryStatus('IR'), 'IR');
	assert.equal(normalizeInjuryStatus('Suspended'), 'SUSP');
	assert.equal(normalizeInjuryStatus('Holdout'), 'HOL');
	assert.equal(normalizeInjuryStatus('RETIRED'), 'RET');
}

// --- The two reserve lists, which used to be mangled --------------------------
// "IR-PUP" became "IR PUP" (the hyphen is normalised to a space), missed the
// map, and fell through to the length slice as "IR " — trailing space and all.
// That string renders as a convincing "IR" and ranks -1 in INJURY_SEVERITY, so
// it sorted below a Questionable and lost every disagreement to one. PUP and
// NFI were already in the severity list waiting for it.
{
	assert.equal(normalizeInjuryStatus('IR-PUP'), 'PUP');
	assert.equal(normalizeInjuryStatus('IR-NFI'), 'NFI');
	// The bug in the form it would come back in: anything with a trailing space
	// is a slice that escaped, whatever it sliced.
	for (const raw of ['IR-PUP', 'IR-NFI', 'Questionable', 'RETIRED', 'Holdout']) {
		const out = normalizeInjuryStatus(raw);
		assert.equal(out, out.trim(), `${raw} normalised to a padded string`);
	}
}

// --- Healthy is not a designation --------------------------------------------
{
	assert.equal(normalizeInjuryStatus(''), null);
	assert.equal(normalizeInjuryStatus(null), null);
	assert.equal(normalizeInjuryStatus('ACTIVE'), null);
	assert.equal(normalizeInjuryStatus('Healthy'), null);
}

// --- A row of the injury report ----------------------------------------------
{
	const entry = injuryEntryFromRow({ status: 'Questionable', id: '10292', details: 'Hamstring', exp_return: 'Aug 15, 2026' });
	assert.equal(entry.status, 'Q');
	assert.deepEqual(entry.detail, { part: 'Hamstring', until: 'Aug 15, 2026' });
	// Kept as the string MFL sent. Parsing it here would hand the page an ISO
	// timestamp claiming a precision a date like this doesn't have, and the page
	// is the side that decides whether to print it at all.
	assert.equal(typeof entry.detail.until, 'string');
}

// --- "Undisclosed" is the feed saying it doesn't know --------------------------
// It is a large share of the report, and printing the word under a player's
// name spends a line to say nothing. It has to become *absent*, not the string,
// so the page's "no detail, no line" rule catches it.
{
	const entry = injuryEntryFromRow({ status: 'Out', id: '1', details: 'Undisclosed', exp_return: 'Sep 13, 2026' });
	assert.equal(entry.detail.part, null);
	assert.equal(entry.detail.until, 'Sep 13, 2026', 'but the return date still stands on its own');

	const lower = injuryEntryFromRow({ status: 'Out', id: '1', details: 'undisclosed', exp_return: '' });
	assert.equal(lower.detail, null, 'nothing left to say means no detail at all');

	// "Personal" is not "Undisclosed" — it says something, and RETIRED rows use
	// it. Only the one word is dropped.
	assert.equal(injuryEntryFromRow({ status: 'RETIRED', id: '2', details: 'Personal' }).detail.part, 'Personal');
}

// --- No designation, no entry --------------------------------------------------
// The detail annotates a designation rather than standing in for one. A row
// that normalises to nothing must not put a player on the card.
{
	assert.equal(injuryEntryFromRow({ status: 'ACTIVE', id: '3', details: 'Hamstring' }), null);
	assert.equal(injuryEntryFromRow({ id: '4', details: 'Knee' }), null);
	assert.equal(injuryEntryFromRow(null), null);
}

// --- A report with neither field still yields a usable status -------------------
// Both fields were filled on every row in August, which is exactly why the
// absent case needs pinning: nothing in a live run would ever exercise it.
{
	const entry = injuryEntryFromRow({ status: 'Doubtful', id: '5' });
	assert.equal(entry.status, 'D');
	assert.equal(entry.detail, null);
}

// --- Reaching the rosters MFL player ids can't ---------------------------------
// An ESPN or Sleeper roster keys its players by that site's own ids, so the one
// global MFL injury report can only reach them by name. This is what stops the
// detail line being present for fifteen leagues and blank for three — the exact
// "blank reads as no news" failure the whole design is arranged to avoid.
const HAMSTRING = { part: 'Hamstring', until: 'Aug 15, 2026' };
const KNEE = { part: 'Knee', until: null };

function injuryMap(entries) {
	return new Map(entries.map(([id, detail]) => [id, { status: 'Q', detail }]));
}
function playerMap(entries) {
	return new Map(entries.map(([id, name]) => [id, { name }]));
}

{
	const leagues = [{
		players: [
			{ name: 'Josh Jacobs', injuryStatus: 'Q', injuryDetail: null },
			{ name: 'Nobody Hurt', injuryStatus: null, injuryDetail: null },
		],
	}];
	const filled = attachInjuryDetail(leagues, injuryMap([['1', HAMSTRING]]), playerMap([['1', 'Josh Jacobs']]));
	assert.equal(filled, 1);
	assert.deepEqual(leagues[0].players[0].injuryDetail, HAMSTRING);
	// The detail annotates a designation, it does not create one. A stale MFL
	// row about somebody this league's provider calls healthy must not put him
	// on the card — the card reads injuryStatus and the IR slot, nothing else.
	assert.equal(leagues[0].players[1].injuryDetail, null, 'a healthy player is left alone');
}

// --- The by-id answer always wins ---------------------------------------------
// A name is the weaker key: two players who share one collide here the same way
// they would in a FantasyPros slug. Where fetchLeagueRoster has already stamped
// the exact by-id answer, the name is never consulted.
{
	const leagues = [{ players: [{ name: 'Josh Allen', injuryStatus: 'Q', injuryDetail: KNEE }] }];
	const filled = attachInjuryDetail(leagues, injuryMap([['9', HAMSTRING]]), playerMap([['9', 'Josh Allen']]));
	assert.equal(filled, 0);
	assert.deepEqual(leagues[0].players[0].injuryDetail, KNEE, 'the id answer stands');
}

// --- The join is the same normalisation the rest of the page uses ---------------
// normalizePlayerName drops the suffixes providers disagree about, which is the
// only reason a Sleeper "Michael Penix Jr." finds an MFL "Michael Penix".
{
	const leagues = [{ players: [{ name: 'Michael Penix Jr.', injuryStatus: 'Q', injuryDetail: null }] }];
	attachInjuryDetail(leagues, injuryMap([['7', HAMSTRING]]), playerMap([['7', 'Michael Penix']]));
	assert.deepEqual(leagues[0].players[0].injuryDetail, HAMSTRING);
}

// --- Nothing to join with ------------------------------------------------------
// The sync degrades rather than failing: a run where the injury report errored
// leaves every roster exactly as it was, with no detail rather than no rosters.
{
	const leagues = [{ players: [{ name: 'Josh Jacobs', injuryStatus: 'Q', injuryDetail: null }] }];
	assert.equal(attachInjuryDetail(leagues, new Map(), playerMap([['1', 'Josh Jacobs']])), 0);
	assert.equal(attachInjuryDetail(leagues, injuryMap([['1', HAMSTRING]]), new Map()), 0);
	assert.equal(attachInjuryDetail(leagues, null, null), 0);
	assert.equal(leagues[0].players[0].injuryDetail, null);

	// An injury row carrying no detail contributes nothing rather than an empty
	// object that would render as a blank line under the name.
	assert.equal(attachInjuryDetail(leagues, injuryMap([['1', null]]), playerMap([['1', 'Josh Jacobs']])), 0);
	assert.equal(leagues[0].players[0].injuryDetail, null);

	// A league that failed entirely has no players array at all.
	assert.equal(attachInjuryDetail([{ error: 'boom' }], injuryMap([['1', HAMSTRING]]), playerMap([['1', 'X']])), 0);
}

console.log('injury detail: all assertions passed');
