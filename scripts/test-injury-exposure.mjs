// Unit test for the Analytics tab's Injury Exposure card — specifically
// computeInjuryExposure in myffl.html, which is where every decision that card
// makes actually lives.
//
// Six of those decisions are choices rather than consequences, and each one is
// invisible on a healthy week or a single league, which is why they're pinned
// here rather than left to be noticed on screen:
//
//   - the denominator is the *same* set of leagues the Player Exposure card
//     counts, so "3/9" means the same thing on both cards;
//   - a player flagged in one league counts in every league that rosters him,
//     because the provider feeds disagree routinely and it's the same body;
//   - singletons are kept, unlike the player card's count > 1 filter;
//   - the worst designation wins when the feeds disagree;
//   - rows are ordered by severity *before* exposure — the one place this card
//     deliberately differs from the player card beside it;
//   - a designation the vocabulary doesn't recognise ranks below every one it
//     does, so it can neither mask a real IR nor lead the card.
//
// As in test-plan-sync.mjs there is no DOM here: the page's script block is
// evaluated in a vm with the handful of browser globals it touches stubbed, so
// this runs the real source rather than a copy of it. The compute functions are
// top-level declarations, so they land on the context's global object.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(root, 'myffl.html'), 'utf8');
const scriptSource = html.match(/<script>([\s\S]*)<\/script>/)[1];

function fakeElement() {
	return {
		value: '', textContent: '', disabled: false, dataset: {}, style: {},
		classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
		addEventListener() {}, removeEventListener() {},
		appendChild: (child) => child, removeChild: (child) => child,
		insertBefore: (child) => child, remove() {}, focus() {}, setAttribute() {},
		querySelector: () => null, querySelectorAll: () => [], closest: () => null,
	};
}

const context = {
	console,
	localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
	setTimeout, clearTimeout, setInterval, clearInterval,
	document: {
		addEventListener() {},
		getElementById: () => fakeElement(),
		createElement: () => fakeElement(),
		querySelector: () => null,
		querySelectorAll: () => [],
		visibilityState: 'visible',
		body: fakeElement(),
	},
	window: { addEventListener() {} },
	fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
};
vm.createContext(context);
vm.runInContext(scriptSource, context);

const { computeInjuryExposure, computePlayerExposure, injuryDetailLine } = context;

// Shorthand for a rostered player. `injury` is the NFL designation as
// normalizeInjuryStatus leaves it; `slot` is the roster status; `detail` is
// what MFL's injury report says about it, as injuryEntryFromRow leaves it.
function player(name, { pos = 'RB', team = 'BUF', injury = null, ecr = null, slot = 'ROSTER', detail = null } = {}) {
	return {
		name,
		position: pos,
		team,
		status: slot,
		injuryStatus: injury,
		injuryDetail: detail,
		ecr: ecr == null ? null : { rank: ecr },
	};
}

function league(name, type, players) {
	return { name, leagueName: name, type, players };
}

const DYNASTY = ['dynasty', 'salarycap'];
const rowFor = (rows, name) => rows.find((r) => r.name === name);

// --- The denominator matches Player Exposure ----------------------------------
{
	const leagues = [
		league('A', 'dynasty', [player('Hurt Guy', { injury: 'O' })]),
		league('B', 'salarycap', [player('Hurt Guy', { injury: 'O' }), player('Fine Guy')]),
		// No roster data: counted by neither card, so it can't quietly deflate
		// the percentage on one of them.
		league('C', 'dynasty', []),
		// Different group entirely.
		league('D', 'draftonly', [player('Hurt Guy', { injury: 'O' })]),
	];

	const injury = computeInjuryExposure(leagues, DYNASTY);
	const exposure = computePlayerExposure(leagues, DYNASTY);
	assert.equal(injury.total, 2, 'only leagues in the group with rosters count');
	assert.equal(injury.total, exposure.total, 'both cards share a denominator');
	assert.equal(rowFor(injury.rows, 'Hurt Guy').count, 2);
	assert.equal(Math.round(rowFor(injury.rows, 'Hurt Guy').exposure), 100);
	assert.equal(rowFor(injury.rows, 'Fine Guy'), undefined, 'healthy players are left out');
}

