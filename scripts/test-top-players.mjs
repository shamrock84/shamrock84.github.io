// Unit test for the Analytics tab's two ranking cards — computeTopPlayers and
// computeTopAvailable in myffl.html, plus availableFromPool in
// scripts/lib/fantasypros.mjs, which is the sync half of the same feature.
//
// These cards span the sync boundary in a way the exposure cards don't: the
// sync decides who is a free agent (it's the only side that can see every
// franchise's roster) and the page decides how to show them, and the two
// halves join on a normalized player name that exists twice in the codebase.
// The decisions pinned here are the ones that are invisible when wrong:
//
//   - the two name normalizers agree, so a player you own is recognised as
//     owned rather than quietly listed as if you didn't;
//   - a group spanning two ranking lists medians the ranks, the same way the
//     exposure cards do, rather than letting one list win;
//   - Top Available's denominator counts only leagues that could answer the
//     question — a league with no pool, or whose league-wide roster read
//     failed, is left out rather than counted as "not available there";
//   - `available: null` (couldn't tell) and `available: []` (nothing free)
//     are different, and only the second is a real answer;
//   - a pool entry's site-relative URL is expanded, never rebuilt from the
//     player's name.
//
// As in test-injury-exposure.mjs there is no DOM here: the page's script block
// is evaluated in a vm with the handful of browser globals it touches stubbed,
// so this runs the real source rather than a copy of it.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { normalizePlayerName, availableFromPool, AVAILABLE_LIMIT } from './lib/fantasypros.mjs';

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

const { computeTopPlayers, computeTopAvailable, normalizeName, poolPlayerUrl } = context;

const ACTIVE = ['dynasty', 'salarycap', 'redraft'];
const rowFor = (rows, name) => rows.find((r) => r.name === name);

// A ranking pool entry, as the sync writes it: rank, position, and a
// site-relative profile path.
function ranked(name, rank, position = 'RB') {
	return { name, position, rank, url: `/nfl/players/${rank}.php` };
}

function pool(key, players, { type = 'DRAFT', scoring = 'PPR', position = 'ALL' } = {}) {
	return [key, { type, scoring, position, lastUpdated: '8/08', players }];
}

// A league as data/rosters.json carries it. `rankings` is only the join key
// into the pools, so only the three parts of that key matter here.
function league(name, type, playerNames, { rankings = 'DRAFT|PPR|ALL', available = undefined } = {}) {
	const [rType, rScoring, rPosition] = rankings ? rankings.split('|') : [];
	return {
		name,
		leagueName: name,
		type,
		players: playerNames.map((n) => ({ name: n, position: 'RB' })),
		rankings: rankings ? { type: rType, scoring: rScoring, position: rPosition } : null,
		...(available === undefined ? {} : { available }),
	};
}

// --- The page's normalizer matches the sync's --------------------------------
// This is the join between a pool entry and a rostered player. A drift here is
// silent: the player simply stops being recognised as owned, on a card whose
// whole point is telling you which of the best players you already have.
{
	const corpus = [
		"Ja'Marr Chase",
		'Marvin Harrison Jr.',
		'Michael Pittman Jr',
		'Amon-Ra St. Brown',
		'Austin Ekelér',
		'D.K. Metcalf',
		'Kenneth Walker III',
		'Odell Beckham Jr. II',
		'Robert Griffin  III',
		'Chig Okonkwo',
		'  Trailing Space  ',
		'De’Von Achane',
		'Player V',
		'',
		null,
	];
	for (const name of corpus) {
		assert.equal(
			normalizeName(name),
			normalizePlayerName(name),
			`myffl.html's normalizeName disagrees with lib/fantasypros.mjs on ${JSON.stringify(name)}`
		);
	}
	// And that it actually does the work, rather than both being identity.
	assert.equal(normalizeName('Marvin Harrison Jr.'), 'marvin harrison');
	assert.equal(normalizeName("Ja'Marr Chase"), 'jamarr chase');
}

