// Unit test for the cross-league problems digest — computeLeagueProblems /
// computeProblemsDigest / parseLineupMinimums in myffl.html, the strip above
// the grid that collects everything needing attention across all leagues.
//
// Every decision pinned here is a *noise* decision, and noise failures are the
// quiet kind: a digest that flags too much doesn't error, it just trains the
// reader to stop looking at it, which is the same as not having one. The
// choices that keep it quiet:
//
//   - scoringError / standingsError / lineupError never appear — "No live
//     scoring available yet" is the normal preseason state on nearly every
//     league and MFL 429s heal on the next sync. Only the roster-level
//     `error` does, because that one means the whole card is stale fallback
//     rendering as fresh;
//   - Questionable starters are not flagged (the floor is Doubtful), and an
//     unrecognised designation ranks below the floor rather than above it;
//   - RET is flagged via INJURY_SETTLED even though it is deliberately absent
//     from INJURY_SEVERITY;
//   - absence of lineup data reads as "not asked", never as an empty lineup;
//   - a mid-draft league and a league still on last season get no lineup
//     checks at all — a true answer about a nonsense lineup is still noise;
//   - each starter yields at most one row, worst problem first: the slot
//     beats the injury beats the bye;
//   - the required-starters check uses the *minimum* implied by the
//     requirement string, so it can miss a short lineup but never flag a
//     legal one, and best-ball "0-N" strings can never fire it.
//
// As in test-injury-exposure.mjs there is no DOM here: the page's script
// block is evaluated in a vm with the browser globals stubbed, so this runs
// the real source rather than a copy of it.

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
		createTextNode: () => fakeElement(),
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

const { computeLeagueProblems, computeProblemsDigest, parseLineupMinimums } = context;

// A league with lineup data, current season, draft settled — the state where
// every lineup check is live. Overrides carve out the special cases.
function league(overrides = {}) {
	return {
		id: 'L1',
		name: 'Test League',
		season: '2026',
		draftInProgress: false,
		lineupWeek: '1',
		startingLineup: '1 QB, 2 RB, 3 WR, 1 TE, 1 PK, 1 Def',
		starters: [],
		players: [],
		...overrides,
	};
}

function player(id, { injury = null, slot = 'ROSTER', bye = '8', part = null } = {}) {
	return {
		id,
		name: `Player ${id}`,
		position: 'RB',
		team: 'BUF',
		status: slot,
		bye,
		injuryStatus: injury,
		injuryDetail: part ? { part } : null,
	};
}

const YEAR = 2026;
// Results cross the vm boundary as foreign-realm arrays, whose prototype
// strict deep-equality rejects — copy into host arrays before comparing.
const kinds = (problems) => [...problems].map((p) => p.kind);

// ---- What counts as an injury problem ------------------------------------

{
	// Q is below the floor; D, O, IR are at or above it; XX is a designation
	// the vocabulary has never seen and must land under the floor, not over.
	const l = league({
		starters: ['1', '2', '3', '4', '5'],
		startingLineup: null,
		players: [
			player('1', { injury: 'Q' }),
			player('2', { injury: 'D' }),
			player('3', { injury: 'O', part: 'Knee' }),
			player('4', { injury: 'IR' }),
			player('5', { injury: 'XX' }),
		],
	});
	const problems = computeLeagueProblems(l, YEAR);
	assert.deepEqual(kinds(problems), ['injury', 'injury', 'injury'], 'D/O/IR flagged; Q and unknown are not');
	assert.deepEqual([...problems].map((p) => p.player.id), ['2', '3', '4']);
	assert.match(problems[1].label, /listed O — Knee/, 'body part rides along when the report carries one');
	assert.match(problems[0].label, /week 1/, 'label names the week the lineup is for');
}

{
	// RET is deliberately absent from INJURY_SEVERITY (see its comment) and
	// must still be flagged, via INJURY_SETTLED — a retired starter is the
	// most settled problem a lineup can have.
	const l = league({ starters: ['1'], startingLineup: null, players: [player('1', { injury: 'RET' })] });
	assert.deepEqual(kinds(computeLeagueProblems(l, YEAR)), ['injury'], 'RET flagged via the settled list');
}

// ---- The slot beats the injury beats the bye ------------------------------

{
	// A healthy taxi-squad player in the lineup is the slot's problem; an
	// IR-slot player who is also on the injury report is ONE problem, not
	// two; an Out player on bye is the injury row alone.
	const l = league({
		lineupWeek: '8',
		starters: ['1', '2', '3'],
		startingLineup: null,
		players: [
			player('1', { slot: 'TAXI_SQUAD' }),
			player('2', { slot: 'INJURED_RESERVE', injury: 'IR' }),
			player('3', { injury: 'O', bye: '8' }),
		],
	});
	const problems = computeLeagueProblems(l, YEAR);
	assert.deepEqual(kinds(problems), ['ineligible', 'ineligible', 'injury'], 'one row per starter, worst problem first');
	assert.match(problems[0].label, /Taxi Squad/, 'slot named with its display label, not its key');
	assert.match(problems[1].label, /Injured Reserve/);
}

{
	// A healthy starter whose bye matches the lineup week is flagged; the
	// comparison is numeric on both sides (the snapshot carries strings).
	const l = league({
		lineupWeek: 8,
		starters: ['1', '2'],
		startingLineup: null,
		players: [player('1', { bye: '8' }), player('2', { bye: '9' })],
	});
	const problems = computeLeagueProblems(l, YEAR);
	assert.deepEqual(kinds(problems), ['bye']);
	assert.equal(problems[0].player.id, '1');
}

// ---- Absence of lineup data is "not asked", never "empty lineup" ----------

