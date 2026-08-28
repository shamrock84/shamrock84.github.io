// Unit test for the values that exist twice on purpose — once in the sync and
// once in myffl.html's script block — because the page has no build step and
// no imports, so the only alternative to a second copy is shipping the value
// inside data/rosters.json for every player it applies to.
//
// There are three such duplications. Each one drifts silently: nothing throws,
// nothing looks wrong on screen, a number is just quietly computed against the
// wrong list.
//
//   normalizeName + NAME_SUFFIX  vs  normalizePlayerName (lib/fantasypros.mjs)
//       The join between a ranking-pool entry and a rostered player. Pinned
//       behaviourally, over a corpus of real name shapes, in
//       test-top-available.mjs — a stronger guard than comparing the regexes
//       would be, which is why it isn't repeated here and why NAME_SUFFIX is
//       deliberately left unexported.
//
//   POWER_POSITIONS              vs  lib/fantasypros.mjs   — must be IDENTICAL
//   POSITION_ORDER               vs  lib/providers.mjs     — must NOT be
//
// The last one is the interesting case and the reason this file exists: the
// two lists are meant to differ, so the test has to encode the relationship
// rather than assert equality. Get that wrong in the obvious direction and
// you'd "fix" the page by pasting the sync's list in, which would put a row of
// IDP positions into a sort that has never needed them.
//
// As in test-top-available.mjs there is no DOM here: the page's script block is
// evaluated in a vm with the handful of browser globals it touches stubbed, so
// this runs the real source rather than a copy of it.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { POWER_POSITIONS as SYNC_POWER_POSITIONS } from './lib/fantasypros.mjs';
import { POSITION_ORDER as SYNC_POSITION_ORDER } from './lib/providers.mjs';

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
// The values under test are `const`s, and a top-level `const` in a vm script
// is lexically scoped rather than becoming a property of the context the way a
// function declaration does — so unlike the other tests here, reading them off
// `context` afterwards yields undefined. Appending the capture puts it in the
// same scope as the declarations, which is what makes them reachable without
// changing myffl.html to suit its tests.
vm.runInContext(
	`${scriptSource}\n;globalThis.__shared = { POWER_POSITIONS, POSITION_ORDER, positionRank };`,
	context
);

// Copied into host-realm arrays as they cross out of the vm. An array built
// inside the context has that realm's Array.prototype, and deepStrictEqual
// compares prototypes — so without this, two identical lists fail with a diff
// that shows no difference at all.
const positionRank = context.__shared.positionRank;
const POWER_POSITIONS = [...context.__shared.POWER_POSITIONS];
const POSITION_ORDER = [...context.__shared.POSITION_ORDER];

// --- The constants are actually reachable ------------------------------------
// A rename on the page side would otherwise leave every assertion below
// comparing undefined to undefined and passing.
{
	assert.ok(Array.isArray(POWER_POSITIONS), 'myffl.html no longer defines POWER_POSITIONS');
	assert.ok(Array.isArray(POSITION_ORDER), 'myffl.html no longer defines POSITION_ORDER');
	assert.equal(typeof positionRank, 'function', 'myffl.html no longer defines positionRank');
	assert.ok(SYNC_POWER_POSITIONS.length > 0 && SYNC_POSITION_ORDER.length > 0);
}

// --- POWER_POSITIONS: identical, both ways -----------------------------------
// The page splits a roster into these groups for Team Needs and reads the
// per-position ranks the sync computed under the same list. A position in one
// and not the other doesn't error — it renders a column the other side never
// filled, or silently drops a group the sync did compute.
{
	assert.deepEqual(
		POWER_POSITIONS,
		SYNC_POWER_POSITIONS,
		'POWER_POSITIONS in myffl.html must match lib/fantasypros.mjs exactly, including order'
	);
}

// --- POSITION_ORDER: the page's list is a subsequence of the sync's ----------
// The sync's list also carries the IDP positions (PN, Off, DL, DE, DT, LB, CB,
// S, DB); the page lists only what its leagues actually roster. So equality is
// the wrong test. What must hold is that the page's list is the sync's list
// filtered down — same members, same relative order — which catches a position
// renamed on either side, and a page-side reordering, while still allowing the
// sync to know about positions the page doesn't.
{
	for (const pos of POSITION_ORDER) {
		assert.ok(
			SYNC_POSITION_ORDER.includes(pos),
			`POSITION_ORDER in myffl.html lists ${pos}, which lib/providers.mjs doesn't know about`
		);
	}
	// Filtering the sync's list by what the page knows must reproduce the page's
	// list exactly. One assertion covering both membership and ordering.
	assert.deepEqual(
		POSITION_ORDER,
		SYNC_POSITION_ORDER.filter((pos) => POSITION_ORDER.includes(pos)),
		"POSITION_ORDER in myffl.html must keep lib/providers.mjs's relative order"
	);
}

// --- Every position actually in the data is rankable by the page -------------
// The check that fires the day an IDP league is added. positionRank returns the
// same fallback rank for everything it doesn't recognise, so an unlisted
// position doesn't throw — a whole defensive roster just sorts as one
// undifferentiated block at the end. Read off the committed snapshot, which is
// real synced data, so this is a question about the leagues that exist rather
// than a hypothetical.
//
// If this fires: add the missing positions to POSITION_ORDER in myffl.html, in
// the order lib/providers.mjs already lists them.
{
	const snapshot = path.join(root, 'data', 'rosters.json');
	const data = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
	const seen = new Set();
	for (const league of data.leagues || []) {
		for (const player of league.players || []) {
			if (player.position) seen.add(player.position);
		}
	}
	assert.ok(seen.size > 0, 'data/rosters.json carries no rostered players to check');

	const unrankable = [...seen].filter((pos) => !POSITION_ORDER.includes(pos));
	assert.deepEqual(
		unrankable,
		[],
		`data/rosters.json carries position(s) myffl.html's POSITION_ORDER can't rank: ${unrankable.join(', ')}`
	);

	// And that the fallback is what this test assumes it is, so the reasoning
	// above stays true if positionRank is ever rewritten.
	assert.equal(
		positionRank('DL'),
		positionRank('CB'),
		'positionRank is expected to give every unlisted position one shared rank'
	);
	assert.ok(
		positionRank('DL') > positionRank(POSITION_ORDER[POSITION_ORDER.length - 1]),
		'an unlisted position must sort after every listed one'
	);
}

console.log('test-shared-constants: all assertions passed');