// --- Site-relative pool URLs expand, absolute ones pass through ---------------
{
	assert.equal(poolPlayerUrl('/nfl/players/jamarr-chase.php'), 'https://www.fantasypros.com/nfl/players/jamarr-chase.php');
	assert.equal(poolPlayerUrl('https://example.com/x'), 'https://example.com/x');
	assert.equal(poolPlayerUrl(null), null);
	assert.equal(poolPlayerUrl(''), null, 'no URL means no link, never a guessed one');
}

// --- Top Players: ownership, bolding input, and the group denominator ---------
{
	const pools = Object.fromEntries([
		pool('DRAFT|PPR|ALL', [ranked('Best Guy', 1), ranked('Second Guy', 2), ranked('Nobody Owns Him', 3)]),
	]);
	const leagues = [
		league('A', 'dynasty', ['Best Guy']),
		league('B', 'salarycap', ['Best Guy', 'Second Guy']),
		// In the group but no roster data — excluded from the denominator, the
		// same way the exposure cards exclude it.
		league('C', 'redraft', []),
		// A different sub-tab entirely.
		league('D', 'draftonly', ['Nobody Owns Him']),
	];

	const { total, rows } = computeTopPlayers(leagues, ACTIVE, pools);
	assert.equal(total, 2, 'only leagues in the group with rosters count');
	assert.deepEqual([...rows].map((r) => r.name), ['Best Guy', 'Second Guy', 'Nobody Owns Him'], 'ordered by rank');
	assert.deepEqual([...rowFor(rows, 'Best Guy').leagues], ['A', 'B']);
	assert.equal(rowFor(rows, 'Best Guy').count, 2);
	assert.deepEqual([...rowFor(rows, 'Second Guy').leagues], ['B']);
	assert.deepEqual(
		[...rowFor(rows, 'Nobody Owns Him').leagues],
		[],
		'a player owned only outside the group is listed, unowned — the sub-line is per group'
	);
	assert.equal(
		rowFor(rows, 'Best Guy').url,
		'https://www.fantasypros.com/nfl/players/1.php',
		'the pool URL is expanded for the link'
	);
}

// --- Top Players: a roster name that differs in spelling still matches --------
{
	const pools = Object.fromEntries([pool('DRAFT|PPR|ALL', [ranked('Marvin Harrison Jr.', 1)])]);
	const leagues = [
		league('A', 'dynasty', ['Marvin Harrison']),
		league('B', 'dynasty', ['MARVIN HARRISON JR']),
	];
	const { rows } = computeTopPlayers(leagues, ACTIVE, pools);
	assert.equal(rows.length, 1);
	assert.deepEqual([...rows[0].leagues], ['A', 'B'], 'suffix and case differences still count as owned');
	assert.equal(rows[0].name, 'Marvin Harrison Jr.', 'the ranking list spells the name');
}

