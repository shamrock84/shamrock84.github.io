// Unit test for the Team Needs card — the per-position split added to the
// Power Rankings machinery in scripts/lib/fantasypros.mjs
// (computePowerScore / computeLeaguePower) and the page-side ranking and
// rendering in myffl.html (leaguePowerRanks / renderTeamNeedsCard).
//
// The card exists to answer a narrower question than Power Rankings: not
// "how good is this roster" but "which position on it is thin". It is built
// entirely from data Power Rankings already computes — the greedy lineup
// fill already knows which real position filled each slot, dedicated or
// flex, so this is a deeper read of an existing number rather than a new
// fetch or a new valuation. Everything pinned here fails silently exactly
// the way the rest of the power-rank machinery does: a wrong split still
// renders a plausible small number, and nothing on screen says RB was
// credited with a WR's points.
//
//   - a flex slot filled by a rostered RB counts as RB strength, not as an
//     untraceable "flex" bucket — the whole reason byPosition rides on the
//     same bestPos the greedy fill already resolves;
//   - a position the roster spent nothing on is 0/0, not absent — an empty
//     TE room is a real, comparable answer, so every team's byPosition
//     carries every POWER_POSITIONS key rather than only the ones it filled;
//   - the per-position rank a franchise gets is one blended number — score
//     plus depth at that position, ranked together — the same way Overall
//     already blends the whole roster's Starters and Depth, because a need
//     reads as one verdict, not two numbers to weigh by hand;
//   - the page's half of this is gated on every team in the league actually
//     carrying byPosition: a league that hasn't resynced since this shipped
//     has team entries from the old shape, and ranking four positions where
//     half the teams have none would manufacture a column that means
//     nothing — the same failure mode hasDepth already guards against for
//     the whole-roster Depth column;
//   - the card itself is absent, not a wall of TBDs, when nothing in the
//     group has byPosition yet — the same "nothing to show" treatment
//     Power Rankings gives its own bootstrap gap;
//   - and click-to-sort on every position column follows the same three
//     rules as every other analytics table: natural -> reverse -> the
//     card's own order, ties fall back to that order, and a TBD cell stays
//     at the bottom in BOTH directions.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { computePowerScore, computeLeaguePower, buildProjectionIndex } from './lib/fantasypros.mjs';

// ---- computePowerScore's per-position split ---------------------------

{
	// Same fixture shape as test-power-rank.mjs: flex listed first to prove
	// dedicated slots still fill first, one RB and two WRs so the flex takes
	// the second WR rather than stealing the RB slot's own player.
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
	const { byPosition } = computePowerScore(players, slots);
	assert.deepEqual(byPosition.RB, { score: 200, depth: 0 }, 'the one RB starts, nothing left on the bench at RB');
	// Both WRs start — one in the WR slot, one in the flex — so WR's score is
	// both of them and its depth is zero, even though one of them filled a
	// slot that isn't labeled WR.
	assert.deepEqual(byPosition.WR, { score: 180 + 150, depth: 0 }, 'a flex point earned by a WR counts as WR strength');
	assert.equal(byPosition.TE, undefined, 'no TE on the roster at all: no entry, not a zeroed one');
}

{
	// A position with real bench depth: three RBs, one slot, so two are
	// unseated and their points are RB's depth, not the team's undifferentiated
	// depth.
	const { byPosition } = computePowerScore(
		[
			{ position: 'RB', points: 150 },
			{ position: 'RB', points: 90 },
			{ position: 'RB', points: 40 },
			{ position: 'WR', points: 100 },
		],
		[{ positions: ['RB'], count: 1 }, { positions: ['WR'], count: 1 }]
	);
	assert.deepEqual(byPosition.RB, { score: 150, depth: 90 + 40 });
	assert.deepEqual(byPosition.WR, { score: 100, depth: 0 });
}

// ---- computeLeaguePower normalizes to every POWER_POSITIONS entry ------

{
	const projections = buildProjectionIndex({
		QB: [{ fpid: 1, mflid: 1, name: 'Some QB', stats: { points: 300, points_ppr: 300, points_half: 300 } }],
		RB: [{ fpid: 2, mflid: 2, name: 'Some RB', stats: { points: 200, points_ppr: 200, points_half: 200 } }],
	});
	const power = computeLeaguePower({
		franchises: [{ franchiseId: '0001', players: [{ id: '1', name: 'Some QB' }, { id: '2', name: 'Some RB' }] }],
		slots: [{ positions: ['QB'], count: 1 }, { positions: ['RB'], count: 1 }],
		values: projections,
		scoring: 'PPR',
		joinById: true,
		computedAt: '2026-08-12T00:00:00Z',
	});
	const team = power.teams[0];
	assert.deepEqual(team.byPosition.QB, { score: 300, depth: 0 });
	assert.deepEqual(team.byPosition.RB, { score: 200, depth: 0 });
	// WR and TE: nobody rostered there at all, and the whole point of
	// normalizing is that this reads as a real, comparable 0/0 rather than a
	// missing key the page would have to special-case.
	assert.deepEqual(team.byPosition.WR, { score: 0, depth: 0 });
	assert.deepEqual(team.byPosition.TE, { score: 0, depth: 0 });
}