{
	// No starters array at all (the fifteen leagues that aren't lineup
	// pilots) and a lineup fetch that failed (starters: null) both yield no
	// lineup problems, however hurt the roster is. lineupError itself is
	// deliberately NOT a digest row — transient, retried in 4 hours, and
	// shown on its own card.
	const roster = [player('1', { injury: 'IR' })];
	assert.equal(computeLeagueProblems(league({ starters: undefined, lineupWeek: null, players: roster }), YEAR).length, 0);
	assert.equal(
		computeLeagueProblems(league({ starters: null, lineupWeek: null, lineupError: 'MFL request failed (429)', players: roster }), YEAR).length,
		0,
		'a failed lineup fetch is not a digest row'
	);
}

{
	// An actually-empty lineup where the fetch succeeded IS a row — red, not
	// gold — and the short check doesn't stack on top of it.
	const problems = computeLeagueProblems(league({ starters: [] }), YEAR);
	assert.deepEqual(kinds(problems), ['empty']);
	assert.match(problems[0].label, /No starters set for week 1/);
}

// ---- Mid-draft and last-season leagues get no lineup checks ---------------

{
	const roster = [player('1', { injury: 'O' })];
	const drafting = league({ draftInProgress: true, starters: ['1'], players: roster, error: 'boom' });
	assert.deepEqual(kinds(computeLeagueProblems(drafting, YEAR)), ['sync'], 'mid-draft: lineup checks suppressed, sync error still reported');

	const trailing = league({ season: '2025', starters: ['1'], players: roster });
	assert.equal(computeLeagueProblems(trailing, YEAR).length, 0, 'last season\'s lineup is not this week\'s problem');

	// A snapshot from before leagues carried `season` has no answer here —
	// NaN comparisons are false, so the checks stay on rather than silently
	// switching off for every league at once.
	const preSeason = league({ season: undefined, starters: ['1'], startingLineup: null, players: roster });
	assert.deepEqual(kinds(computeLeagueProblems(preSeason, YEAR)), ['injury'], 'missing season data keeps the checks');
}

// ---- Which sync errors surface --------------------------------------------

{
	const noisy = league({
		starters: undefined,
		lineupWeek: null,
		scoringError: 'No live scoring available yet',
		standingsError: 'MFL request failed (429)',
		rankingsError: 'no key',
	});
	assert.equal(computeLeagueProblems(noisy, YEAR).length, 0, 'scoring/standings/rankings errors never reach the digest');

	const broken = league({ starters: undefined, lineupWeek: null, error: 'ESPN request failed (401)' });
	const problems = computeLeagueProblems(broken, YEAR);
	assert.deepEqual(kinds(problems), ['sync'], 'the roster-level error does — stale data renders exactly like fresh');
	assert.match(problems[0].label, /ESPN request failed/);
}

// ---- The required-starters floor ------------------------------------------

{
	assert.equal(parseLineupMinimums('1 QB, 2 RB, 3 WR, 1 TE, 1 PK, 1 Def'), 9);
	assert.equal(parseLineupMinimums('1 QB, 2-3 RB, 2-3 WR, 1-2 TE, 1 PK, 1 Def'), 8, 'flex slots count their lower bound');
	assert.equal(parseLineupMinimums('0-2 QB, 0-8 RB, 0-8 WR, 0-8 TE'), 0, 'best-ball strings sum to zero and can never fire');
	assert.equal(parseLineupMinimums(null), null);
	assert.equal(parseLineupMinimums('TBD'), null, 'unparseable means no check, not a zero-slot lineup');
}

{
	const roster = Array.from({ length: 9 }, (_, i) => player(String(i + 1)));
	const short = league({ starters: ['1', '2', '3', '4', '5', '6', '7'], players: roster });
	const problems = computeLeagueProblems(short, YEAR);
	assert.deepEqual(kinds(problems), ['short']);
	assert.match(problems[0].label, /Only 7 of at least 9/);

	const legal = league({ starters: roster.map((p) => p.id), players: roster });
	assert.equal(computeLeagueProblems(legal, YEAR).length, 0, 'a full lineup is silent');

	const noRequirement = league({ starters: ['1'], startingLineup: null, players: roster });
	assert.equal(computeLeagueProblems(noRequirement, YEAR).length, 0, 'no requirement string, no short check');
}

// ---- Starter ids that don't resolve ---------------------------------------

{
	// A same-sync race between MFL's lineup and roster exports: the id is
	// skipped silently rather than crashing or fabricating a row about a
	// player nobody can name.
	const l = league({ starters: ['999'], startingLineup: null, players: [player('1')] });
	assert.equal(computeLeagueProblems(l, YEAR).length, 0);
}

// ---- The digest itself -----------------------------------------------------

{
	const clean = league({ id: 'A', starters: [], players: [] });
	clean.starters = Array.from({ length: 9 }, (_, i) => String(i + 1));
	clean.players = clean.starters.map((id) => player(id));
	const hurt = league({ id: 'B', starters: ['1'], startingLineup: null, players: [player('1', { injury: 'O' })] });
	const quiet = league({ id: 'C', starters: undefined, lineupWeek: null });

	const entries = computeProblemsDigest([clean, hurt, quiet], YEAR);
	assert.equal(entries.length, 1, 'only leagues with problems appear');
	assert.equal(entries[0].league.id, 'B');
	assert.equal(entries[0].problems.length, 1);

	assert.equal(computeProblemsDigest([clean, quiet], YEAR).length, 0, 'an all-clear digest is empty, which is what hides the strip');
	assert.equal(computeProblemsDigest(undefined, YEAR).length, 0, 'no leagues at all is also just quiet');
}

console.log('test-problems-digest: all assertions passed');