// --- Flagged in one league, rostered in two ----------------------------------
// The providers publish on their own clocks, so this is the normal case rather
// than an edge one. Counting only the flagged league would report 50% exposure
// to an injury the other roster is just as exposed to.
{
	const leagues = [
		league('A', 'dynasty', [player('Half Flagged', { injury: 'Q' })]),
		league('B', 'dynasty', [player('Half Flagged')]),
	];
	const { total, rows } = computeInjuryExposure(leagues, DYNASTY);
	assert.equal(total, 2);
	assert.deepEqual([...rowFor(rows, 'Half Flagged').leagues], ['A', 'B']);
	assert.equal(Math.round(rowFor(rows, 'Half Flagged').exposure), 100);
}

// --- Singletons are kept ------------------------------------------------------
// The player card drops count === 1 because it answers "where am I
// concentrated". This card answers "who of mine is hurt", and dropping
// singletons would hide most of the answer.
{
	const leagues = [
		league('A', 'dynasty', [player('Lone Casualty', { injury: 'IR' })]),
		league('B', 'dynasty', [player('Somebody Else')]),
	];
	const { rows } = computeInjuryExposure(leagues, DYNASTY);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].count, 1);
	assert.equal(Math.round(rows[0].exposure), 50);
	assert.equal(computePlayerExposure(leagues, DYNASTY).rows.length, 0, 'the player card still drops singletons');
}

// --- The worst designation wins ----------------------------------------------
{
	const leagues = [
		league('A', 'dynasty', [player('Worsening', { injury: 'Q' }), player('Steady', { injury: 'D' })]),
		league('B', 'dynasty', [player('Worsening', { injury: 'O' }), player('Steady', { injury: 'D' })]),
	];
	const { rows } = computeInjuryExposure(leagues, DYNASTY);
	assert.equal(rowFor(rows, 'Worsening').status, 'O', 'Out beats Questionable whichever order they arrive in');
	assert.equal(rowFor(rows, 'Steady').status, 'D');
}
{
	// Same disagreement, reversed, so the reduce can't be passing by accident of
	// which league came first.
	const leagues = [
		league('A', 'dynasty', [player('Worsening', { injury: 'O' })]),
		league('B', 'dynasty', [player('Worsening', { injury: 'Q' })]),
	];
	assert.equal(computeInjuryExposure(leagues, DYNASTY).rows[0].status, 'O');
}
{
	// A code with no place in the severity list still shows rather than being
	// swallowed — normalizeInjuryStatus passes short codes through unmapped.
	const leagues = [
		league('A', 'dynasty', [player('Odd Code', { injury: 'ZZZ' })]),
		league('B', 'dynasty', [player('Odd Code', { injury: 'ZZZ' })]),
	];
	assert.equal(computeInjuryExposure(leagues, DYNASTY).rows[0].status, 'ZZZ');
}
{
	// ...but it must never win the reduce against a code we can read. An
	// unrecognised string ranks -1, so a real IR still decides what shows.
	const leagues = [
		league('A', 'dynasty', [player('Mixed', { injury: 'ZZZ' })]),
		league('B', 'dynasty', [player('Mixed', { injury: 'IR' })]),
	];
	assert.equal(computeInjuryExposure(leagues, DYNASTY).rows[0].status, 'IR');
}
{
	// HOL is a holdout, reaching the page from MFL as an unmapped passthrough
	// and ranked by hand: above Out, below a suspension. It is the one entry in
	// INJURY_SEVERITY that isn't an injury, so it is the one most likely to be
	// dropped by someone tidying the list.
	const leagues = [
		league('A', 'dynasty', [player('Holding Out', { injury: 'HOL' })]),
		league('B', 'dynasty', [player('Holding Out', { injury: 'O' })]),
	];
	assert.equal(computeInjuryExposure(leagues, DYNASTY).rows[0].status, 'HOL', 'a holdout outranks Out');

	const vsSuspension = [
		league('A', 'dynasty', [player('Also Banned', { injury: 'HOL' })]),
		league('B', 'dynasty', [player('Also Banned', { injury: 'SUSP' })]),
	];
	assert.equal(computeInjuryExposure(vsSuspension, DYNASTY).rows[0].status, 'SUSP', 'and a suspension outranks a holdout');
}

