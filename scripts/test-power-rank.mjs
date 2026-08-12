// Unit test for the power ranks — the sync-side scoring in
// scripts/lib/fantasypros.mjs (buildProjectionIndex / computePowerScore /
// computeLeaguePower), the provider slot parsing in scripts/lib/providers.mjs
// (startingSlotCounts / slotsFromSleeperRosterPositions), and the page-side
// join in myffl.html (powerRanksForLeague).
//
// Every decision pinned here fails silently: a wrong join or a wrong slot
// shape still renders a plausible column of small numbers, and nothing on
// screen says franchise 0007 was credited with the wrong Josh Allen. The
// calls that matter:
//
//   - MFL joins by id (roster player ids ARE the projections' mflid);
//     everyone else joins by name, and a Sleeper id that happens to look
//     like an mflid must never be treated as one — the two id spaces are
//     both small numeric strings;
//   - a name collision resolves to *nobody* (tombstone), same rule as
//     buildRankingIndex, because the wrong body is worse than no body;
//   - the score fills dedicated slots before flex, so a flex slot never
//     steals the last RB from an RB slot whatever order the slots arrived;
//   - kicker/defense/IDP slots never enter the valuation, but their
//     minimums still count against MFL's starters.count, or their slots
//     would be handed to flex;
//   - a slot nobody can fill contributes zero rather than erroring;
//   - MFL flex is the gap between starters.count and the accounted
//     minimums, eligible only to skill positions whose range has headroom —
//     and with no count the minimums stand alone (an undercount, but the
//     same undercount for every franchise, which is all an ordinal needs);
//   - the page joins power to standings by franchiseId, ties share a rank,
//     and a league without power data yields null so the column is absent
//     rather than a row of dashes.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import {
  buildProjectionIndex,
  computePowerScore,
  computeLeaguePower,
  DEFAULT_POWER_SLOTS,
} from './lib/fantasypros.mjs';
import { startingSlotCounts, slotsFromSleeperRosterPositions } from './lib/providers.mjs';

// ---- Projection index ------------------------------------------------------

// Shaped from what probe-fantasypros-power-rank.yml actually printed:
// { fpid, mflid, name, position_id, team_id, filename, stats: { points,
//   points_ppr, points_half, ... } }.
function projPlayer(name, mflid, { ppr = 100, half = 90, std = 80 } = {}) {
  return {
    fpid: 1,
    mflid,
    name,
    position_id: 'QB',
    team_id: 'BUF',
    stats: { points: std, points_ppr: ppr, points_half: half },
  };
}

{
  const index = buildProjectionIndex({
    QB: [projPlayer('Josh Allen', 13589, { ppr: 372.2, half: 372.2, std: 372.2 })],
    RB: [projPlayer('Josh Allen', 99999, { ppr: 50 })],
    WR: [projPlayer('No MFL Id', 0, { ppr: 10 })],
  });
  assert.equal(index.byMflId.get('13589').points.PPR, 372.2, 'mflid keys are strings of the response number');
  assert.equal(index.byMflId.get('13589').position, 'QB', 'position comes from which list the player was on');
  assert.equal(index.byMflId.get('99999').points.PPR, 50);
  assert.equal(index.byName.get('josh allen'), null, 'a shared name tombstones to null — the wrong body is worse than no body');
  assert.equal(index.byMflId.has('0'), false, 'mflid 0 is FantasyPros for "no id", not a key');
  assert.equal(index.byName.get('no mfl id').points.PPR, 10, 'a player without an mflid is still reachable by name');
}

// ---- Greedy lineup valuation -----------------------------------------------

{
  // Flex listed FIRST to pin that dedicated slots still fill first: the one
  // RB must land in the RB slot, and flex takes the best of what remains.
  const slots = [
    { positions: ['RB', 'WR', 'TE'], count: 1 },
    { positions: ['RB'], count: 1 },
    { positions: ['WR'], count: 1 },
  ];
  const players = [
    { position: 'RB', points: 200 },
    { position: 'WR', points: 180 },
    { position: 'WR', points: 150 },
  ];
  const { score, filled, slotCount } = computePowerScore(players, slots);
  assert.equal(score, 200 + 180 + 150, 'dedicated before flex, flex from best remaining');
  assert.equal(filled, 3);
  assert.equal(slotCount, 3);
}

