// Unit test for currentRecord/appendRecord in myffl.html — the W-L suffix
// appended to a team's name on the Rosters and Scoring tabs.
//
// The rule is deliberately narrow: read the record off this league's own
// standings (league.standings, already fetched for the Standings tab's own
// W-L column) and append it only when it isn't 0-0. A season-opening "0-0"
// on every row would be noise rather than information, and it's also what
// keeps a draftonly league silent here for free — its h2h fields are always
// zero (see showRecord in renderStandingsCard) — without a separate type
// check. The provider's own ties field is read nowhere here at all: every
// league this page tracks runs its own tiebreaker rule instead of letting a
// matchup stand as tied, so a nonzero ties count (however it got there) is
// silently dropped rather than rendered as a third number. Every way this
// can break is silent: a wrong franchiseId join renders a plausible record
// for the wrong team, and a missing 0-0 guard clutters every card in Week 1.
//
// As in test-cut-planning-window.mjs there is no DOM here: the page's
// script block is evaluated in a vm with the handful of browser globals it
// touches stubbed, so this runs the real source rather than a copy of it.

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
const { currentRecord, appendRecord, teamNameWithOwner } = context;

let failures = 0;
function check(name, cond) {
	if (cond) {
		console.log(`  ok   ${name}`);
	} else {
		failures++;
		console.log(`  FAIL ${name}`);
	}
}

const league = {
	franchiseId: '0001',
	standings: [
		{ franchiseId: '0001', teamName: 'Rumble Fish', wins: 5, losses: 2, ties: 0 },
		{ franchiseId: '0002', teamName: 'Fall Guys', wins: 3, losses: 3, ties: 1 },
		{ franchiseId: '0003', teamName: 'Winless', wins: 0, losses: 0, ties: 0 },
	],
};

check('a real record formats as W-L', currentRecord(league, '0001') === '5-2');
check('a nonzero ties count is dropped, not appended as -T', currentRecord(league, '0002') === '3-3');
check('0-0 is omitted, not formatted as "0-0"', currentRecord(league, '0003') === null);
check('a franchiseId absent from standings is omitted', currentRecord(league, 'ghost') === null);
check('no standings array at all degrades to omitted, not a crash', currentRecord({ franchiseId: '0001' }, '0001') === null);

check('appendRecord adds a parenthetical when a record is present', appendRecord('Rumble Fish', '5-2') === 'Rumble Fish (5-2)');
check('appendRecord leaves the name alone when the record is null', appendRecord('Winless', null) === 'Winless');

// Stacks with the owner parenthetical teamNameWithOwner already adds for
// the Scoring tab (ownerName), rather than either one dropping the other.
check(
	'record stacks with an owner name rather than replacing it',
	appendRecord(teamNameWithOwner({ teamName: 'Fall Guys', ownerName: 'Tyler' }), currentRecord(league, '0002'))
		=== 'Fall Guys (Tyler) (3-3)'
);

if (failures) {
	console.error(`test-team-record-suffix: ${failures} assertion(s) failed`);
	process.exit(1);
}
console.log('test-team-record-suffix: all assertions passed');