// --- An IR slot with no designation still counts ------------------------------
{
	const leagues = [
		league('A', 'dynasty', [player('Parked', { slot: 'INJURED_RESERVE' })]),
		league('B', 'dynasty', [player('Parked', { slot: 'ROSTER' })]),
	];
	const { rows } = computeInjuryExposure(leagues, DYNASTY);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].status, 'IR');
}
{
	// The feed's own designation wins over the slot when both are present.
	const leagues = [league('A', 'dynasty', [player('Parked', { slot: 'INJURED_RESERVE', injury: 'Q' })])];
	assert.equal(computeInjuryExposure([...leagues, league('B', 'dynasty', [player('X')])], DYNASTY).rows[0].status, 'Q');
}

// --- Ordering: severity first, then exposure, then the better player ----------
// This is where the card parts company with Player Exposure beside it, which
// leads on exposure alone. Severity first makes it a triage list: an IR outranks
// a Questionable however many leagues the Questionable spans.
{
	const leagues = [
		league('A', 'dynasty', [
			player('Wide Q', { injury: 'Q', ecr: 5 }),
			player('Lone IR', { injury: 'IR', ecr: 250 }),
		]),
		league('B', 'dynasty', [player('Wide Q', { injury: 'Q', ecr: 5 })]),
		league('C', 'dynasty', [player('Wide Q', { injury: 'Q', ecr: 5 })]),
	];
	const { rows } = computeInjuryExposure(leagues, DYNASTY);
	assert.deepEqual([...rows].map((r) => r.name), ['Lone IR', 'Wide Q'],
		'one league of IR leads three leagues of Questionable, fringe player and all');
}
{
	// The full ladder, worst first, one league each so only severity can be
	// ordering them. An unrecognised code ranks below everything known and so
	// sorts last — deliberate, since a string nobody has read must not lead a
	// card whose whole job is showing the worst thing first.
	const ladder = ['IR', 'PUP', 'NFI', 'SUSP', 'HOL', 'COVID', 'O', 'D', 'Q', 'DTD', 'P', 'ZZZ'];
	const leagues = [
		league('A', 'dynasty', ladder.map((s, i) => player(`P${i}`, { injury: s }))),
		league('B', 'dynasty', [player('Filler')]),
	];
	const { rows } = computeInjuryExposure(leagues, DYNASTY);
	assert.deepEqual([...rows].map((r) => r.status), ladder);
}
{
	// Within one severity tier the old ordering still applies: exposure, then
	// the better player.
	const leagues = [
		league('A', 'dynasty', [player('Wide', { injury: 'Q', ecr: 40 }), player('Narrow Good', { injury: 'Q', ecr: 5 }), player('Narrow Bad', { injury: 'Q', ecr: 90 })]),
		league('B', 'dynasty', [player('Wide', { injury: 'Q', ecr: 44 })]),
	];
	const { rows } = computeInjuryExposure(leagues, DYNASTY);
	assert.deepEqual([...rows].map((r) => r.name), ['Wide', 'Narrow Good', 'Narrow Bad']);
	assert.equal(rows[0].ecr, 42, 'ECR is the median across the leagues rostering him');
}
{
	// An unranked player sorts last among equals rather than first.
	const leagues = [
		league('A', 'dynasty', [player('Unranked', { injury: 'Q' }), player('Ranked', { injury: 'Q', ecr: 200 })]),
		league('B', 'dynasty', [player('Filler')]),
	];
	const { rows } = computeInjuryExposure(leagues, DYNASTY);
	assert.deepEqual([...rows].map((r) => r.name), ['Ranked', 'Unranked']);
	assert.equal(rows[1].ecr, null);
}

// --- A duplicated name inside one league counts once --------------------------
{
	const leagues = [
		league('A', 'dynasty', [player('Twice', { injury: 'O' }), player('Twice', { injury: 'O' })]),
		league('B', 'dynasty', [player('Twice', { injury: 'O' })]),
	];
	const { rows } = computeInjuryExposure(leagues, DYNASTY);
	assert.equal(rows[0].count, 2, 'two entries in one league are still one league of exposure');
}

