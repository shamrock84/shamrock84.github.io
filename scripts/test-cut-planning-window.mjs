// Unit test for duringWeeks1Through17 in myffl.html — the boundary that gates
// the Dynasty cut-planning dropdown and its banner (see showCutPlanning in
// renderCard).
//
// This is deliberately a narrower window than nflInSeason(), which runs
// through the Super Bowl for the FantasyPros ranking-set flip: cut planning
// has nothing to do with that calendar, and the user drew the line at the
// last game of Week 17 instead, so the NFL playoffs (Week 17's end through
// the Super Bowl) are cut-planning season too, not blacked out the way
// nflInSeason() would treat them.
//
// The reason this gets its own test rather than trusting nflInSeason()'s
// pattern: nflInSeason()'s Super Bowl boundary is pinned to a fixed February
// calendar date and never needs to know when the season that led up to it
// kicked off. The last game of Week 17 is 116 days after kickoff, and kickoff
// itself moves across a 7-day range depending on which day of the week Labor
// Day falls on — enough for the Week 17 landing date to cross the new year in
// some seasons and not others. A date in the first days of January can belong
// to either the walk from this year's kickoff or last year's, and getting
// that wrong either extends the blackout into what should be open cut-
// planning season, or opens the window while Week 17 is still being played.
//
// As in test-plan-sync.mjs there is no DOM here: the page's script block is
// evaluated in a vm with the handful of browser globals it touches stubbed,
// so this runs the real source rather than a copy of it.

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
const { duringWeeks1Through17 } = context;

let failures = 0;
function check(name, cond) {
	if (cond) {
		console.log(`  ok   ${name}`);
	} else {
		failures++;
		console.log(`  FAIL ${name}`);
	}
}

// 2026 season: Labor Day is Mon Sep 7 -> kickoff Thu Sep 10 -> Week 17
// Monday Night lands 116 days later, Jan 4 2027.
check('the day before kickoff is open', !duringWeeks1Through17(new Date('2026-09-09T12:00:00Z')));
check('kickoff itself is blacked out', duringWeeks1Through17(new Date('2026-09-10T00:00:00Z')));
check('mid-season (November) is blacked out', duringWeeks1Through17(new Date('2026-11-15T12:00:00Z')));
check('Week 17 Monday Night itself is still blacked out', duringWeeks1Through17(new Date('2027-01-04T23:00:00Z')));
check('the day after Week 17 ends is open', !duringWeeks1Through17(new Date('2027-01-05T12:00:00Z')));
// The window this test exists for: the old nflInSeason()-based gate would
// have kept this blacked out all the way through the Super Bowl.
check('the playoffs, well after Week 17, are open', !duringWeeks1Through17(new Date('2027-01-20T12:00:00Z')));
check('the Super Bowl itself is open (unlike nflInSeason)', !duringWeeks1Through17(new Date('2027-02-08T12:00:00Z')));
check('deep offseason (July) is open', !duringWeeks1Through17(new Date('2026-07-01T12:00:00Z')));

// 2025 season: Labor Day is Mon Sep 1 -> kickoff Thu Sep 4 -> Week 17 Monday
// Night lands 116 days later, Dec 29 2025 — the landing date does NOT cross
// into the new year this time, unlike the 2026 season above. A date read
// against the wrong year's kickoff would get both of the next two wrong.
check('a Week 17 landing that stays in December is still caught', duringWeeks1Through17(new Date('2025-12-29T23:00:00Z')));
check('and opens the very next day', !duringWeeks1Through17(new Date('2025-12-30T12:00:00Z')));

// The wraparound case the two-year check exists for: early January, where
// last season's Week 17 walk (kicked off the previous September) can still
// be running even though this calendar year's own kickoff is many months
// away. 2027-01-02 falls three days before the 2026-season Week 17 Monday
// Night computed above (2027-01-04), so it must still read as blacked out.
check('early January can still belong to last season’s Week 17', duringWeeks1Through17(new Date('2027-01-02T12:00:00Z')));

if (failures) {
	console.log(`\n${failures} cut-planning-window test(s) failed.`);
	process.exit(1);
}
console.log('\nAll cut-planning-window tests passed.');