// --- Top Players: two ranking lists in one group are medianed -----------------
// Dynasty leagues read the DYNASTY list while the salary-cap leagues beside
// them read DRAFT. Taking either list alone would order the card by how one
// half of the portfolio is run.
{
	const pools = Object.fromEntries([
		pool('DYNASTY|PPR|ALL', [ranked('Young Guy', 1), ranked('Old Guy', 30)], { type: 'DYNASTY' }),
		pool('DRAFT|PPR|ALL', [ranked('Old Guy', 2), ranked('Young Guy', 20)]),
	]);
	const leagues = [
		league('A', 'dynasty', [], { rankings: 'DYNASTY|PPR|ALL' }),
		league('B', 'salarycap', [], { rankings: 'DRAFT|PPR|ALL' }),
	];
	// Both leagues have empty rosters, so nothing is eligible and neither pool
	// is read — the cards follow the rosters, not the config.
	assert.equal(computeTopPlayers(leagues, ACTIVE, pools).rows.length, 0);

	const stocked = [
		league('A', 'dynasty', ['Filler'], { rankings: 'DYNASTY|PPR|ALL' }),
		league('B', 'salarycap', ['Filler'], { rankings: 'DRAFT|PPR|ALL' }),
	];
	const { rows } = computeTopPlayers(stocked, ACTIVE, pools);
	assert.equal(rowFor(rows, 'Young Guy').ecr, 11, 'median of 1 and 20');
	assert.equal(rowFor(rows, 'Old Guy').ecr, 16, 'median of 30 and 2');
	assert.deepEqual([...rows].map((r) => r.name), ['Young Guy', 'Old Guy']);
}
{
	// Weighting is by league, not by list: three leagues on one list should pull
	// the order towards it against one league on another.
	const pools = Object.fromEntries([
		pool('DYNASTY|PPR|ALL', [ranked('Rookie', 1), ranked('Veteran', 50)], { type: 'DYNASTY' }),
		pool('DRAFT|PPR|ALL', [ranked('Veteran', 2), ranked('Rookie', 60)]),
	]);
	const leagues = [
		league('A', 'salarycap', ['Filler']),
		league('B', 'salarycap', ['Filler']),
		league('C', 'redraft', ['Filler']),
		league('D', 'dynasty', ['Filler'], { rankings: 'DYNASTY|PPR|ALL' }),
	];
	const { rows } = computeTopPlayers(leagues, ACTIVE, pools);
	assert.deepEqual([...rows].map((r) => r.name), ['Veteran', 'Rookie'], 'the three DRAFT leagues carry the order');
}

// --- Top Players: a league whose rankings failed still counts as owning -------
// It has no pool to contribute, but it is still in the denominator, so leaving
// its roster out would print "1/2" for a player owned in both.
{
	const pools = Object.fromEntries([pool('DRAFT|PPR|ALL', [ranked('Shared', 1)])]);
	const leagues = [
		league('A', 'dynasty', ['Shared']),
		{ ...league('B', 'dynasty', ['Shared']), rankings: null, rankingsError: 'boom' },
	];
	const { total, rows } = computeTopPlayers(leagues, ACTIVE, pools);
	assert.equal(total, 2);
	assert.equal(rows[0].count, 2);
	assert.deepEqual([...rows[0].leagues], ['A', 'B']);
}

// --- Top Players: no pools at all means no card -------------------------------
// A data/rosters.json synced before rankingPools existed, or by a run with no
// FantasyPros key. The card renders nothing rather than an empty table.
{
	const leagues = [league('A', 'dynasty', ['Somebody'])];
	assert.equal(computeTopPlayers(leagues, ACTIVE, {}).rows.length, 0);
	assert.equal(computeTopPlayers(leagues, ACTIVE, undefined).rows.length, 0);
}

// --- Top Available: which leagues a free agent is free in ---------------------
{
	const pools = Object.fromEntries([
		pool('DRAFT|PPR|ALL', [ranked('Wire Gem', 5), ranked('Wire Filler', 40), ranked('Owned Everywhere', 1)]),
	]);
	const leagues = [
		league('A', 'dynasty', ['Owned Everywhere'], { available: ['Wire Gem', 'Wire Filler'] }),
		league('B', 'salarycap', ['Owned Everywhere', 'Wire Filler'], { available: ['Wire Gem'] }),
	];
	const { total, rows } = computeTopAvailable(leagues, ACTIVE, pools);
	assert.equal(total, 2);
	assert.deepEqual([...rows].map((r) => r.name), ['Wire Gem', 'Wire Filler'], 'ordered by rank');
	assert.deepEqual([...rowFor(rows, 'Wire Gem').leagues], ['A', 'B']);
	assert.equal(rowFor(rows, 'Wire Gem').count, 2);
	assert.deepEqual([...rowFor(rows, 'Wire Filler').leagues], ['A']);
	assert.equal(rowFor(rows, 'Owned Everywhere'), undefined);
	assert.equal(rowFor(rows, 'Wire Gem').url, 'https://www.fantasypros.com/nfl/players/5.php');
}