// ---- The page's half: leaguePowerRanks' per-position ranking -----------

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

const { leaguePowerRanks, computeMyPowerRows } = context;

{
	// Three franchises, projections basis, every team carrying byPosition.
	// Franchise 3 is deliberately the best team overall but the weakest at
	// RB, which is the exact shape Team Needs exists to surface.
	const byPos = (rb, wr) => ({
		QB: { score: 10, depth: 0 },
		RB: { score: rb, depth: 0 },
		WR: { score: wr, depth: 0 },
		TE: { score: 10, depth: 0 },
	});
	const twoBasis = {
		power: {
			projections: {
				source: { basis: 'projections' },
				teams: [
					{ franchiseId: '0001', score: 100, depth: 0, byPosition: byPos(50, 50) },
					{ franchiseId: '0002', score: 120, depth: 0, byPosition: byPos(80, 20) },
					{ franchiseId: '0003', score: 150, depth: 0, byPosition: byPos(5, 200) },
				],
			},
		},
	};
	const ranks = leaguePowerRanks(twoBasis, 'projections');
	assert.notEqual(ranks, null);
	// Franchise 3 leads overall (highest score) but is worst at RB.
	assert.equal(ranks.byFranchise.get('0003').overall, 1);
	assert.equal(ranks.byFranchise.get('0003').byPosition.RB, 3, 'weakest RB in the league despite the best roster');
	assert.equal(ranks.byFranchise.get('0003').byPosition.WR, 1, 'and the strongest WR room');
	// Franchise 1 is the RB/WR middle-of-the-road team.
	assert.equal(ranks.byFranchise.get('0001').byPosition.RB, 2);
	assert.equal(ranks.byFranchise.get('0001').byPosition.WR, 2);
	// QB and TE are tied across all three franchises, so every franchise
	// shares rank 1 there.
	assert.equal(ranks.byFranchise.get('0001').byPosition.QB, 1);
	assert.equal(ranks.byFranchise.get('0002').byPosition.QB, 1);
	assert.equal(ranks.byFranchise.get('0003').byPosition.QB, 1);
}

{
	// A team without depth data poisons the whole-roster Depth column
	// already (see test-power-rank.mjs); byPosition is gated the same way,
	// but independently — a league with real byPosition on every team but a
	// hole in one team's plain depth must still rank positions.
	const ranks = leaguePowerRanks({
		power: { projections: { teams: [
			{ franchiseId: '0001', score: 100, byPosition: { QB: { score: 10, depth: 0 }, RB: { score: 10, depth: 0 }, WR: { score: 10, depth: 0 }, TE: { score: 10, depth: 0 } } },
			{ franchiseId: '0002', score: 120, byPosition: { QB: { score: 20, depth: 0 }, RB: { score: 20, depth: 0 }, WR: { score: 20, depth: 0 }, TE: { score: 20, depth: 0 } } },
		] } },
	}, 'projections');
	assert.equal(ranks.byFranchise.get('0001').depth, null, 'whole-roster depth is still missing');
	assert.equal(ranks.byFranchise.get('0002').byPosition.QB, 1, 'but position ranking does not depend on it');
}

{
	// The half-upgraded-league guard: one team on the new shape, one still
	// on an older power object with no byPosition at all. Ranking four
	// positions off half real data would manufacture a column that means
	// nothing, so the whole league's byPosition comes back null instead —
	// mirroring hasDepth's existing "half a league on an older power object
	// must not be ranked" rule.
	const ranks = leaguePowerRanks({
		power: { projections: { teams: [
			{ franchiseId: '0001', score: 100, byPosition: { QB: { score: 10, depth: 0 }, RB: { score: 10, depth: 0 }, WR: { score: 10, depth: 0 }, TE: { score: 10, depth: 0 } } },
			{ franchiseId: '0002', score: 120 },
		] } },
	}, 'projections');
	assert.notEqual(ranks, null, 'the league still ranks overall');
	assert.equal(ranks.byFranchise.get('0001').byPosition, null, 'but position ranks are withheld for the whole league');
	assert.equal(ranks.byFranchise.get('0002').byPosition, null);
}

