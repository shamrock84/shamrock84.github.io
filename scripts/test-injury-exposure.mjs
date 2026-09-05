// Unit test for the Analytics tab's Injury Exposure and Loss Exposure cards
// — computeInjuryExposure and computeLossExposure in myffl.html, which is
// where every decision those cards make actually lives.
//
// The two cards are one designation vocabulary split by INJURY_SETTLED:
// Injury Exposure keeps Probable/Questionable/Doubtful/Out and anything else
// still developing (COVID, an unrecognised code); Loss Exposure keeps
// Injured Reserve (plain or the short-term IR R variant), PUP, NFI, a
// suspension, a holdout, the Commissioner Exempt list (NA), or Retired. Both
// share one aggregation (collectInjuryDesignations) and one badness scale
// (INJURY_SEVERITY), so most of what's pinned below — the shared
// denominator, keeping a flagged-in-one-league player counted everywhere
// he's rostered, keeping singletons, the worst designation winning when
// feeds disagree, an unrecognised code ranking last rather than being
// swallowed — applies identically to both and is exercised on whichever
// card the status in play belongs to. What's new here is the partition
// itself: a player's worst designation puts him on exactly one of the two
// cards, never both, and never demoted within one — and the two cards read
// that shared scale in opposite directions: Injury Exposure sorts worst
// first (sortByWorstFirst), Loss Exposure sorts best-chance-of-returning
// first (sortByBestChanceFirst).
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

const { computeInjuryExposure, computeLossExposure, computePlayerExposure, injuryDetailLine } = context;

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
// leagues entries now carry {name, url} rather than a bare name, for the
// card's own league-name links — this test only cares which leagues.
const names = (entries) => [...entries].map((e) => e.name);

// --- The denominator matches Player Exposure, on both cards -------------------
{
	const leagues = [
		league('A', 'dynasty', [player('Hurt Guy', { injury: 'O' })]),
		league('B', 'salarycap', [player('Hurt Guy', { injury: 'O' }), player('Fine Guy')]),
		// No roster data: counted by neither card, so it can't quietly deflate
		// the percentage on any of them.
		league('C', 'dynasty', []),
		// Different group entirely.
		league('D', 'draftonly', [player('Hurt Guy', { injury: 'O' })]),
	];

	const injury = computeInjuryExposure(leagues, DYNASTY);
	const loss = computeLossExposure(leagues, DYNASTY);
	const exposure = computePlayerExposure(leagues, DYNASTY);
	assert.equal(injury.total, 2, 'only leagues in the group with rosters count');
	assert.equal(injury.total, exposure.total, 'Injury Exposure shares a denominator with Player Exposure');
	assert.equal(loss.total, exposure.total, 'and so does Loss Exposure, even with no settled rows here');
	assert.equal(rowFor(injury.rows, 'Hurt Guy').count, 2);
	assert.equal(Math.round(rowFor(injury.rows, 'Hurt Guy').exposure), 100);
	assert.equal(rowFor(injury.rows, 'Fine Guy'), undefined, 'healthy players are left out');
	assert.equal(loss.rows.length, 0, 'nobody here carries a settled designation');
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
	assert.deepEqual(names(rowFor(rows, 'Half Flagged').leagues), ['A', 'B']);
	assert.equal(Math.round(rowFor(rows, 'Half Flagged').exposure), 100);
}

// --- Singletons are kept, on both cards ---------------------------------------
// The player card drops count === 1 because it answers "where am I
// concentrated". These cards answer "who of mine is hurt/gone", and dropping
// singletons would hide most of the answer.
{
	const leagues = [
		league('A', 'dynasty', [player('Lone Reserve', { injury: 'IR' })]),
		league('B', 'dynasty', [player('Somebody Else')]),
	];
	const { rows } = computeLossExposure(leagues, DYNASTY);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].count, 1);
	assert.equal(Math.round(rows[0].exposure), 50);
	assert.equal(computePlayerExposure(leagues, DYNASTY).rows.length, 0, 'the player card still drops singletons');
}
{
	const leagues = [
		league('A', 'dynasty', [player('Lone Question', { injury: 'Q' })]),
		league('B', 'dynasty', [player('Somebody Else')]),
	];
	const { rows } = computeInjuryExposure(leagues, DYNASTY);
	assert.equal(rows.length, 1, 'the same reasoning holds on Injury Exposure');
	assert.equal(rows[0].count, 1);
}