// --- Top Available: "couldn't tell" is not "nothing available" ----------------
// availableFromPool returns null when the league-wide roster couldn't be read —
// ESPN's is best-effort. Counting that league in the denominator would report a
// free agent as available in 1 of 2 leagues when the second league was never
// asked.
{
	const pools = Object.fromEntries([pool('DRAFT|PPR|ALL', [ranked('Wire Gem', 5)])]);
	const known = league('A', 'dynasty', ['Filler'], { available: ['Wire Gem'] });
	const unknown = league('B', 'dynasty', ['Filler'], { available: null });
	const { total, rows } = computeTopAvailable([known, unknown], ACTIVE, pools);
	assert.equal(total, 1, 'a league that could not answer is out of the denominator');
	assert.equal(rows[0].count, 1);
	assert.deepEqual([...rows[0].leagues], ['A']);
}
{
	// An empty array is an answer: nothing in the pool is free there. It stays
	// in the denominator.
	const pools = Object.fromEntries([pool('DRAFT|PPR|ALL', [ranked('Wire Gem', 5)])]);
	const leagues = [
		league('A', 'dynasty', ['Filler'], { available: ['Wire Gem'] }),
		league('B', 'dynasty', ['Filler'], { available: [] }),
	];
	const { total, rows } = computeTopAvailable(leagues, ACTIVE, pools);
	assert.equal(total, 2);
	assert.equal(rows[0].count, 1, 'free in one of the two leagues that answered');
}
{
	// A league with availability but no pool to look the names up in can't
	// contribute either — the rank and the link both live on the pool entry.
	const leagues = [
		{ ...league('A', 'dynasty', ['Filler'], { available: ['Wire Gem'] }), rankings: null },
	];
	assert.equal(computeTopAvailable(leagues, ACTIVE, {}).total, 0);
}

// --- Top Available: ranks come from the leagues he's free in ------------------
{
	const pools = Object.fromEntries([
		pool('DYNASTY|PPR|ALL', [ranked('Split', 10)], { type: 'DYNASTY' }),
		pool('DRAFT|PPR|ALL', [ranked('Split', 80)]),
	]);
	const leagues = [
		league('A', 'dynasty', ['Filler'], { rankings: 'DYNASTY|PPR|ALL', available: ['Split'] }),
		// Rostered here, so this league's rank of 80 has no say.
		league('B', 'salarycap', ['Split'], { available: [] }),
	];
	const { rows } = computeTopAvailable(leagues, ACTIVE, pools);
	assert.equal(rows[0].ecr, 10, 'medianed over the leagues he is actually free in');
}

// --- availableFromPool: the sync half ----------------------------------------
{
	const p = {
		players: [ranked('Free One', 1), ranked('Rostered', 2), ranked('Free Two', 3)],
	};
	assert.deepEqual(
		availableFromPool(p, ['Rostered', 'Somebody Unranked']),
		['Free One', 'Free Two'],
		'everyone in the pool that nobody rosters, best first'
	);
	assert.deepEqual(availableFromPool(p, ['Rostered', 'Free One', 'Free Two']), []);
}
{
	// Spelling differences across providers are normalized on this side too.
	const p = { players: [ranked('Marvin Harrison Jr.', 1)] };
	assert.deepEqual(availableFromPool(p, ['marvin harrison']), []);
}
{
	// No pool, or a roster read that came back with nothing, is "don't know" —
	// never an empty availability list, which the page would believe.
	assert.equal(availableFromPool(null, ['Anyone']), null);
	assert.equal(availableFromPool({ players: [ranked('X', 1)] }, null), null);
	assert.equal(availableFromPool({ players: [ranked('X', 1)] }, []), null);
}
{
	// Capped, so a pre-draft redraft league — where the entire pool is free —
	// doesn't store the whole ranking list back again once per league.
	const players = Array.from({ length: AVAILABLE_LIMIT + 25 }, (_, i) => ranked(`Player ${i}`, i + 1));
	const all = availableFromPool({ players }, ['Nobody Rostered']);
	assert.equal(all.length, AVAILABLE_LIMIT);
	assert.equal(all[0], 'Player 0', 'the best available, not an arbitrary slice');
}

console.log('test-top-players: all assertions passed');
