// Unit test for the Analytics tab's Top Available card — computeTopAvailable
// in myffl.html, plus availableFromPool and the once-a-day re-read rule in the
// sync, which are the other half of the same feature.
//
// This card spans the sync boundary in a way the exposure cards don't: the
// sync decides who is a free agent (it's the only side that can see every
// franchise's roster) and the page decides how to show them, and the two
// halves join on a normalized player name that exists twice in the codebase.
// The decisions pinned here are the ones that are invisible when wrong:
//
//   - the two name normalizers agree, so a player you hold is recognised as
//     held rather than quietly shown as one you don't have;
//   - the free-in and own-in counts share one denominator, so the pair reads
//     as a partition of the same leagues;
//   - that denominator counts only leagues that could answer the question — a
//     league with no pool, or whose league-wide roster read failed, is left
//     out of both counts rather than counted as "not available there";
//   - `available: null` (couldn't tell) and `available: []` (nothing free)
//     are different, and only the second is a real answer;
//   - the free agent list is re-read once a day, not once a sync, and a league
//     whose read failed is retried immediately rather than waiting a day;
//   - a league still on last season is excluded if it redrafts and kept if its
//     rosters carry over, and either way the exclusion is counted rather than
//     quietly shrinking the denominator;
//   - a pool entry's site-relative URL is expanded, never rebuilt from the
//     player's name, and its NFL team is carried through rather than guessed.
//
// (There was a Top Players card sharing this machinery. It's gone; what it
// pinned that still matters — the name join, the pool URL rule — is covered
// here, since Top Available leans on both just as hard.)
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
import { availabilityIsFresh } from './fetch-rosters.mjs';

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

const { computeTopAvailable, normalizeName, poolPlayerUrl } = context;

// The Dynasty/Salary Cap sub-tab. Redraft is its own group now — see
// SUBTAB_GROUP — but these functions take their types as an argument, so what
// is being pinned here is the behaviour of a group spanning several types,
// whichever types those are.
const ACTIVE = ['dynasty', 'salarycap'];
const rowFor = (rows, name) => rows.find((r) => r.name === name);
// leagues/ownedLeagues entries now carry {name, url} rather than a bare
// name, for the card's own league-name links — most assertions here only
// care which leagues, not their urls.
const names = (entries) => [...entries].map((e) => e.name);

// A ranking pool entry, as the sync writes it: rank, position, NFL team, and a
// site-relative profile path.
function ranked(name, rank, position = 'RB', team = 'BUF') {
	return { name, position, team, rank, url: `/nfl/players/${rank}.php` };
}

function pool(key, players, { type = 'DRAFT', scoring = 'PPR', position = 'ALL' } = {}) {
	return [key, { type, scoring, position, lastUpdated: '8/08', players }];
}

// A league as data/rosters.json carries it. `rankings` is only the join key
// into the pools, so only the three parts of that key matter here.
function league(name, type, playerNames, { rankings = 'DRAFT|PPR|ALL', available = undefined, season = undefined } = {}) {
	const [rType, rScoring, rPosition] = rankings ? rankings.split('|') : [];
	return {
		name,
		leagueName: name,
		type,
		players: playerNames.map((n) => ({ name: n, position: 'RB' })),
		rankings: rankings ? { type: rType, scoring: rScoring, position: rPosition } : null,
		...(available === undefined ? {} : { available }),
		...(season === undefined ? {} : { season }),
	};
}

// The season the sync was aiming at, as data/rosters.json's top-level `year`.
const YEAR = '2026';

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

// --- Top Available: free-in and own-in, against one shared denominator --------
// The two counts are the point of the card: a player free in three leagues you
// don't hold him in is a different proposition from one you're already
// three-deep on. Both are counted over the leagues that could answer the
// availability question, so "free in 2/3, own in 1/3" reads as a partition of
// the same three leagues rather than two unrelated fractions.
{
	const pools = Object.fromEntries([
		pool('DRAFT|PPR|ALL', [ranked('Wire Gem', 5), ranked('Half Mine', 20), ranked('Rostered Everywhere', 1)]),
	]);
	const leagues = [
		league('A', 'dynasty', ['Rostered Everywhere'], { available: ['Wire Gem', 'Half Mine'] }),
		league('B', 'salarycap', ['Rostered Everywhere', 'Half Mine'], { available: ['Wire Gem'] }),
		league('C', 'dynasty', ['Rostered Everywhere', 'Half Mine'], { available: ['Wire Gem'] }),
	];
	const { total, rows } = computeTopAvailable(leagues, ACTIVE, pools);
	assert.equal(total, 3);

	const gem = rowFor(rows, 'Wire Gem');
	assert.equal(gem.count, 3, 'free everywhere');
	assert.equal(gem.ownedCount, 0, 'and owned nowhere');
	assert.deepEqual(names(gem.ownedLeagues), []);

	const half = rowFor(rows, 'Half Mine');
	assert.equal(half.count, 1);
	assert.deepEqual(names(half.leagues), ['A'], 'free only where nobody has him');
	assert.equal(half.ownedCount, 2);
	assert.deepEqual(names(half.ownedLeagues), ['B', 'C'], 'and ours in the two that do');
	assert.equal(half.count + half.ownedCount, 3, 'the two counts partition the same leagues');

	// A player nobody has left unrostered anywhere is not a row here however
	// many of our teams he is on — that is the exposure card's question.
	assert.equal(rowFor(rows, 'Rostered Everywhere'), undefined);
}