// --- The worst designation wins, within a card --------------------------------
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
	// swallowed — normalizeInjuryStatus passes short codes through unmapped. It
	// isn't in INJURY_SETTLED either, so it lands on Injury Exposure.
	const leagues = [
		league('A', 'dynasty', [player('Odd Code', { injury: 'ZZZ' })]),
		league('B', 'dynasty', [player('Odd Code', { injury: 'ZZZ' })]),
	];
	assert.equal(computeInjuryExposure(leagues, DYNASTY).rows[0].status, 'ZZZ');
}

// --- The settled/live split is a partition between cards, not a tiebreak -----
// A player's worst designation across leagues decides both what he's shown
// carrying and which single card he appears on — never both, never neither.
{
	// A real IR still beats a Questionable in the reduce — an unrecognised
	// string ranks -1, so it must never mask a real IR. Since IR is settled,
	// the row lives on Loss Exposure only.
	const leagues = [
		league('A', 'dynasty', [player('Mixed', { injury: 'ZZZ' })]),
		league('B', 'dynasty', [player('Mixed', { injury: 'IR' })]),
	];
	assert.equal(computeLossExposure(leagues, DYNASTY).rows[0].status, 'IR');
	assert.equal(rowFor(computeInjuryExposure(leagues, DYNASTY).rows, 'Mixed'), undefined,
		'he does not also appear on Injury Exposure');
}
{
	// A merely Questionable player in one league and IR in another is shown as
	// IR — INJURY_SEVERITY still decides the worst designation across leagues
	// — and IR being settled puts the whole row on Loss Exposure, not split
	// across both cards.
	const leagues = [
		league('A', 'dynasty', [player('Disputed', { injury: 'Q' })]),
		league('B', 'dynasty', [player('Disputed', { injury: 'IR' })]),
	];
	assert.equal(computeLossExposure(leagues, DYNASTY).rows[0].status, 'IR');
	assert.equal(rowFor(computeInjuryExposure(leagues, DYNASTY).rows, 'Disputed'), undefined);
}
{
	// HOL is a holdout, reaching the page from MFL as an unmapped passthrough
	// and ranked by hand, above a suspension: a suspension has a defined end
	// date and better odds of returning soon, a holdout is open-ended until a
	// contract is signed. It's settled either way, so a holdout never shows on
	// Injury Exposure regardless of what it beats.
	const leagues = [
		league('A', 'dynasty', [player('Holding Out', { injury: 'HOL' })]),
		league('B', 'dynasty', [player('Holding Out', { injury: 'O' })]),
	];
	assert.equal(computeLossExposure(leagues, DYNASTY).rows[0].status, 'HOL', 'a holdout outranks Out and settles on Loss Exposure');
	assert.equal(rowFor(computeInjuryExposure(leagues, DYNASTY).rows, 'Holding Out'), undefined);

	const vsSuspension = [
		league('A', 'dynasty', [player('Also Banned', { injury: 'HOL' })]),
		league('B', 'dynasty', [player('Also Banned', { injury: 'SUSP' })]),
	];
	assert.equal(computeLossExposure(vsSuspension, DYNASTY).rows[0].status, 'HOL', 'a holdout outranks a suspension — worse odds of returning soon');
}

// --- Live and settled are two disjoint cards, not one demoted list -----------
// The two cards used to be one, with settled rows demoted to the bottom
// rather than filtered out. A player who settles no longer sinks within a
// shared card — he simply isn't on Injury Exposure, and shows up, undemoted,
// on Loss Exposure instead.
{
	const leagues = [
		league('A', 'dynasty', [player('Parked', { injury: 'IR' })]),
		league('B', 'dynasty', [player('Filler')]),
	];
	assert.equal(computeInjuryExposure(leagues, DYNASTY).rows.length, 0, 'a settled designation never appears on Injury Exposure');
	const { rows } = computeLossExposure(leagues, DYNASTY);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].status, 'IR');
}