// --- The NFL team rides through to both cards ---------------------------------
// Both analytics tables print it beside the name the way the roster tables do,
// which means it has to survive the per-player aggregation. It settles with the
// first league to carry the player, exactly as position does — the providers
// spell a few teams differently (MFL says LVR where Sleeper says LV), so this
// pins that a row gets one of them rather than nothing.
{
	const leagues = [
		league('A', 'dynasty', [player('Shared', { team: 'LVR', injury: 'Q' }), player('Solo', { team: 'KCC', injury: 'O' })]),
		league('B', 'salarycap', [player('Shared', { team: 'LV', injury: 'Q' })]),
	];
	assert.equal(rowFor(computeInjuryExposure(leagues, DYNASTY).rows, 'Shared').team, 'LVR', 'first league to carry him settles it');
	assert.equal(rowFor(computeInjuryExposure(leagues, DYNASTY).rows, 'Solo').team, 'KCC');
	assert.equal(rowFor(computePlayerExposure(leagues, DYNASTY).rows, 'Shared').team, 'LVR', 'and the player card agrees');
}

// --- The injury detail rides through the aggregation --------------------------
// It reaches the roster two different ways — by MFL player id for MFL leagues,
// by name for ESPN and Sleeper ones — so a player can easily carry it in one
// league and not another. Both copies come from the same global MFL report, so
// unlike the designation there is nothing to reconcile: the first one found is
// the answer, and a league without it must not blank it.
{
	const detail = { part: 'Hamstring', until: null };
	const leagues = [
		league('A', 'dynasty', [player('Matched Late', { injury: 'Q' })]),
		league('B', 'dynasty', [player('Matched Late', { injury: 'Q', detail })]),
	];
	assert.deepEqual(rowFor(computeInjuryExposure(leagues, DYNASTY).rows, 'Matched Late').detail, detail);

	// ...and a player nobody has detail for still renders, with none.
	const bare = [
		league('A', 'dynasty', [player('No Detail', { injury: 'O' })]),
		league('B', 'dynasty', [player('Filler')]),
	];
	assert.equal(computeInjuryExposure(bare, DYNASTY).rows[0].detail, null);
}

// --- What actually gets printed under the name --------------------------------
// A fixed `now` rather than the clock: every assertion below is about a date's
// distance from today, so a real clock would make this pass in August and fail
// in October.
{
	const now = new Date('2026-08-10T12:00:00Z').getTime();

	assert.equal(injuryDetailLine({ part: 'Hamstring', until: null }, now), 'Hamstring');
	assert.equal(injuryDetailLine({ part: 'Hamstring', until: 'Aug 15, 2026' }, now), 'Hamstring · back Aug 15',
		'the year is noise inside the window and is the widest part of the string');
	assert.equal(injuryDetailLine({ part: null, until: 'Sep 13, 2026' }, now), 'back Sep 13',
		'a return date stands on its own when the body part is Undisclosed');

	// The sentinel. MFL fills exp_return on every row, and the far dates are a
	// season-end placeholder for retired and season-ending cases rather than a
	// forecast — 17 distinct dates covered 325 rows. Printing "back Feb 15" in
	// August claims a precision the feed does not have.
	assert.equal(injuryDetailLine({ part: 'Personal', until: 'Feb 15, 2027' }, now), 'Personal',
		'a date past the horizon is dropped, the body part is not');
	assert.equal(injuryDetailLine({ part: null, until: 'Feb 15, 2027' }, now), null,
		'and with nothing else to say, there is no line at all');

	// A date already gone is the feed lagging, not news.
	assert.equal(injuryDetailLine({ part: 'Knee', until: 'Aug 1, 2026' }, now), 'Knee');
	// Today still counts — the horizon is the far edge, not both.
	assert.equal(injuryDetailLine({ part: null, until: 'Aug 10, 2026' }, now), 'back Aug 10');

	// A format nobody has looked at must not reach the card as "back Invalid
	// Date" or "back NaN".
	assert.equal(injuryDetailLine({ part: 'Ankle', until: 'sometime soon' }, now), 'Ankle');
	assert.equal(injuryDetailLine({ part: null, until: 'sometime soon' }, now), null);

	// Absent means "synced before this shipped", which renders as nothing at
	// all rather than as a claim that nothing is wrong.
	assert.equal(injuryDetailLine(null, now), null);
	assert.equal(injuryDetailLine({ part: null, until: null }, now), null);
}

console.log('injury exposure: all assertions passed');