{
  // Superflex takes the second QB when he outscores every remaining skill
  // player — the whole reason those leagues rank QBs the way they do.
  const slots = [
    { positions: ['QB'], count: 1 },
    { positions: ['RB'], count: 1 },
    { positions: ['QB', 'RB', 'WR', 'TE'], count: 1 },
  ];
  const players = [
    { position: 'QB', points: 350 },
    { position: 'QB', points: 300 },
    { position: 'RB', points: 250 },
    { position: 'RB', points: 100 },
  ];
  assert.equal(computePowerScore(players, slots).score, 350 + 250 + 300);
}

{
  // A slot nobody can fill is a shortfall, not a crash — and it shows in
  // filled vs slotCount, which is what the page's tooltip surfaces.
  const { score, filled, slotCount } = computePowerScore(
    [{ position: 'RB', points: 120 }],
    [{ positions: ['RB'], count: 2 }, { positions: ['TE'], count: 1 }]
  );
  assert.equal(score, 120);
  assert.equal(filled, 1);
  assert.equal(slotCount, 3);
}

// ---- MFL slot parsing ------------------------------------------------------

// Shaped like TYPE=league's starters node, per formatStartingLineupRequirement
// which parses the same thing for display.
function mflStarters(positions, count) {
  return { league: { starters: { count, position: positions } } };
}

{
  // The classic shape: ranges encode the flex, count caps the lineup. Mins
  // are 1+2+2+1 skill + 1 PK + 1 Def = 8 against a 9-man lineup, so exactly
  // one flex slot exists — eligible to RB/WR/TE (headroom) but not QB (1-1)
  // and never PK/Def.
  const slots = startingSlotCounts(mflStarters([
    { name: 'QB', limit: '1' },
    { name: 'RB', limit: '2-3' },
    { name: 'WR', limit: '2-3' },
    { name: 'TE', limit: '1-2' },
    { name: 'PK', limit: '1' },
    { name: 'Def', limit: '1' },
  ], '9'));
  const flex = slots.find((s) => s.positions.length > 1);
  assert.deepEqual(flex, { positions: ['RB', 'WR', 'TE'], count: 1 });
  assert.equal(slots.filter((s) => s.positions.length === 1).length, 4, 'PK and Def never become entries');
  assert.equal(slots.reduce((n, s) => n + s.count, 0), 7, 'skill mins plus the one flex');
}

{
  // Superflex: QB 1-2 has headroom, so QB joins the flex eligibility.
  const slots = startingSlotCounts(mflStarters([
    { name: 'QB', limit: '1-2' },
    { name: 'RB', limit: '2-4' },
    { name: 'WR', limit: '3-5' },
    { name: 'TE', limit: '1-3' },
  ], '10'));
  const flex = slots.find((s) => s.positions.length > 1);
  assert.deepEqual(flex.positions, ['QB', 'RB', 'WR', 'TE']);
  assert.equal(flex.count, 10 - 7);
}

{
  // No count from MFL: the minimums stand alone rather than guessing a flex.
  const slots = startingSlotCounts(mflStarters([
    { name: 'QB', limit: '1-2' },
    { name: 'RB', limit: '2-3' },
  ], undefined));
  assert.equal(slots.every((s) => s.positions.length === 1), true);
  assert.equal(slots.reduce((n, s) => n + s.count, 0), 3);
}

{
  // A literal "+" flex slot is its own entry at its max, and counts against
  // the total so the gap isn't double-granted.
  const slots = startingSlotCounts(mflStarters([
    { name: 'QB', limit: '1' },
    { name: 'RB+WR+TE', limit: '1-2' },
  ], '3'));
  assert.deepEqual(slots, [
    { positions: ['QB'], count: 1 },
    { positions: ['RB', 'WR', 'TE'], count: 2 },
  ], 'no leftover gap: 1 QB + 2 flex accounts for all 3');
}

{
  assert.equal(startingSlotCounts({ league: {} }), null, 'no starters node means no slots, not an empty lineup');
}

// ---- Sleeper slot parsing ----------------------------------------------------

{
  const slots = slotsFromSleeperRosterPositions([
    'QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'SUPER_FLEX', 'K', 'DEF', 'BN', 'BN', 'IR', 'TAXI',
  ]);
  assert.deepEqual(slots, [
    { positions: ['QB'], count: 1 },
    { positions: ['RB'], count: 2 },
    { positions: ['WR'], count: 2 },
    { positions: ['TE'], count: 1 },
    { positions: ['RB', 'WR', 'TE'], count: 1 },
    { positions: ['QB', 'RB', 'WR', 'TE'], count: 1 },
  ], 'bench, reserve, taxi, K and DEF rows vanish; flexes keep their eligibility');
  assert.equal(slotsFromSleeperRosterPositions([]), null);
  assert.equal(slotsFromSleeperRosterPositions(null), null);
}

