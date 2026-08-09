// Unit test for the Analytics tab's Injury Exposure card — specifically
// computeInjuryExposure in myffl.html, which is where every decision that card
// makes actually lives.
//
// Four of those decisions are choices rather than consequences, and each one is
// invisible on a healthy week or a single league, which is why they're pinned
// here rather than left to be noticed on screen:
//
//   - the denominator is the *same* set of leagues the Player Exposure card
//     counts, so "3/9" means the same thing on both cards;
//   - a player flagged in one league counts in every league that rosters him,
//     because the provider feeds disagree routinely and it's the same body;
//   - singletons are kept, unlike the player card's count > 1 filter;
//   - the worst designation wins when the feeds disagree.
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

const { computeInjuryExposure, computePlayerExposure } = context;

// Shorthand for a rostered player. `injury` is the NFL designation as
// normalizeInjuryStatus leaves it; `slot` is the roster status.
function player(name, { pos = 'RB', team = 'BUF', injury = null, ecr = null, slot = 'ROSTER' } = {}) {
	return {
		name,
		position: pos,
		team,
		status: slot,
		injuryStatus: injury,
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
		league('A', 'dynasty', [player('Odd Code', { injury: 'HOL' })]),
		league('B', 'dynasty', [player('Odd Code', { injury: 'HOL' })]),
	];
	assert.equal(computeInjuryExposure(leagues, DYNASTY).rows[0].status, 'HOL');
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

// --- Ordering: exposure, then the better player -------------------------------
{
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

console.log('injury exposure: all assertions passed');
