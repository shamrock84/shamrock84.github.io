// Unit test for irEligibilityProblems (and its wiring into
// computeLeagueProblems) in myffl.html: the problems-digest rows that say a
// player can move to IR under the league's own rule (config `irEligibility`,
// hand-recorded because MFL's API doesn't expose it), and that a player on IR
// no longer qualifies. As in test-cut-planning-window.mjs there is no DOM: the
// page's script is evaluated in a vm with the browser globals stubbed, so this
// runs the real source rather than a copy of it.
//
// What it pins: nothing is said without a recorded rule; a move row needs a
// free IR slot and an active-roster (not taxi) player; an IR row only fires on
// a cleared or non-qualifying designation, never on a long-term one (PUP, NFI,
// SUSP...), which isn't a recovery.

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
const { irEligibilityProblems, computeLeagueProblems } = context;

let failures = 0;
function check(name, cond) {
	if (cond) {
		console.log(`  ok   ${name}`);
	} else {
		failures++;
		console.log(`  FAIL ${name}`);
	}
}

const player = (id, status, injuryStatus = null, extra = {}) => ({ id, name: `P${id}`, status, injuryStatus, ...extra });
const league = (irEligibility, players, ir = 4) => ({
	id: 'L1', season: '2026', irEligibility, players, rosterLimits: { size: 23, taxi: 4, ir, position: [] },
});
const kinds = (l) => irEligibilityProblems(l).map((p) => `${p.kind}:${p.player.id}`).sort().join(',');

// Nothing recorded -> silent, even with a plainly eligible player.
const hurt = [player('a', 'ROSTER', 'O')];
check('no rule recorded -> no rows', kinds(league(undefined, hurt)) === '');
check('an empty rule -> no rows', kinds(league([], hurt)) === '');

// Move to IR.
check('Out qualifies when the rule lists OUT', kinds(league(['OUT'], hurt)) === 'ir-move:a');
check('Out does not qualify when the rule lists only IR', kinds(league(['IR'], hurt)) === '');
check('Questionable qualifies only when listed',
	kinds(league(['OUT'], [player('q', 'ROSTER', 'Q')])) === '' && kinds(league(['QUESTIONABLE'], [player('q', 'ROSTER', 'Q')])) === 'ir-move:q');
check('Doubtful maps to D', kinds(league(['DOUBTFUL'], [player('d', 'ROSTER', 'D')])) === 'ir-move:d');
check('IR covers both NFL-IR spellings',
	kinds(league(['IR'], [player('i', 'ROSTER', 'IR'), player('r', 'ROSTER', 'IR R')])) === 'ir-move:i,ir-move:r');
check('a taxi player is never offered IR', kinds(league(['OUT'], [player('t', 'TAXI_SQUAD', 'O')])) === '');
check('a healthy rostered player is not offered IR', kinds(league(['OUT', 'IR'], [player('h', 'ROSTER')])) === '');
check('no free IR slot -> no move row',
	kinds(league(['OUT'], [player('a', 'ROSTER', 'O'), player('x', 'INJURED_RESERVE', 'O')], 1)) === '');
check('a league with no IR slots -> no move row', kinds(league(['OUT'], hurt, 0)) === '');
check('slot count unknown -> no move row', kinds(league(['OUT'], hurt, null)) === '');
check('a free slot still counts when others are full of qualifying players',
	kinds(league(['OUT'], [player('a', 'ROSTER', 'O'), player('x', 'INJURED_RESERVE', 'O')], 2)) === 'ir-move:a');

// Take off IR.
check('a healthy player on IR comes off', kinds(league(['OUT'], [player('h', 'INJURED_RESERVE')])) === 'ir-activate:h');
check('a still-qualifying player on IR stays', kinds(league(['OUT'], [player('x', 'INJURED_RESERVE', 'O')])) === '');
check('Questionable on IR comes off when only OUT/IR qualify',
	kinds(league(['OUT', 'IR'], [player('q', 'INJURED_RESERVE', 'Q')])) === 'ir-activate:q');
check('Questionable on IR stays when QUESTIONABLE is listed',
	kinds(league(['QUESTIONABLE'], [player('q', 'INJURED_RESERVE', 'Q')])) === '');
check('NFL IR on IR is never flagged, even if the rule omits IR',
	kinds(league(['OUT'], [player('i', 'INJURED_RESERVE', 'IR')])) === '');
check('a long-term designation (PUP/SUSP) on IR is not a recovery',
	kinds(league(['OUT'], [player('p', 'INJURED_RESERVE', 'PUP'), player('s', 'INJURED_RESERVE', 'SUSP')])) === '');
check('take-off rows do not need a free slot',
	kinds(league(['OUT'], [player('h', 'INJURED_RESERVE')], 1)) === 'ir-activate:h');
check('take-off rows do not need the slot count', kinds(league(['OUT'], [player('h', 'INJURED_RESERVE')], null)) === 'ir-activate:h');

// Row wording carries the injured part when the snapshot has one.
const withPart = irEligibilityProblems(league(['OUT'], [player('a', 'ROSTER', 'O', { injuryDetail: { part: 'Knee' } })]));
check('the body part rides in the label', /Knee/.test(withPart[0].label));

// Wiring into the digest: gated like roster-limit rows, and independent of the
// lineup (no starters / lineupWeek at all).
const wired = league(['OUT'], hurt);
check('computeLeagueProblems includes the IR rows', computeLeagueProblems(wired, '2026').some((p) => p.kind === 'ir-move'));
check('mid-draft rosters get none', !computeLeagueProblems({ ...wired, draftInProgress: true }, '2026').some((p) => p.kind === 'ir-move'));
check('a league still on last season gets none', !computeLeagueProblems({ ...wired, season: '2025' }, '2026').some((p) => p.kind === 'ir-move'));

if (failures) {
	console.log(`\n${failures} ir-eligibility test(s) failed.`);
	process.exit(1);
}
console.log('\nAll ir-eligibility tests passed.');