// ---- League scoring and the id-space hazard ---------------------------------

{
  // Two Josh Allens (the QB and a second body sharing the name) so the
  // byName key is a real tombstone, plus a player whose mflid happens to
  // equal a Sleeper roster id — the two hazards this block exists to pin.
  const projections = buildProjectionIndex({
    QB: [
      projPlayer('Josh Allen', 13589, { ppr: 372, half: 372, std: 372 }),
      projPlayer('Some Other Guy', 4034, { ppr: 300, half: 300, std: 300 }),
    ],
    RB: [
      projPlayer('Solo Back', 7777, { ppr: 220, half: 200, std: 180 }),
      projPlayer('Josh Allen', 55555, { ppr: 40, half: 40, std: 40 }),
    ],
  });
  const slots = [{ positions: ['QB'], count: 1 }, { positions: ['RB'], count: 1 }];

  // MFL: ids are mflids, so even the tombstoned name resolves — by id.
  const mfl = computeLeaguePower({
    franchises: [{ franchiseId: '0001', players: [{ id: '13589', name: 'Josh Allen' }, { id: '7777', name: 'Solo Back' }] }],
    slots,
    projections,
    scoring: 'HALF',
    joinById: true,
    computedAt: '2026-08-12T00:00:00Z',
  });
  assert.equal(mfl.teams[0].score, 372 + 200, 'id join works and HALF picks points_half');
  assert.equal(mfl.scoring, 'HALF');

  // Sleeper: id '4034' is a *Sleeper* id that merely looks like an mflid.
  // joinById false means it must NOT resolve to Some Other Guy — and the
  // name 'Josh Allen' is tombstoned, so this franchise scores only its RB.
  const sleeper = computeLeaguePower({
    franchises: [{ franchiseId: '4', players: [{ id: '4034', name: 'Josh Allen' }, { id: '8888', name: 'Solo Back' }] }],
    slots,
    projections,
    scoring: 'PPR',
    joinById: false,
    computedAt: '2026-08-12T00:00:00Z',
  });
  assert.equal(sleeper.teams[0].score, 220, 'a Sleeper id never joins the mflid space; a collided name credits nobody');

  // Teams come back sorted best-first whatever order the franchises arrived.
  const sorted = computeLeaguePower({
    franchises: [
      { franchiseId: '0002', players: [] },
      { franchiseId: '0001', players: [{ id: '13589', name: 'Josh Allen' }] },
    ],
    slots,
    projections,
    scoring: null,
    joinById: true,
    computedAt: null,
  });
  assert.deepEqual(sorted.teams.map((t) => t.franchiseId), ['0001', '0002']);
  assert.equal(sorted.scoring, 'PPR', 'unresolved scoring falls back to PPR, same as the ECR column');
}

{
  // The ESPN default shape is itself pinned: 1 QB, 2 RB, 2 WR, 1 TE, 1 flex.
  assert.equal(DEFAULT_POWER_SLOTS.reduce((n, s) => n + s.count, 0), 7);
  assert.deepEqual(DEFAULT_POWER_SLOTS.find((s) => s.positions.length > 1).positions, ['RB', 'WR', 'TE']);
}

// ---- The page's half of the join --------------------------------------------

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

const { powerRanksForLeague } = context;

{
	assert.equal(powerRanksForLeague({}), null, 'no power data, no column');
	assert.equal(powerRanksForLeague({ power: { teams: [] } }), null);

	const ranks = powerRanksForLeague({
		power: {
			computedAt: '2026-08-12T00:00:00Z',
			scoring: 'PPR',
			teams: [
				{ franchiseId: '0003', score: 900 },
				{ franchiseId: '0001', score: 1200 },
				{ franchiseId: '0002', score: 1200 },
				{ franchiseId: '0004', score: 800 },
			],
		},
	});
	assert.equal(ranks.get('0001').rank, 1);
	assert.equal(ranks.get('0002').rank, 1, 'equal scores share a rank');
	assert.equal(ranks.get('0003').rank, 3, 'the rank after a tie skips, standard competition style');
	assert.equal(ranks.get('0004').rank, 4);
}

console.log('test-power-rank: all assertions passed');