{
	// No power data at all: leaguePowerRanks' usual empty-input contract,
	// unaffected by any of the above.
	assert.equal(leaguePowerRanks({}, 'projections'), null);
	assert.equal(leaguePowerRanks({ power: { projections: { teams: [] } } }, 'projections'), null);
}

// ---- computeMyPowerRows carries byPosition through untouched -----------

{
	// The row-builder was not changed for this feature — proj/ecr are copied
	// wholesale from leaguePowerRanks' byFranchise entries, so byPosition
	// should simply ride along. This is the property that lets the render
	// side reuse computeMyPowerRows outright rather than a parallel
	// row-builder.
	const byPos = { QB: { score: 1, depth: 0 }, RB: { score: 1, depth: 0 }, WR: { score: 1, depth: 0 }, TE: { score: 1, depth: 0 } };
	const leagues = [{
		id: 'A', name: 'League A', type: 'dynasty', season: '2026', franchiseId: '1',
		power: { projections: { source: { basis: 'projections' }, teams: [
			{ franchiseId: '1', score: 100, depth: 10, byPosition: byPos },
			{ franchiseId: '2', score: 50, depth: 5, byPosition: byPos },
		] }, ecr: null },
	}];
	const rows = computeMyPowerRows(leagues, ['dynasty'], 2026);
	assert.notEqual(rows[0].proj.byPosition, null);
	assert.deepEqual({ ...rows[0].proj.byPosition }, { QB: 1, RB: 1, WR: 1, TE: 1 }, 'a tie across two identical teams shares rank 1 everywhere');
}

// ---- The card ------------------------------------------------------------

function domNode(tag = 'div') {
	const n = {
		tag, children: [], attrs: {}, cls: '', _text: '', dataset: {}, style: {}, listeners: {},
		classList: {
			add(c) { n.cls += ' ' + c; }, remove() {}, toggle() {}, contains: (c) => n.cls.includes(c),
		},
		addEventListener(type, fn) { (n.listeners[type] = n.listeners[type] || []).push(fn); },
		removeEventListener() {},
		setAttribute(k, v) { n.attrs[k] = v; },
		focus() {}, remove() {},
		appendChild(c) { n.children.push(c); return c; },
		insertBefore(c) { n.children.push(c); return c; },
		querySelector: () => null, querySelectorAll: () => [], closest: () => null,
		get className() { return n.cls; },
		set className(v) { n.cls = v; },
		get innerHTML() { return ''; },
		set innerHTML(v) { if (v === '') n.children.length = 0; },
		get textContent() { return n._text; },
		set textContent(v) { n._text = v; },
		click() { (n.listeners.click || []).forEach((fn) => fn()); },
	};
	return n;
}

const domCtx = {
	console,
	localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
	setTimeout, clearTimeout, setInterval, clearInterval,
	document: {
		addEventListener() {},
		getElementById: () => domNode(),
		createElement: (t) => domNode(t),
		createTextNode: (t) => { const n = domNode('#text'); n.textContent = t; return n; },
		querySelector: () => null,
		querySelectorAll: () => [],
		visibilityState: 'visible',
		body: domNode(),
	},
	window: { addEventListener() {} },
	fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
};
vm.createContext(domCtx);
vm.runInContext(scriptSource, domCtx);

function findAll(n, pred, out = []) {
	if (!n || !n.children) return out;
	for (const c of n.children) {
		if (pred(c)) out.push(c);
		findAll(c, pred, out);
	}
	return out;
}
const thNamed = (card, label) => findAll(card, (c) => c.tag === 'th').find((h) => h._text === label);
const clickTh = (card, label) => thNamed(card, label).click();
const labelsOf = (card) =>
	findAll(card, (c) => c.tag === 'tr')
		.filter((tr) => tr.children.some((c) => c.tag === 'td'))
		.map((tr) => tr.children[0]._text);

{
	// A group with no byPosition data anywhere: the card is absent entirely,
	// not a wall of TBDs — the same "nothing to show yet" treatment Power
	// Rankings gives its own bootstrap gap.
	const leagues = [{
		id: 'A', name: 'League A', type: 'dynasty', season: '2026', franchiseId: '1',
		power: { projections: { source: { basis: 'projections' }, teams: [
			{ franchiseId: '1', score: 100, depth: 10 },
			{ franchiseId: '2', score: 50, depth: 5 },
		] }, ecr: null },
	}];
	assert.equal(domCtx.renderTeamNeedsCard('dynasty', ['dynasty'], leagues, 2026), null);
}