// --- An IR slot with no designation still counts, on Loss Exposure -----------
{
	const leagues = [
		league('A', 'dynasty', [player('Parked', { slot: 'INJURED_RESERVE' })]),
		league('B', 'dynasty', [player('Parked', { slot: 'ROSTER' })]),
	];
	const { rows } = computeLossExposure(leagues, DYNASTY);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].status, 'IR');
}
{
	// The feed's own designation wins over the slot when both are present —
	// here the feed says Q, which is live, so the row is on Injury Exposure
	// and never reaches Loss Exposure at all.
	const solo = [player('Parked', { slot: 'INJURED_RESERVE', injury: 'Q' })];
	const leagues = [league('A', 'dynasty', solo), league('B', 'dynasty', [player('X')])];
	assert.equal(computeInjuryExposure(leagues, DYNASTY).rows[0].status, 'Q');
	assert.equal(rowFor(computeLossExposure(leagues, DYNASTY).rows, 'Parked'), undefined);
}

// --- IR R: MFL's own short-term/return-designated reserve code ---------------
// Reaches the page as the literal string "IR R" — normalizeInjuryStatus
// (providers.mjs) passes it through unmapped, the same way HOL does — and is
// real, current data: Trevor Etienne carries it in data/rosters.json as this
// is written. It has to land on Loss Exposure like any other settled
// designation, not fall through to Injury Exposure as an unrecognised code.
{
	const leagues = [
		league('A', 'dynasty', [player('Short Term', { injury: 'IR R' })]),
		league('B', 'dynasty', [player('Filler')]),
	];
	assert.equal(rowFor(computeLossExposure(leagues, DYNASTY).rows, 'Short Term').status, 'IR R');
	assert.equal(rowFor(computeInjuryExposure(leagues, DYNASTY).rows, 'Short Term'), undefined,
		'IR R is settled, not an unrecognised live code');
}
{
	// It carries better odds of returning this season than a plain IR
	// placement, so it wins the "best chance first" ordering, and it beats a
	// plain IR in arbitration too — the more specific, more hopeful read of
	// the same underlying reserve slot.
	const leagues = [
		league('A', 'dynasty', [player('Better Odds', { injury: 'IR R' }), player('Worse Odds', { injury: 'IR' })]),
		league('B', 'dynasty', [player('Filler')]),
	];
	const { rows } = computeLossExposure(leagues, DYNASTY);
	assert.deepEqual([...rows].map((r) => r.name), ['Better Odds', 'Worse Odds']);

	const disputed = [
		league('A', 'dynasty', [player('Disputed', { injury: 'IR' })]),
		league('B', 'dynasty', [player('Disputed', { injury: 'IR R' })]),
	];
	assert.equal(computeLossExposure(disputed, DYNASTY).rows[0].status, 'IR', 'a plain IR still beats IR R when providers disagree');
}

