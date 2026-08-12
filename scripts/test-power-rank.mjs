// Unit test for the power ranks — the sync-side scoring in
// scripts/lib/fantasypros.mjs (buildProjectionIndex / computePowerScore /
// computeLeaguePower), the provider slot parsing in scripts/lib/providers.mjs
// (startingSlotCounts / slotsFromSleeperRosterPositions), and the page-side
// card logic in myffl.html (leaguePowerRanks / computeMyPowerRows).
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
//   - depth is the projected points the lineup could not seat, ranked
//     separately, and only when every team in the league carries the
//     number — half a league on an older power object must not be ranked
//     against the other half's real values;
//   - the page's Power Rankings card shows one row per league we hold a
//     team in, ordered by overall rank; ties share a rank; a redraft
//     league still on last season is excluded (same awaitingRollover gate
//     as Top Available) while a trailing dynasty league is not; a league
//     without power data contributes no row rather than a row of dashes;
//   - and the two fail-loud guards, which exist because the quiet version
//     of each is a card nobody would question: a league where no franchise
//     seated anybody computes to null (every team would otherwise tie at
//     zero and so rank first), and ranks computed from the preseason
//     projection slot *during* the season put a warning on the card — the
//     only visible symptom that case would ever produce. That check is
//     phase-and-slot rather than a freshness date because the probe found
//     the projections endpoint carries no last_updated at all, so a
//     date-based guard would never fire while looking like it worked;
//   - and the ECR fallback, which is what runs every offseason: FantasyPros
//     publishes projections per season, so from the Super Bowl until the
//     next season's list appears there is nothing to ask for, and without a
//     fallback the card would carry January's ranks through to July while
//     reporting the phase and slot it was *originally* computed under (the
//     safe-looking combination). Rank is converted to value by a log curve
//     that reaches zero at the pool edge; the index it builds is the same
//     shape as the projections one, so computeLeaguePower consumes either;
//     and both bases are computed every run and shown side by side, because
//     the two measures can order the same teams differently — a roster can
//     lead on projected points and trail on consensus rank, which is the
//     contender-versus-rebuilder signal the pair exists to show. A basis
//     that couldn't be computed renders as TBD rather than dropping the
//     league, since "not valued yet" and "not here" are different claims;
//   - and the card's order is the *mean* of the two ranks, so neither basis
//     is privileged: ordering by projections and using rankings only to
//     break ties would bury a roster consensus rates highly. A row with one
//     basis is not disadvantaged, since a single value is its own mean.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import {
  buildProjectionIndex,
  buildEcrIndex,
  ecrValue,
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
  const { score, depth, filled, slotCount } = computePowerScore(players, slots);
  assert.equal(score, 200 + 180 + 150, 'dedicated before flex, flex from best remaining');
  assert.equal(depth, 0, 'everyone seated, nothing on the bench');
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
  const { score, depth, filled, slotCount } = computePowerScore(
    [{ position: 'RB', points: 120 }, { position: 'WR', points: 95 }],
    [{ positions: ['RB'], count: 2 }, { positions: ['TE'], count: 1 }]
  );
  assert.equal(score, 120);
  assert.equal(depth, 95, 'a player no slot can seat is depth, not loss');
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
    franchises: [{ franchiseId: '0001', players: [{ id: '13589', name: 'Josh Allen' }, { id: '7777', name: 'Solo Back' }, { id: '55555', name: 'Josh Allen' }] }],
    slots,
    values: projections,
    scoring: 'HALF',
    joinById: true,
    computedAt: '2026-08-12T00:00:00Z',
  });
  assert.equal(mfl.teams[0].score, 372 + 200, 'id join works and HALF picks points_half');
  assert.equal(mfl.teams[0].depth, 40, 'the unseated RB Josh Allen is bench value, joined by id despite the tombstoned name');
  assert.equal(mfl.scoring, 'HALF');

  // Sleeper: id '4034' is a *Sleeper* id that merely looks like an mflid.
  // joinById false means it must NOT resolve to Some Other Guy — and the
  // name 'Josh Allen' is tombstoned, so this franchise scores only its RB.
  const sleeper = computeLeaguePower({
    franchises: [{ franchiseId: '4', players: [{ id: '4034', name: 'Josh Allen' }, { id: '8888', name: 'Solo Back' }] }],
    slots,
    values: projections,
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
    values: projections,
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

// ---- The ECR fallback -------------------------------------------------------

{
  // The curve: steep at the top, flat through the middle, exactly zero at
  // the pool edge, and nothing outside it.
  assert.ok(ecrValue(1, 250) > ecrValue(10, 250), 'monotone decreasing');
  assert.ok(ecrValue(10, 250) > ecrValue(100, 250));
  assert.equal(ecrValue(250, 250), 0, 'the last ranked player is worth nothing, not a floor');
  assert.equal(ecrValue(251, 250), 0, 'outside the pool is zero rather than negative');
  assert.equal(ecrValue(0, 250), 0);
  assert.equal(ecrValue(5, 0), 0);
  assert.equal(ecrValue(null, 250), 0);
  // Steeper than linear: the gap between 1 and 10 must exceed the gap
  // between 100 and 109, or a roster of filler would outscore one with stars.
  assert.ok(ecrValue(1, 250) - ecrValue(10, 250) > ecrValue(100, 250) - ecrValue(109, 250));
}

{
  // Pool entries shaped exactly as data/rosters.json stores them.
  const pool = {
    type: 'DYNASTY',
    scoring: 'PPR',
    position: 'ALL',
    players: [
      { name: "Ja'Marr Chase", position: 'WR', team: 'CIN', rank: 1 },
      { name: 'Bijan Robinson', position: 'RB', team: 'ATL', rank: 2 },
      { name: 'Some Kicker', position: 'K', team: 'BUF', rank: 3 },
      { name: 'Josh Allen', position: 'QB', team: 'BUF', rank: 4 },
      { name: 'Josh Allen', position: 'WR', team: 'JAX', rank: 5 },
    ],
  };
  const index = buildEcrIndex(pool, { season: '2027', inSeason: false });
  assert.equal(index.byMflId.size, 0, 'pool entries carry no MFL id, so the id join is empty by construction');
  assert.equal(index.byName.get('some kicker'), undefined, 'kickers never enter the valuation');
  assert.equal(index.byName.get('josh allen'), null, 'the same tombstone rule as the projections index');
  assert.ok(index.byName.get("jamarr chase").points.PPR > index.byName.get('bijan robinson').points.PPR);
  assert.equal(index.byName.get("jamarr chase").position, 'WR');
  // A pool is scoring-specific already, so one value serves all three.
  const chase = index.byName.get("jamarr chase");
  assert.equal(chase.points.PPR, chase.points.HALF);
  assert.equal(chase.points.STD, chase.points.HALF);
  assert.deepEqual({ ...index.meta }, { basis: 'ecr', season: '2027', rankingType: 'DYNASTY', scoring: 'PPR', inSeason: false });

  assert.equal(buildEcrIndex(null, {}), null, 'no pool, no fallback — the league carries forward instead');
  assert.equal(buildEcrIndex({ players: [] }, {}), null);
  assert.equal(buildEcrIndex({ players: [{ name: 'Only A Kicker', position: 'K', rank: 1 }] }, {}), null,
    'a pool with nothing startable in it is no basis at all');
}

{
  // The whole point of the shared shape: computeLeaguePower takes the ECR
  // index without knowing it is one, and an MFL league (joinById) still
  // resolves — by name, since byMflId is empty.
  const pool = {
    type: 'DYNASTY',
    scoring: 'PPR',
    players: [
      { name: 'Star Back', position: 'RB', rank: 1 },
      { name: 'Decent Back', position: 'RB', rank: 40 },
      { name: 'Deep Stash', position: 'RB', rank: 100 },
      // Sets the pool's depth: without an entry this deep, the stash above
      // would sit at the pool edge and be valued at zero. Pinning it here
      // is also what keeps buildEcrIndex measuring depth by deepest rank
      // rather than by entry count.
      { name: 'Pool Edge', position: 'WR', rank: 250 },
    ],
  };
  const values = buildEcrIndex(pool, { season: '2027', inSeason: false });
  const power = computeLeaguePower({
    franchises: [
      { franchiseId: '0001', players: [{ id: '111', name: 'Star Back' }, { id: '222', name: 'Deep Stash' }] },
      { franchiseId: '0002', players: [{ id: '333', name: 'Decent Back' }] },
    ],
    slots: [{ positions: ['RB'], count: 1 }],
    values,
    scoring: 'PPR',
    joinById: true,
    computedAt: '2027-03-01T00:00:00Z',
  });
  assert.equal(power.teams[0].franchiseId, '0001', 'the better player ranks first on the ECR basis too');
  assert.ok(power.teams[0].depth > 0, 'the unseated stash is depth, exactly as on the projections basis');
  assert.equal(power.source.basis, 'ecr', 'and the basis travels so the page can say which ruler was used');
}

// ---- The fail-loud guards ---------------------------------------------------

{
  const projections = buildProjectionIndex({
    QB: [projPlayer('Real Guy', 1111, { ppr: 300, half: 300, std: 300 })],
  });
  projections.meta = { basis: 'projections', season: '2026', week: '0', inSeason: false };
  const slots = [{ positions: ['QB'], count: 1 }];

  // Nobody in the league joins to a projection — an id space that stopped
  // lining up, or a slot shape that parsed to nothing usable. The quiet
  // version of this is every franchise scoring zero, every zero tying, and
  // the card ranking all twelve teams first.
  const broken = computeLeaguePower({
    franchises: [
      { franchiseId: '0001', players: [{ id: '9999', name: 'Nobody At All' }] },
      { franchiseId: '0002', players: [{ id: '8888', name: 'Also Nobody' }] },
    ],
    slots,
    values: projections,
    scoring: 'PPR',
    joinById: true,
    computedAt: '2026-08-12T00:00:00Z',
  });
  assert.equal(broken, null, 'no franchise seated anybody: null, so the caller keeps the previous ranks');

  // One franchise seating one player is enough to be real data — the other
  // team is genuinely empty, which is a low score rather than a broken join.
  const partial = computeLeaguePower({
    franchises: [
      { franchiseId: '0001', players: [{ id: '1111', name: 'Real Guy' }] },
      { franchiseId: '0002', players: [] },
    ],
    slots,
    values: projections,
    scoring: 'PPR',
    joinById: true,
    computedAt: '2026-08-12T00:00:00Z',
  });
  assert.notEqual(partial, null);
  assert.deepEqual({ ...partial.source }, { basis: 'projections', season: '2026', week: '0', inSeason: false },
    'provenance rides along so the page can see which basis the ranks rest on');
  assert.equal(partial.teams.length, 2);
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

const { leaguePowerRanks, computeMyPowerRows, powerUsesPreseasonProjections, powerMissingBasis, powerDetailBasis } = context;


{
	const twoBasis = {
		power: {
			projections: {
				source: { basis: 'projections', season: '2026', week: '0', inSeason: false },
				teams: [
					{ franchiseId: '0001', score: 100, depth: 50 },
					{ franchiseId: '0002', score: 120, depth: 10 },
					{ franchiseId: '0003', score: 90, depth: 70 },
				],
			},
			ecr: {
				source: { basis: 'ecr', season: '2026', rankingType: 'DYNASTY', scoring: 'PPR', inSeason: false },
				teams: [
					// Deliberately a different ordering from projections: the
					// win-now roster (0002) is the worst dynasty asset base.
					{ franchiseId: '0001', score: 10, depth: 5 },
					{ franchiseId: '0002', score: 4, depth: 1 },
					{ franchiseId: '0003', score: 12, depth: 9 },
				],
			},
		},
	};

	assert.equal(leaguePowerRanks({}, 'projections'), null, 'no power data, no ranks');
	assert.equal(leaguePowerRanks({ power: {} }, 'projections'), null);
	assert.equal(leaguePowerRanks({ power: { projections: { teams: [] } } }, 'projections'), null);

	const proj = leaguePowerRanks(twoBasis, 'projections');
	assert.equal(proj.size, 3);
	assert.deepEqual({ ...proj.byFranchise.get('0003') }, { overall: 1, starters: 3, depth: 1 }, 'a farm system: best roster, worst lineup');
	assert.deepEqual({ ...proj.byFranchise.get('0002') }, { overall: 3, starters: 1, depth: 3 }, 'a contender with no bench');
	assert.equal(proj.source.basis, 'projections');

	// The same franchises ranked independently on the other basis — the whole
	// reason both are shown.
	const ecr = leaguePowerRanks(twoBasis, 'ecr');
	assert.equal(ecr.byFranchise.get('0002').overall, 3);
	assert.equal(ecr.byFranchise.get('0003').overall, 1);
	assert.equal(ecr.source.basis, 'ecr');

	// One basis missing entirely is not the league missing.
	const projOnly = { power: { projections: twoBasis.power.projections, ecr: null } };
	assert.notEqual(leaguePowerRanks(projOnly, 'projections'), null);
	assert.equal(leaguePowerRanks(projOnly, 'ecr'), null);

	// One team without depth poisons the depth ranking for that basis only —
	// overall falls back to the starters ordering rather than ranking real
	// numbers against a missing one.
	const partial = leaguePowerRanks({
		power: { projections: { teams: [
			{ franchiseId: '0001', score: 100, depth: 50 },
			{ franchiseId: '0002', score: 120 },
		] } },
	}, 'projections');
	assert.equal(partial.byFranchise.get('0001').depth, null);
	assert.equal(partial.byFranchise.get('0002').overall, 1, 'overall degrades to starters when depth is unrankable');

	// Ties share a rank, and the next rank skips.
	const tied = leaguePowerRanks({
		power: { projections: { teams: [
			{ franchiseId: 'a', score: 100, depth: 0 },
			{ franchiseId: 'b', score: 100, depth: 0 },
			{ franchiseId: 'c', score: 90, depth: 0 },
		] } },
	}, 'projections');
	assert.equal(tied.byFranchise.get('a').overall, 1);
	assert.equal(tied.byFranchise.get('b').overall, 1);
	assert.equal(tied.byFranchise.get('c').overall, 3);
}

{
	const basis = (teams, source) => ({ source, teams });
	const projSource = { basis: 'projections', season: '2026', week: '0', inSeason: false };
	const ecrSource = { basis: 'ecr', season: '2026', rankingType: 'DYNASTY', scoring: 'PPR', inSeason: false };
	const both = (mine, other) => ({
		projections: basis([
			{ franchiseId: '1', score: mine[0], depth: mine[1] },
			{ franchiseId: '2', score: other[0], depth: other[1] },
		], projSource),
		ecr: basis([
			{ franchiseId: '1', score: mine[2], depth: mine[3] },
			{ franchiseId: '2', score: other[2], depth: other[3] },
		], ecrSource),
	});

	const leagues = [
		// Current-season dynasty league: leads projections, trails ECR.
		{ id: 'A', name: 'League A', type: 'dynasty', season: '2026', franchiseId: '1',
			power: both([200, 20, 1, 1], [100, 10, 9, 9]) },
		// Redraft league still on last season: excluded however good the rank.
		{ id: 'B', name: 'League B', type: 'redraft', season: '2025', franchiseId: '1',
			power: both([999, 999, 999, 999], [1, 1, 1, 1]) },
		// Dynasty league still on last season: rosters carry over, so it stays.
		{ id: 'C', name: 'League C', type: 'dynasty', season: '2025', franchiseId: '1',
			power: both([300, 30, 30, 30], [1, 1, 1, 1]) },
		// No power data at all: no row.
		{ id: 'D', name: 'League D', type: 'dynasty', season: '2026', franchiseId: '1' },
		// Projections only — the in-season shape if rankings ever fail.
		{ id: 'E', name: 'League E', type: 'dynasty', season: '2026', franchiseId: '1',
			power: { projections: basis([{ franchiseId: '1', score: 50, depth: 5 }, { franchiseId: '2', score: 60, depth: 6 }], projSource), ecr: null } },
		// Wrong group: filtered by types before anything else.
		{ id: 'F', name: 'League F', type: 'draftonly', season: '2026', franchiseId: '1',
			power: both([1, 1, 1, 1], [2, 2, 2, 2]) },
	];
	const rows = computeMyPowerRows(leagues, ['dynasty', 'redraft'], 2026);
	assert.deepEqual([...rows].map((r) => r.label), ['League C', 'League A', 'League E'],
		'ordered by projections; the trailing redraft league is gone, the trailing dynasty league is not');

	// A league keeps both bases, and they can disagree — that gap is the point.
	const a = rows.find((r) => r.label === 'League A');
	assert.equal(a.proj.overall, 1, 'best projected roster in its league');
	assert.equal(a.ecr.overall, 2, 'and the worse consensus asset base');
	assert.equal(a.size, 2);
	assert.equal(a.projSource.basis, 'projections');
	assert.equal(a.ecrSource.basis, 'ecr');

	// A league with only one basis still gets a row; the other side is null,
	// which is what the card renders as TBD.
	const e = rows.find((r) => r.label === 'League E');
	assert.notEqual(e.proj, null);
	assert.equal(e.ecr, null);
	assert.equal(e.ecrSource, null);
}

{
	// Ordering is the mean of the two ranks, which is the whole reason it
	// isn't just the projections column: a roster that leads projections and
	// trails consensus badly must not outrank one that is solid on both.
	const src = { proj: { basis: 'projections' }, ecr: { basis: 'ecr' } };
	const league = (id, projRank, ecrRank, size = 10) => {
		// A franchise list where ours lands on the requested rank in each
		// basis: score descends by position, ours slotted at want-1.
		const teams = (want) => {
			const out = [];
			for (let i = 0; i < size; i++) {
				const rank = i < want - 1 ? i : i + 1;
				if (i !== want - 1) out.push({ franchiseId: `x${i}`, score: 1000 - rank * 10, depth: 0 });
			}
			out.push({ franchiseId: '1', score: 1000 - (want - 1) * 10, depth: 0 });
			return out;
		};
		return {
			id, name: id, type: 'dynasty', season: '2026', franchiseId: '1',
			power: {
				projections: projRank == null ? null : { source: src.proj, teams: teams(projRank) },
				ecr: ecrRank == null ? null : { source: src.ecr, teams: teams(ecrRank) },
			},
		};
	};

	const rows = computeMyPowerRows([
		league('lopsided', 1, 9),   // mean 5.0 — best projected, nearly worst by consensus
		league('solid', 3, 3),      // mean 3.0
		league('consensus', 8, 2),  // mean 5.0, tie with lopsided
		league('projOnly', 4, null),// mean 4.0 — a single value is its own mean
	], ['dynasty'], 2026);

	assert.deepEqual([...rows].map((r) => r.label), ['solid', 'projOnly', 'lopsided', 'consensus'],
		'ordered by mean rank, not by the projections column');
	// The tie at 5.0 breaks on the projections rank, the more concrete of the
	// two measures — 1 beats 8, so lopsided precedes consensus above.
	assert.equal(rows[2].proj.overall, 1);
	assert.equal(rows[3].proj.overall, 8);
	// And the single-basis row sits on its own rank rather than being pushed
	// to either end for having only one number.
	assert.equal(rows[1].label, 'projOnly');
	assert.equal(rows[1].ecr, null);
}

// ---- What the card says about its bases -------------------------------------

{
	const projRow = (projSource, proj = { overall: 1, starters: 1, depth: 1 }) => ({ proj, projSource, ecr: null, ecrSource: null });
	const ecrRow = (ecr = { overall: 1, starters: 1, depth: 1 }) => ({ proj: null, projSource: null, ecr, ecrSource: { basis: 'ecr' } });
	const bothRow = { proj: { overall: 1 }, projSource: { basis: 'projections', week: '5', inSeason: true }, ecr: { overall: 2 }, ecrSource: { basis: 'ecr' } };

	// The preseason-slot warning fires on the projections side only, and only
	// for the one dangerous combination.
	assert.equal(powerUsesPreseasonProjections([]), false, 'nothing to judge');
	assert.equal(powerUsesPreseasonProjections([projRow(null)]), false,
		'a power object from before provenance was recorded says nothing rather than crying wolf');
	assert.equal(powerUsesPreseasonProjections([projRow({ week: '0', inSeason: false })]), false, 'preseason ranks in the preseason are fine');
	assert.equal(powerUsesPreseasonProjections([bothRow]), false, 'an in-season slot in season is fine');
	assert.equal(powerUsesPreseasonProjections([projRow({ week: '0', inSeason: true })]), true, 'the season is under way on the preseason slot');
	assert.equal(powerUsesPreseasonProjections([projRow({ week: 0, inSeason: true })]), true, 'week arrives as a number from some snapshots');
	assert.equal(powerUsesPreseasonProjections([ecrRow()]), false,
		'an ECR-only row has no projection slot to be frozen on');

	// Which side is missing decides which explanation the card prints.
	assert.deepEqual({ ...powerMissingBasis([ecrRow()]) }, { projections: true, ecr: false }, 'the offseason shape');
	assert.deepEqual({ ...powerMissingBasis([projRow({ week: '0', inSeason: false })]) }, { projections: false, ecr: true });
	assert.deepEqual({ ...powerMissingBasis([bothRow]) }, { projections: false, ecr: false }, 'nothing to explain');
	assert.deepEqual({ ...powerMissingBasis([]) }, { projections: false, ecr: false });

	// Starters and Depth follow projections when the card has any, and the
	// rankings otherwise — card-wide, so two rows never describe different
	// things under the same header.
	assert.equal(powerDetailBasis([bothRow]), 'projections');
	assert.equal(powerDetailBasis([ecrRow()]), 'ecr');
	assert.equal(powerDetailBasis([ecrRow(), bothRow]), 'projections', 'one row with projections is enough to fix the column');
	assert.equal(powerDetailBasis([]), 'ecr');
}

console.log('test-power-rank: all assertions passed');