{
	const byPos = (qb, rb, wr, te) => ({
		QB: { score: qb, depth: 0 }, RB: { score: rb, depth: 0 }, WR: { score: wr, depth: 0 }, TE: { score: te, depth: 0 },
	});
	const mkLeague = (id, name, myByPos, others) => ({
		id, name, type: 'dynasty', season: '2026', franchiseId: '1',
		power: {
			projections: {
				source: { basis: 'projections' },
				teams: [
					{ franchiseId: '1', score: 100, depth: 10, byPosition: myByPos },
					...others.map((o, i) => ({ franchiseId: `x${i}`, score: o.score, depth: 0, byPosition: o.byPosition })),
				],
			},
			ecr: null,
		},
	});

	const leagues = [
		// Alpha: weakest at RB (a real, sortable spread across positions).
		mkLeague('A', 'Alpha', byPos(10, 5, 10, 10), [{ score: 50, byPosition: byPos(10, 50, 10, 10) }]),
		// Bravo: only one other franchise, so QB/RB/WR/TE are all ties at
		// rank 1 for our team — no single weakest position to highlight.
		mkLeague('B', 'Bravo', byPos(10, 10, 10, 10), [{ score: 5, byPosition: byPos(1, 1, 1, 1) }]),
		// Charlie: fully unranked (no power object at all), proving the
		// row's own reason drives the TBD tooltip rather than a crash.
		{ id: 'C', name: 'Charlie', type: 'dynasty', season: '2026', franchiseId: '1', players: [] },
	];

	const card = domCtx.renderTeamNeedsCard('dynasty', ['dynasty'], leagues, 2026);
	assert.notEqual(card, null);

	for (const label of ['League', 'QB', 'RB', 'WR', 'TE']) {
		const th = thNamed(card, label);
		assert.ok(th, `${label} header exists`);
		assert.ok(th.cls.includes('sortable'), `${label} is sortable`);
	}

	const rowOf = (label) => findAll(card, (c) => c.tag === 'tr')
		.filter((tr) => tr.children.some((c) => c.tag === 'td'))
		.find((tr) => tr.children[0]._text === label);
	const cellsOf = (label) => rowOf(label).children.slice(1);

	// Alpha: RB is 2nd (worse) of the two franchises, everything else is 1st
	// — RB is the lone worst cell and gets the highlight class.
	const alphaCells = cellsOf('Alpha');
	assert.deepEqual(alphaCells.map((c) => c._text), ['1', '2', '1', '1']);
	assert.ok(alphaCells[1].cls.includes('needs-weakest'), 'RB is Alpha\'s weakest position');
	assert.ok(!alphaCells[0].cls.includes('needs-weakest'), 'QB is not flagged');

	// Bravo: our team ties for 1st at every position against the one other
	// franchise, so there is no single worst cell to flag.
	const bravoCells = cellsOf('Bravo');
	assert.deepEqual(bravoCells.map((c) => c._text), ['1', '1', '1', '1']);
	assert.ok(bravoCells.every((c) => !c.cls.includes('needs-weakest')), 'an all-tied row highlights nothing');

	// Charlie: fully unranked, so every position cell is TBD and carries the
	// row's own reason as its tooltip rather than a generic per-column one.
	const charlieCells = cellsOf('Charlie');
	assert.ok(charlieCells.every((c) => c.cls.includes('power-tbd') && c._text === 'TBD'));

	// Default order matches computeMyPowerRows' own order (the row average),
	// not a Team-Needs-specific resort — the two cards describe the same
	// leagues and should read in the same order.
	// Spread first, same reason test-power-rank.mjs does: an array built
	// inside the vm-evaluated script is a different realm's Array than one
	// built here, and [...x] re-materializes it as a plain array in this
	// realm before deepEqual compares it.
	const powerRows = [...domCtx.computeMyPowerRows(leagues, ['dynasty'], 2026)];
	const base = [...labelsOf(card)];
	assert.deepEqual(base, powerRows.map((r) => r.label));

	// Click-to-sort on a position column: natural (best-first, TBD last),
	// reverse (still TBD last — the rule that's silent when wrong), then
	// back to the card's own order.
	clickTh(card, 'RB');
	assert.deepEqual([...labelsOf(card)], ['Bravo', 'Alpha', 'Charlie'], 'RB ascending: Bravo (1) before Alpha (2), Charlie (TBD) last');
	clickTh(card, 'RB');
	assert.deepEqual([...labelsOf(card)], ['Alpha', 'Bravo', 'Charlie'], 'RB descending: Alpha (2) before Bravo (1), Charlie (TBD) STILL last');
	clickTh(card, 'RB');
	assert.deepEqual([...labelsOf(card)], base, 'third click restores the default order');
}

console.log('test-team-needs: all assertions passed');