// --- Ordering: worst designation first, within each card ----------------------
// Now that the settled/live split is a boundary between two cards rather than
// a tiebreak within one, each card's own order is severity alone worst-first,
// then exposure, then the better player.
{
	const leagues = [
		league('A', 'dynasty', [
			player('Wide Q', { injury: 'Q', ecr: 5 }),
			player('Solo Out', { injury: 'O', ecr: 250 }),
		]),
		league('B', 'dynasty', [player('Wide Q', { injury: 'Q', ecr: 5 })]),
		league('C', 'dynasty', [player('Wide Q', { injury: 'Q', ecr: 5 })]),
	];
	const { rows } = computeInjuryExposure(leagues, DYNASTY);
	assert.deepEqual([...rows].map((r) => r.name), ['Solo Out', 'Wide Q'],
		'Out outranks Questionable regardless of how many leagues the Questionable spans');
}
{
	// The live ladder, worst first: Out, Doubtful, Questionable, Probable,
	// Day-to-Day. COVID ranks below all four — rare enough to be deprioritized
	// rather than lead the card the way it once did — and ZZZ (unrecognised)
	// ranks lower still, the true bottom of this card: it neither leads it nor
	// gets filed as a standing loss on the strength of a string nobody has read.
	const live = ['O', 'D', 'Q', 'P', 'DTD', 'COVID', 'ZZZ'];
	const leagues = [
		league('A', 'dynasty', live.map((s, i) => player(`P${i}`, { injury: s }))),
		league('B', 'dynasty', [player('Filler')]),
	];
	const { rows } = computeInjuryExposure(leagues, DYNASTY);
	assert.deepEqual([...rows].map((r) => r.status), live);
}
{
	// The settled ladder, but ordered by best chance of returning first —
	// Loss Exposure runs this card in the opposite direction from Injury
	// Exposure. IR R (MFL's own short-term/return-designated reserve code)
	// leads, its PUP/NFI cousins right behind it; a suspension (defined end
	// date) beats a holdout (open-ended); the Commissioner Exempt list (NA)
	// and a plain IR placement carry no such date; Retired trails everything,
	// since a retired player is never coming back.
	const settled = ['IR R', 'PUP', 'NFI', 'SUSP', 'HOL', 'NA', 'IR', 'RET'];
	const leagues = [
		league('A', 'dynasty', settled.map((s, i) => player(`P${i}`, { injury: s }))),
		league('B', 'dynasty', [player('Filler')]),
	];
	const { rows } = computeLossExposure(leagues, DYNASTY);
	assert.deepEqual([...rows].map((r) => r.status), settled);
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
{
	// Loss Exposure carries the team through the same way.
	const leagues = [
		league('A', 'dynasty', [player('Reserved', { team: 'SFO', injury: 'IR' })]),
		league('B', 'dynasty', [player('Filler')]),
	];
	assert.equal(rowFor(computeLossExposure(leagues, DYNASTY).rows, 'Reserved').team, 'SFO');
}

// --- One player, two spellings, one row ---------------------------------------
// The live case this exists for: MFL calls him "Michael Penix Jr.", Sleeper
// calls him "Michael Penix". Keyed on the raw string he was two rows at half
// the exposure each, and both rows looked right. Both cards key on
// normalizeName now, so the suffix, the punctuation and the accent are all the
// same player.
{
	const leagues = [
		league('A', 'dynasty', [player('Michael Penix Jr.', { injury: 'Q' })]),
		league('B', 'dynasty', [player('Michael Penix', { injury: 'Q' })]),
		league('C', 'dynasty', [player('michael penix', { injury: 'Q' })]),
	];
	const { total, rows } = computeInjuryExposure(leagues, DYNASTY);
	assert.equal(rows.length, 1, 'three spellings are one player');
	assert.equal(rows[0].count, 3);
	assert.equal(Math.round(rows[0].exposure), 100);
	assert.equal(rows[0].name, 'Michael Penix Jr.', 'the first league to carry him spells him');
	assert.equal(total, 3);

	// The player card has to agree, or the two cards would disagree about who is
	// who while sharing a denominator.
	const exposure = computePlayerExposure(leagues, DYNASTY);
	assert.equal(exposure.rows.length, 1);
	assert.equal(exposure.rows[0].count, 3);
}
{
	// Punctuation and accents, the other half of what normalizeName folds.
	const leagues = [
		league('A', 'dynasty', [player("Ja'Marr Chase", { injury: 'Q' })]),
		league('B', 'dynasty', [player('JaMarr Chase', { injury: 'Q' })]),
	];
	assert.equal(computeInjuryExposure(leagues, DYNASTY).rows.length, 1);

	const accented = [
		league('A', 'dynasty', [player('Austin Ekelér', { injury: 'Q' })]),
		league('B', 'dynasty', [player('Austin Ekeler', { injury: 'Q' })]),
	];
	assert.equal(computeInjuryExposure(accented, DYNASTY).rows.length, 1);
}
{
	// Two spellings inside one league are still one league of exposure — the
	// per-league `seen` set has to normalise too, or the fix would turn a
	// duplicate into a double count.
	const leagues = [
		league('A', 'dynasty', [player('Michael Penix Jr.', { injury: 'O' }), player('Michael Penix', { injury: 'O' })]),
		league('B', 'dynasty', [player('Michael Penix', { injury: 'O' })]),
	];
	const { rows } = computeInjuryExposure(leagues, DYNASTY);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].count, 2, 'two entries in one league are one league, whatever they are called');
}
{
	// Different players stay different. The names have to actually normalise
	// alike to merge — this is the reassurance that the key is not simply a
	// surname.
	const leagues = [
		league('A', 'dynasty', [player('Michael Penix', { injury: 'Q' }), player('Michael Pittman', { injury: 'Q' })]),
		league('B', 'dynasty', [player('Filler')]),
	];
	assert.equal(computeInjuryExposure(leagues, DYNASTY).rows.length, 2);
}

// --- The injury detail rides through the aggregation, on both cards -----------
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
{
	const detail = { part: 'Personal', until: null };
	const leagues = [
		league('A', 'dynasty', [player('Reserved Detail', { injury: 'IR', detail })]),
		league('B', 'dynasty', [player('Filler')]),
	];
	assert.deepEqual(rowFor(computeLossExposure(leagues, DYNASTY).rows, 'Reserved Detail').detail, detail);
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