// --- Top Available: a player owned under a different spelling still counts ----
// Same join as everywhere else, and the same silent failure if it drifts: the
// row would claim you don't hold a player you do.
{
	const pools = Object.fromEntries([pool('DRAFT|PPR|ALL', [ranked('Marvin Harrison Jr.', 1)])]);
	const leagues = [
		league('A', 'dynasty', ['Filler'], { available: ['Marvin Harrison Jr.'] }),
		league('B', 'dynasty', ['MARVIN HARRISON'], { available: [] }),
	];
	const { rows } = computeTopAvailable(leagues, ACTIVE, pools);
	assert.equal(rows.length, 1);
	assert.deepEqual(names(rows[0].leagues), ['A']);
	assert.deepEqual(names(rows[0].ownedLeagues), ['B'], 'suffix and case differences still count as owned');
}

// --- Top Available: ownership is only counted where availability was read -----
// A league left out of the denominator must be left out of both counts, or the
// row prints two fractions over different bottoms.
{
	const pools = Object.fromEntries([pool('DRAFT|PPR|ALL', [ranked('Wire Gem', 5)])]);
	const leagues = [
		league('A', 'dynasty', ['Filler'], { available: ['Wire Gem'] }),
		// Owns him, but its league-wide roster read failed, so it can say
		// nothing about who is free.
		league('B', 'dynasty', ['Wire Gem'], { available: null }),
	];
	const { total, rows } = computeTopAvailable(leagues, ACTIVE, pools);
	assert.equal(total, 1);
	assert.equal(rows[0].count, 1);
	assert.equal(rows[0].ownedCount, 0, 'a league that could not be checked contributes to neither count');
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
	assert.deepEqual(names(rowFor(rows, 'Wire Gem').leagues), ['A', 'B']);
	assert.equal(rowFor(rows, 'Wire Gem').count, 2);
	assert.deepEqual(names(rowFor(rows, 'Wire Filler').leagues), ['A']);
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
	assert.deepEqual(names(rows[0].leagues), ['A']);
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

// --- Top Available: a league mid-draft is excluded, and said so ---------------
// The sync clears `available` for a drafting league, so it drops out of the
// denominator on its own. What's pinned here is that it drops out *visibly* —
// a card that quietly says "2 leagues" when you have three is the same class of
// silent wrongness as a bad denominator.
{
	const pools = Object.fromEntries([pool('DRAFT|PPR|ALL', [ranked('Wire Gem', 5)])]);
	const leagues = [
		league('A', 'dynasty', ['Filler'], { available: ['Wire Gem'] }),
		league('B', 'dynasty', ['Filler'], { available: [] }),
		// Mid-draft: the sync nulled its list and flagged it.
		{ ...league('C', 'dynasty', ['Filler'], { available: null }), draftInProgress: true },
	];
	const { total, rows, drafting } = computeTopAvailable(leagues, ACTIVE, pools);
	assert.equal(total, 2, 'the drafting league is out of the denominator');
	assert.equal(drafting, 1, 'and is counted so the card can explain itself');
	assert.equal(rows[0].count, 1);
	assert.equal(rows[0].ownedCount, 0);
}
{
	// draftInProgress false or absent is an ordinary league, not a drafting one.
	const pools = Object.fromEntries([pool('DRAFT|PPR|ALL', [ranked('Wire Gem', 5)])]);
	const leagues = [
		{ ...league('A', 'dynasty', ['Filler'], { available: ['Wire Gem'] }), draftInProgress: false },
		league('B', 'dynasty', ['Filler'], { available: [] }),
	];
	const { total, drafting } = computeTopAvailable(leagues, ACTIVE, pools);
	assert.equal(total, 2);
	assert.equal(drafting, 0);
}
{
	// A league whose availability read merely failed is NOT reported as
	// drafting — same missing data, entirely different reason, and telling the
	// reader a draft is running when one isn't is its own kind of wrong.
	const pools = Object.fromEntries([pool('DRAFT|PPR|ALL', [ranked('Wire Gem', 5)])]);
	const leagues = [
		league('A', 'dynasty', ['Filler'], { available: ['Wire Gem'] }),
		league('B', 'dynasty', ['Filler'], { available: null }),
	];
	const { total, drafting } = computeTopAvailable(leagues, ACTIVE, pools);
	assert.equal(total, 1);
	assert.equal(drafting, 0);
}

// --- Top Available: a league that hasn't rolled over is excluded, and said so --
// A redraft-style league still sitting on last season is showing a roster that
// is about to be wiped, so the handful of names left unrostered at the end of
// that season are not this season's wire — this season's wire is everybody,
// until the draft runs. Same failure the mid-draft exclusion guards against,
// reached from the other direction, so it drops out of the denominator the same
// way and gets its own count so the card can explain the missing league.
{
	const pools = Object.fromEntries([pool('DRAFT|PPR|ALL', [ranked('Wire Gem', 5), ranked('Last Years Leftover', 9)])]);
	const leagues = [
		league('Rolled Over', 'draftonly', ['Filler'], { available: ['Wire Gem'], season: YEAR }),
		league('Also Rolled Over', 'draftonly', ['Filler'], { available: ['Wire Gem'], season: YEAR }),
		// Its 2026 league doesn't exist at the provider yet, so resolveSeason
		// left it on 2025 and everything it carries is last season's.
		league('Still On Last Season', 'draftonly', ['Filler'], { available: ['Last Years Leftover'], season: '2025' }),
	];
	const { total, rows, awaiting } = computeTopAvailable(leagues, ['draftonly'], pools, YEAR);
	assert.equal(total, 2, 'the league awaiting rollover is out of the denominator');
	assert.equal(awaiting, 1, 'and is counted so the card can explain itself');
	assert.equal(rowFor(rows, 'Wire Gem').count, 2);
	assert.equal(rowFor(rows, 'Last Years Leftover'), undefined, "last season's leftovers are not this season's wire");
}
{
	// Dynasty and salary-cap leagues are deliberately exempt: their rosters carry
	// across the offseason, so a league trailing during the rollover window —
	// MFL leagues reopen anywhere from February to April — is stale, not wrong.
	// Excluding those would empty the card for weeks every spring.
	const pools = Object.fromEntries([pool('DRAFT|PPR|ALL', [ranked('Wire Gem', 5)])]);
	const leagues = [
		league('Dynasty Behind', 'dynasty', ['Filler'], { available: ['Wire Gem'], season: '2025' }),
		league('Cap Behind', 'salarycap', ['Filler'], { available: ['Wire Gem'], season: '2025' }),
	];
	const { total, awaiting } = computeTopAvailable(leagues, ACTIVE, pools, YEAR);
	assert.equal(total, 2);
	assert.equal(awaiting, 0);
}
{
	// Both halves of the comparison have to be there to mean anything. A
	// rosters.json written before leagues carried their own `season`, or a caller
	// with no target year, must not silently drop every redraft league.
	const pools = Object.fromEntries([pool('DRAFT|PPR|ALL', [ranked('Wire Gem', 5)])]);
	const noSeason = [
		league('A', 'draftonly', ['Filler'], { available: ['Wire Gem'] }),
		league('B', 'draftonly', ['Filler'], { available: [] }),
	];
	assert.equal(computeTopAvailable(noSeason, ['draftonly'], pools, YEAR).total, 2, 'no season recorded means no answer, not exclusion');
	assert.equal(computeTopAvailable(noSeason, ['draftonly'], pools, YEAR).awaiting, 0);

	const withSeason = [
		league('A', 'draftonly', ['Filler'], { available: ['Wire Gem'], season: '2025' }),
		league('B', 'draftonly', ['Filler'], { available: [], season: '2025' }),
	];
	assert.equal(computeTopAvailable(withSeason, ['draftonly'], pools, undefined).total, 2, 'no target year means no answer either');
	assert.equal(computeTopAvailable(withSeason, ['draftonly'], pools, undefined).awaiting, 0);

	// And a league level with the target, or somehow ahead of it, is ordinary.
	const current = [
		league('A', 'draftonly', ['Filler'], { available: ['Wire Gem'], season: YEAR }),
		league('B', 'draftonly', ['Filler'], { available: [], season: '2027' }),
	];
	assert.equal(computeTopAvailable(current, ['draftonly'], pools, YEAR).awaiting, 0);
}
{
	// The two excluded states partition the group rather than double-counting a
	// league that is in both. Rollover wins, because a draft flag on a league
	// that hasn't rolled over describes last season's draft.
	const pools = Object.fromEntries([pool('DRAFT|PPR|ALL', [ranked('Wire Gem', 5)])]);
	const leagues = [
		league('Fine', 'draftonly', ['Filler'], { available: ['Wire Gem'], season: YEAR }),
		{ ...league('Both', 'draftonly', ['Filler'], { available: null, season: '2025' }), draftInProgress: true },
	];
	const { total, drafting, awaiting } = computeTopAvailable(leagues, ['draftonly'], pools, YEAR);
	assert.equal(total, 1);
	assert.equal(awaiting, 1);
	assert.equal(drafting, 0, 'counted once, under the reason that actually applies');
}

// --- Top Available: the NFL team rides through from the pool ------------------
// A row here is a player no roster of ours holds, so there is no roster copy to
// read a team off — it has to come from the pool entry the sync wrote. Absent
// rather than 'FA' when the pool predates the field, which is what lets the
// renderer tell "no NFL team" from "don't know" and print nothing for the
// second.
{
	const pools = Object.fromEntries([
		pool('DRAFT|PPR|ALL', [ranked('Wire Gem', 5, 'WR', 'KC'), { name: 'Old Pool Entry', position: 'RB', rank: 6, url: '/x.php' }]),
	]);
	const leagues = [
		league('A', 'draftonly', ['Filler'], { available: ['Wire Gem', 'Old Pool Entry'], season: YEAR }),
		league('B', 'draftonly', ['Filler'], { available: [], season: YEAR }),
	];
	const { rows } = computeTopAvailable(leagues, ['draftonly'], pools, YEAR);
	assert.equal(rowFor(rows, 'Wire Gem').team, 'KC');
	assert.equal(rowFor(rows, 'Old Pool Entry').team, undefined, 'a pool synced before the field carries no claim');
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

// --- The once-a-day rule for re-reading league-wide rosters -------------------
// Reading every franchise's roster is the most expensive thing the sync does —
// sixteen heavy MFL exports, four of which came back 429 on the run that proved
// it — and a free agent pool doesn't move in four hours. Getting this wrong is
// quiet in both directions: too eager and the sync starves the fetches that
// matter, too lazy and a league's wire silently freezes.
{
	const now = new Date('2026-08-09T12:00:00Z');
	const hoursAgo = (h) => new Date(now.getTime() - h * 3600 * 1000).toISOString();
	const read = (h) => ({ available: ['Somebody'], availableAt: hoursAgo(h) });

	assert.equal(availabilityIsFresh(read(4), now), true, 'the sync four hours later keeps it');
	assert.equal(availabilityIsFresh(read(19), now), true);
	assert.equal(availabilityIsFresh(read(21), now), false, 'past the threshold it is re-read');

	// Twenty hours, not twenty-four, and this is the case that says why: with a
	// four-hourly sync, a 24h rule is missed by the run a day later and honoured
	// by the one after, so the daily read walks four hours later every day.
	assert.equal(availabilityIsFresh(read(23.9), now), false, 'a day-later sync is still due');

	// Never read, and read-but-failed, are both due immediately rather than
	// waiting out a day — a 429 during the daily pass must not strand a league.
	assert.equal(availabilityIsFresh(undefined, now), false);
	assert.equal(availabilityIsFresh({}, now), false);
	assert.equal(availabilityIsFresh({ available: null, availableAt: hoursAgo(1) }, now), false, 'a failed read is retried next sync');
	assert.equal(availabilityIsFresh({ available: ['X'] }, now), false, 'a list with no timestamp predates the rule');
	assert.equal(availabilityIsFresh({ available: ['X'], availableAt: 'not a date' }, now), false);

	// An empty list is a real answer — nothing in the pool is free — and keeps
	// its place in the cache rather than being re-read every sync.
	assert.equal(availabilityIsFresh({ available: [], availableAt: hoursAgo(2) }, now), true);

	// The manual override ignores all of it.
	assert.equal(availabilityIsFresh(read(1), now, true), false, 'refresh_availability forces a re-read');
}

console.log('test-top-available: all assertions passed');
