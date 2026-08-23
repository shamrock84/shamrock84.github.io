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
//   - a "need" is any position ranked below the league's own average —
//     worse than half the field (rank 6+ of 10, 7+ of 12, 8+ of 14) —
//     rather than only whichever single position happens to be worst, so a
//     team weak at two positions at once gets both flagged instead of an
//     arbitrary pick or nothing at all for lack of one unique worst;
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

const { leaguePowerRanks, computeMyPowerRows, rosterPlayersByPosition } = context;

// ---- rosterPlayersByPosition: the roster grouped for the sub-line ------

{
	const players = [
		{ name: 'A QB', position: 'QB' },
		{ name: 'A RB', position: 'RB' },
		{ name: 'Another RB', position: 'RB' },
		{ name: 'A Kicker', position: 'PK' },
		{ name: 'A Defense', position: 'Def' },
	];
	// Spread first, same reason as elsewhere in this file: an array built
	// inside the vm-evaluated script is a different realm's Array than one
	// built here, and [...x] re-materializes it as a plain array before
	// deepEqual compares it.
	const grouped = rosterPlayersByPosition(players);
	assert.deepEqual([...grouped.QB].map((p) => p.name), ['A QB']);
	assert.deepEqual([...grouped.RB].map((p) => p.name), ['A RB', 'Another RB']);
	assert.deepEqual([...grouped.WR], [], 'a position with nobody on the roster is an empty group, not a missing key');
	assert.deepEqual([...grouped.TE], []);
	// Kicker/defense never enter any group: they're not one of the four
	// POWER_POSITIONS keys this builds.
	assert.deepEqual(Object.keys(grouped).sort(), ['QB', 'RB', 'TE', 'WR']);
	const empty = rosterPlayersByPosition(undefined);
	assert.deepEqual(
		{ QB: [...empty.QB], RB: [...empty.RB], WR: [...empty.WR], TE: [...empty.TE] },
		{ QB: [], RB: [], WR: [], TE: [] },
		'no roster at all is four empty groups, not a crash'
	);
}

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
	assert.equal(ranks.byFranchise.get('0003').byPosition.RB.overall, 3, 'weakest RB in the league despite the best roster');
	assert.equal(ranks.byFranchise.get('0003').byPosition.WR.overall, 1, 'and the strongest WR room');
	// Franchise 1 is the RB/WR middle-of-the-road team.
	assert.equal(ranks.byFranchise.get('0001').byPosition.RB.overall, 2);
	assert.equal(ranks.byFranchise.get('0001').byPosition.WR.overall, 2);
	// QB and TE are tied across all three franchises, so every franchise
	// shares rank 1 there.
	assert.equal(ranks.byFranchise.get('0001').byPosition.QB.overall, 1);
	assert.equal(ranks.byFranchise.get('0002').byPosition.QB.overall, 1);
	assert.equal(ranks.byFranchise.get('0003').byPosition.QB.overall, 1);

	// Each position carries the same three-way split the whole roster does
	// (overall/starters/depth) — not just the blended number. Every
	// fixture here has depth: 0 at every position, so starters and overall
	// coincide, but the fields must exist independently: this is what the
	// per-position popover reads.
	// Spread first, same reason as elsewhere in this file: an object built
	// inside the vm-evaluated script is a different realm's object than one
	// built here, and {...x} re-materializes it as a plain object before
	// deepEqual compares it.
	const f3rb = { ...ranks.byFranchise.get('0003').byPosition.RB };
	assert.deepEqual(f3rb, { overall: 3, starters: 3, depth: 1 }, 'starters and overall agree when depth is uniformly zero, and depth ranks the uniform zeros as a three-way tie');
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
	assert.equal(ranks.byFranchise.get('0002').byPosition.QB.overall, 1, 'but position ranking does not depend on it');
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
	const tied = { overall: 1, starters: 1, depth: 1 };
	assert.deepEqual(
		{
			QB: { ...rows[0].proj.byPosition.QB },
			RB: { ...rows[0].proj.byPosition.RB },
			WR: { ...rows[0].proj.byPosition.WR },
			TE: { ...rows[0].proj.byPosition.TE },
		},
		{ QB: tied, RB: tied, WR: tied, TE: tied },
		'a tie across two identical teams shares rank 1 everywhere, on all three of overall/starters/depth'
	);
}

// ---- The card ------------------------------------------------------------

function domNode(tag = 'div') {
	const n = {
		tag, children: [], attrs: {}, cls: '', _text: '', dataset: {}, style: {}, listeners: {},
		// A real token set, not the substring-matching placeholder this used
		// to be: the popover's open/close toggling depends on `remove`
		// actually removing 'hidden' rather than silently no-op'ing.
		classList: {
			add(c) { const t = n.cls.trim().split(/\s+/).filter(Boolean); if (!t.includes(c)) n.cls = [...t, c].join(' '); },
			remove(c) { n.cls = n.cls.trim().split(/\s+/).filter((x) => x && x !== c).join(' '); },
			toggle(c) { n.cls.trim().split(/\s+/).includes(c) ? this.remove(c) : this.add(c); },
			contains: (c) => n.cls.trim().split(/\s+/).includes(c),
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
		// Zeroed rect/offsets — the popover's own positioning math runs
		// against these, but this suite checks that it opens with the right
		// content, not where it lands on a real screen.
		getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
		offsetWidth: 0,
		offsetHeight: 0,
		// A real click event always carries a stopPropagation a handler can
		// call without checking; production code (see the Team Needs rank
		// buttons) relies on that exactly like a browser would.
		click() { (n.listeners.click || []).forEach((fn) => fn({ stopPropagation() {} })); },
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
	window: { addEventListener() {}, innerWidth: 1024 },
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
// The domNode stub tracks a node's own `_text` (set via el()'s `text` attr)
// and its appended `children` as two independent things, unlike a real DOM
// where setting textContent replaces children — every call site here only
// ever uses one or the other on a given node, so concatenating both
// reconstructs the visible text either way.
function fullText(node) {
	if (!node) return '';
	if (!node.children || node.children.length === 0) return node._text || '';
	return (node._text || '') + node.children.map(fullText).join('');
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
	const mkLeague = (id, name, myByPos, others, players) => ({
		id, name, type: 'dynasty', season: '2026', franchiseId: '1',
		players,
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
		// The roster carries four RBs — one ranked and active (top-50), one
		// unranked and active, one ranked outside the top 50 but on the
		// taxi squad, and one ranked INSIDE the top 50 while also on the
		// taxi squad (the promote-flag conflict case) — plus a QB, so the
		// sub-line's position filter, its best-first-with-unranked-last
		// sort, and every combination of the top-50/taxi coloring have
		// something to prove in one fixture.
		mkLeague('A', 'Alpha', byPos(10, 5, 10, 10), [{ score: 50, byPosition: byPos(10, 50, 10, 10) }], [
			{ name: 'Deep Stash', position: 'RB', team: 'KC' },
			{ name: 'Starting Back', position: 'RB', team: 'SF', ecr: { rank: 34 } },
			{ name: 'Taxi Prospect', position: 'RB', team: 'DEN', status: 'TAXI_SQUAD', ecr: { rank: 60 } },
			{ name: 'Taxi Star', position: 'RB', team: 'MIA', status: 'TAXI_SQUAD', ecr: { rank: 20 } },
			{ name: 'Some QB', position: 'QB', team: 'BUF', ecr: { rank: 5 } },
		]),
		// Bravo: 1st of two at every position for our team — nowhere near the
		// below-average threshold, so nothing is flagged. It still carries a
		// full roster, proving the sub-line is gated on the flag and not
		// merely on having players to show.
		mkLeague('B', 'Bravo', byPos(10, 10, 10, 10), [{ score: 5, byPosition: byPos(1, 1, 1, 1) }], [
			{ name: 'Bravo RB', position: 'RB', team: 'DAL', ecr: { rank: 12 } },
		]),
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
	assert.deepEqual(alphaCells.map((c) => fullText(c)), ['1', '2', '1', '1']);
	assert.ok(alphaCells[1].cls.includes('needs-weakest'), 'RB is Alpha\'s weakest position');
	assert.ok(!alphaCells[0].cls.includes('needs-weakest'), 'QB is not flagged');

	// Bravo: our team ties for 1st at every position against the one other
	// franchise, so there is no single worst cell to flag.
	const bravoCells = cellsOf('Bravo');
	assert.deepEqual(bravoCells.map((c) => fullText(c)), ['1', '1', '1', '1']);
	assert.ok(bravoCells.every((c) => !c.cls.includes('needs-weakest')), 'an all-tied row highlights nothing');

	// The roster sub-line lives under the league name — same slot and
	// styling as Studs/Sleepers — not in the weakest cell itself, so every
	// position column stays a plain, aligned number. Alpha's weakest
	// position is RB, so the name cell gets one "RB ..." line naming the
	// roster's own RBs, best ECR first, the unranked one last with an em
	// dash. Alpha's QB is rostered and ranked too, but QB isn't the weakest
	// position, so it never gets a line of its own.
	const nameCellOf = (label) => rowOf(label).children[0];
	const findRoster = (cell) => findAll(cell, (c) => c.cls.includes('power-players'))[0];
	const alphaRoster = findRoster(nameCellOf('Alpha'));
	assert.ok(alphaRoster, "Alpha's name cell carries the weakest-position roster line");
	assert.equal(fullText(alphaRoster),
		'RB Taxi Star MIA (20), Starting Back SF (34), Taxi Prospect DEN (60), Deep Stash KC (—)');
	assert.equal(alphaCells.every((c) => !findRoster(c)), true, 'no position cell carries a sub-line — only the name cell does');

	// Each player's own name carries its own color now — not the whole
	// line the way it used to (see .needs-players in myffl.html): a
	// top-50 name goes purple, a taxi-squad name goes gold regardless of
	// rank, and a name with neither is left plain, matching the line's
	// four real combinations across this one fixture.
	const alphaEntries = alphaRoster.children.filter((c) => c.tag === 'span' && !c.cls.includes('power-players-label'));
	assert.equal(alphaEntries.length, 4);
	const [taxiStar, startingBack, taxiProspect, deepStash] = alphaEntries;
	// The rank number rides in its own inner span (after the team-suffix
	// span appendTeamSuffix adds), so its own color can differ from the
	// name's — only true for the promote-flag conflict case below.
	const rankSpanOf = (entry) => entry.children[entry.children.length - 1];

	assert.ok(fullText(taxiStar).startsWith('Taxi Star'), 'sorted best-rank-first: rank 20 leads');
	assert.ok(taxiStar.cls.includes('needs-players-taxi'), 'taxi-squad wins the name color even though rank 20 also clears the top-50 threshold');
	assert.ok(!taxiStar.cls.includes('needs-players-top'), 'the two classes are mutually exclusive on one name');
	assert.ok(rankSpanOf(taxiStar).cls.includes('needs-players-promote'),
		'top-50 AND taxi-squad: the rank number flags "maybe promote him"');

	assert.ok(fullText(startingBack).startsWith('Starting Back'));
	assert.ok(startingBack.cls.includes('needs-players-top'), 'rank 34, not taxi — purple name');
	assert.ok(!startingBack.cls.includes('needs-players-taxi'));
	assert.equal(rankSpanOf(startingBack).cls, '', 'no promote flag without a taxi-squad conflict');

	assert.ok(fullText(taxiProspect).startsWith('Taxi Prospect'));
	assert.ok(taxiProspect.cls.includes('needs-players-taxi'), 'taxi-squad — gold name even though rank 60 misses the top-50 threshold');
	assert.ok(!taxiProspect.cls.includes('needs-players-top'));
	assert.equal(rankSpanOf(taxiProspect).cls, '', 'no promote flag without also clearing the top-50 threshold');

	assert.ok(fullText(deepStash).startsWith('Deep Stash'));
	assert.equal(deepStash.cls, '', 'unranked and not taxi — plain default color, no purple and no gold');
	assert.equal(rankSpanOf(deepStash).cls, '');

	// Bravo has a real RB on its roster, but leads at every position (a
	// 2-team league, rank 1 of 2, nowhere near the below-average
	// threshold), so no sub-line renders anywhere — gated on the flag, not
	// merely on having a roster to show.
	assert.equal(findRoster(nameCellOf('Bravo')), undefined, 'a row with nothing flagged shows no roster sub-line even under its name');

	// Charlie: fully unranked, so every position cell is TBD and carries the
	// row's own reason as its tooltip rather than a generic per-column one.
	const charlieCells = cellsOf('Charlie');
	assert.ok(charlieCells.every((c) => c.cls.includes('power-tbd') && fullText(c) === 'TBD'));

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

// ---- The below-average threshold, and multiple needs at once ---------------
//
// "Need" was originally "whichever position happens to be worst, if there's
// a unique one" — the Alpha/Bravo fixtures above still exercise that shape
// coincidentally (a 2-team league only has one non-trivial threshold). The
// real rule is a franchise-independent line: any position ranked below the
// league's own average, i.e. worse than half the field. A team can clear
// zero, one, or several positions at once — this pins the exact boundary
// (rank 5 of 10 is fine, rank 6 is not) and the multi-flag case a real
// league surfaced (Game On, dead last at both WR and TE at once — neither
// is "the" worst, both are real needs).
// Builds a `size`-team league where my franchise lands at exactly the
// requested rank at each position, independently, with no ties: my value is
// (size - rank + 1), and the other `size - 1` teams take every other
// integer 1..size at that position, so competitionRanks has nothing left to
// tie-break. Shared by the below-average tests and the fallback-tier tests
// below.
function leagueAtRanks(id, name, size, ranks, players) {
	const positions = ['QB', 'RB', 'WR', 'TE'];
	const myByPosition = {};
	for (const pos of positions) myByPosition[pos] = { score: size - ranks[pos] + 1, depth: 0 };
	const others = [];
	for (let i = 0; i < size - 1; i++) {
		const byPosition = {};
		for (const pos of positions) {
			const mine = size - ranks[pos] + 1;
			const remaining = [];
			for (let v = size; v >= 1; v--) if (v !== mine) remaining.push(v);
			byPosition[pos] = { score: remaining[i], depth: 0 };
		}
		others.push({ franchiseId: `x${i}`, score: 0, depth: 0, byPosition });
	}
	return {
		id, name, type: 'dynasty', season: '2026', franchiseId: '1',
		players,
		power: { projections: { source: { basis: 'projections' }, teams: [
			{ franchiseId: '1', score: 100, depth: 10, byPosition: myByPosition },
			...others,
		] }, ecr: null },
	};
}

{
	// 10 teams, threshold 5: QB sits exactly on the line (not a need), RB
	// is one worse (a need), WR is deep in the bottom (also a need, at the
	// same time as RB), TE leads the league (nowhere close).
	const echo = leagueAtRanks('E', 'Echo', 10, { QB: 5, RB: 6, WR: 9, TE: 1 }, [
		{ name: 'Echo RB', position: 'RB', team: 'KC', ecr: { rank: 40 } },
		{ name: 'Echo WR', position: 'WR', team: 'SF', ecr: { rank: 55 } },
	]);
	const card = domCtx.renderTeamNeedsCard('dynasty', ['dynasty'], [echo], 2026);
	assert.notEqual(card, null);

	const row = findAll(card, (c) => c.tag === 'tr').filter((tr) => tr.children.some((c) => c.tag === 'td'))[0];
	const nameCell = row.children[0];
	const [qbCell, rbCell, wrCell, teCell] = row.children.slice(1);

	assert.equal(fullText(qbCell), '5');
	assert.equal(fullText(rbCell), '6');
	assert.equal(fullText(wrCell), '9');
	assert.equal(fullText(teCell), '1');

	// The boundary: exactly at the average is fine, one worse is a need.
	assert.ok(!qbCell.cls.includes('needs-weakest'), 'rank 5 of 10 sits exactly on the average — not a need');
	assert.ok(rbCell.cls.includes('needs-weakest'), 'rank 6 of 10 is one worse than average — a need');

	// Two needs at once: neither displaces the other, both are flagged
	// together, and TE — nowhere near the threshold — is flagged at neither.
	assert.ok(wrCell.cls.includes('needs-weakest'), 'rank 9 of 10 is also a need, simultaneously with RB');
	assert.ok(!teCell.cls.includes('needs-weakest'), 'the league leader at TE is never a need');

	// One roster sub-line per flagged position, each carrying only that
	// position's own roster — not merged into a single line, and not
	// printed for QB or TE despite QB sitting one player away from the line.
	const rosterLines = findAll(nameCell, (c) => c.cls.trim().split(/\s+/).includes('power-players'));
	assert.equal(rosterLines.length, 2, 'exactly one sub-line per flagged position');
	const byLabel = Object.fromEntries(rosterLines.map((line) => [line.children[0]._text.trim(), line]));
	assert.ok(byLabel.RB, 'an RB sub-line exists');
	assert.ok(byLabel.WR, 'a WR sub-line exists');
	assert.equal(fullText(byLabel.RB), 'RB Echo RB KC (40)');
	assert.equal(fullText(byLabel.WR), 'WR Echo WR SF (55)');
}

// ---- The fallback tier: a strong team still gets an answer -----------------
//
// The average-based flag can legitimately find nothing on a genuinely strong
// roster — every position clears the league average. Leaving the row blank
// there would mean a contender's row never has anything to say, while a
// mediocre team's fills with flags every week. So when nothing clears the
// average, the fallback is the team's own weakest position(s) relative to
// itself, ties included — the same "flag all of them, not an arbitrary one"
// rule the average-based flag already follows.

{
	// 10 teams, none below the average (threshold 5): 1, 2, 3, 1. WR (3) is
	// the worst of the four, but nowhere near a real weakness — this is the
	// fallback kicking in for a team with no genuine below-average spot.
	const foxtrot = leagueAtRanks('F', 'Foxtrot', 10, { QB: 1, RB: 2, WR: 3, TE: 1 }, [
		{ name: 'Foxtrot WR', position: 'WR', team: 'MIA', ecr: { rank: 20 } },
	]);
	const card = domCtx.renderTeamNeedsCard('dynasty', ['dynasty'], [foxtrot], 2026);
	assert.notEqual(card, null);
	const row = findAll(card, (c) => c.tag === 'tr').filter((tr) => tr.children.some((c) => c.tag === 'td'))[0];
	const [qbCell, rbCell, wrCell, teCell] = row.children.slice(1);

	assert.ok(!qbCell.cls.includes('needs-weakest'), 'rank 1 clears the average by a mile');
	assert.ok(!rbCell.cls.includes('needs-weakest'), 'rank 2 also clears it');
	assert.ok(!teCell.cls.includes('needs-weakest'), 'rank 1, tied for best, clears it too');
	assert.ok(wrCell.cls.includes('needs-weakest'), 'nothing is below average, so the team\'s own worst (WR) is flagged instead');

	// And it still gets a roster sub-line, exactly like an average-based flag
	// would — "this is your weakest spot" is worth naming players for even
	// when it isn't a real league-wide weakness.
	const rosterLines = findAll(row.children[0], (c) => c.cls.trim().split(/\s+/).includes('power-players'));
	assert.equal(rosterLines.length, 1);
	assert.equal(fullText(rosterLines[0]), 'WR Foxtrot WR MIA (20)');
}

{
	// 10 teams, none below average, and a tie for the team's own worst: RB
	// and WR both sit at 3, QB and TE lead at 1. Both must be flagged —
	// picking one over the other would claim a difference the numbers don't
	// support, the same reasoning the average-based tie case already uses.
	const golf = leagueAtRanks('G', 'Golf', 10, { QB: 1, RB: 3, WR: 3, TE: 1 }, [
		{ name: 'Golf RB', position: 'RB', team: 'DAL', ecr: { rank: 30 } },
		{ name: 'Golf WR', position: 'WR', team: 'ATL', ecr: { rank: 45 } },
	]);
	const card = domCtx.renderTeamNeedsCard('dynasty', ['dynasty'], [golf], 2026);
	const row = findAll(card, (c) => c.tag === 'tr').filter((tr) => tr.children.some((c) => c.tag === 'td'))[0];
	const [qbCell, rbCell, wrCell, teCell] = row.children.slice(1);

	assert.ok(!qbCell.cls.includes('needs-weakest'));
	assert.ok(!teCell.cls.includes('needs-weakest'));
	assert.ok(rbCell.cls.includes('needs-weakest'), 'RB ties for the team\'s own worst');
	assert.ok(wrCell.cls.includes('needs-weakest'), 'WR ties for it too — both flagged, not one picked arbitrarily');

	const rosterLines = findAll(row.children[0], (c) => c.cls.trim().split(/\s+/).includes('power-players'));
	assert.equal(rosterLines.length, 2, 'both tied positions get their own sub-line');
}

{
	// A team tied at the SAME rank everywhere (a two-team league where mine
	// leads at every position, byPos all 1s) has no relatively-weaker spot
	// at all — the "worst" and "best" are identical, so the fallback must
	// not flag all four positions just because they share the max. This is
	// the fixture from the Alpha/Bravo block above, re-asserted here as the
	// fallback tier's own boundary rather than an incidental side effect.
	const byPos = (qb, rb, wr, te) => ({
		QB: { score: qb, depth: 0 }, RB: { score: rb, depth: 0 }, WR: { score: wr, depth: 0 }, TE: { score: te, depth: 0 },
	});
	const hotel = {
		id: 'H', name: 'Hotel', type: 'dynasty', season: '2026', franchiseId: '1',
		power: { projections: { source: { basis: 'projections' }, teams: [
			{ franchiseId: '1', score: 100, depth: 10, byPosition: byPos(10, 10, 10, 10) },
			{ franchiseId: '2', score: 5, depth: 0, byPosition: byPos(1, 1, 1, 1) },
		] }, ecr: null },
	};
	const card = domCtx.renderTeamNeedsCard('dynasty', ['dynasty'], [hotel], 2026);
	const row = findAll(card, (c) => c.tag === 'tr').filter((tr) => tr.children.some((c) => c.tag === 'td'))[0];
	const cells = row.children.slice(1);
	assert.ok(cells.every((c) => !c.cls.includes('needs-weakest')), 'tied-everywhere: nothing is relatively worse, so nothing is flagged');
	assert.equal(findAll(row.children[0], (c) => c.cls.trim().split(/\s+/).includes('power-players')).length, 0);
}

// ---- The Starters/Bench popover ---------------------------------------------
//
// Every Team Needs rank is a button, the same idiom .salary-link uses for
// Salary by Year on the Rosters tab: clicking it reveals the Starters/Bench
// split behind the blended number on screen, via a single shared popover
// instance appended to <body>.

{
	// A single position (RB) built by hand, with real, distinct
	// starters/depth splits per franchise so overall, starters and depth can
	// all disagree — proving the popover shows the real breakdown rather
	// than the same number three times. QB/WR/TE are trivial and identical
	// across franchises: hasByPosition only needs them present, not
	// interesting.
	const flat = { score: 10, depth: 0 };
	const league = {
		id: 'P', name: 'Popover League', type: 'dynasty', season: '2026', franchiseId: '1',
		power: { projections: { source: { basis: 'projections' }, teams: [
			// Mine: 2nd by starters, 2nd by depth, but 3rd overall — the
			// combined total a rival with a worse split still edges out.
			{ franchiseId: '1', score: 100, depth: 10, byPosition: { QB: flat, RB: { score: 50, depth: 10 }, WR: flat, TE: flat } },
			{ franchiseId: '2', score: 90, depth: 5, byPosition: { QB: flat, RB: { score: 80, depth: 5 }, WR: flat, TE: flat } },
			{ franchiseId: '3', score: 80, depth: 20, byPosition: { QB: flat, RB: { score: 30, depth: 100 }, WR: flat, TE: flat } },
		] }, ecr: null },
	};

	const card = domCtx.renderTeamNeedsCard('dynasty', ['dynasty'], [league], 2026);
	assert.notEqual(card, null);
	const row = findAll(card, (c) => c.tag === 'tr').filter((tr) => tr.children.some((c) => c.tag === 'td'))[0];
	const [qbCell, rbCell] = row.children.slice(1);
	assert.equal(fullText(rbCell), '3', "my RB's combined score+depth (60) trails both rivals (85, 130)");

	const findPopover = () => domCtx.document.body.children.find((c) => c.cls.trim().split(/\s+/).includes('needs-popover'));
	assert.equal(findPopover(), undefined, 'no popover exists before any rank is clicked');

	const rbButton = rbCell.children.find((c) => c.tag === 'button');
	assert.ok(rbButton, 'the rank is a real button, not plain text');
	rbButton.click();

	const popover = findPopover();
	assert.ok(popover, 'clicking the rank opens the popover');
	assert.ok(!popover.cls.includes('hidden'), 'and it is visible, not just present');
	const title = popover.children.find((c) => c.cls.includes('needs-popover-title'));
	assert.equal(fullText(title), 'Popover League — RB');
	const rows = popover.children.filter((c) => c.cls.includes('needs-popover-row'));
	assert.deepEqual(rows.map((r) => fullText(r)), ['Starters2', 'Bench2'], 'starters (rank 2) and bench (rank 2) both differ from the overall rank (3) shown on the button');

	// Clicking the same button again closes it — the same toggle behavior
	// Salary by Year uses.
	rbButton.click();
	assert.ok(findPopover().cls.includes('hidden'), 'a second click on the same button closes the popover');

	// Clicking a different rank's button reuses the one shared instance
	// (never a second popover element) and replaces its content.
	const qbButton = qbCell.children.find((c) => c.tag === 'button');
	qbButton.click();
	const reopened = findPopover();
	assert.ok(!reopened.cls.includes('hidden'));
	assert.equal(domCtx.document.body.children.filter((c) => c.cls.trim().split(/\s+/).includes('needs-popover')).length, 1, 'one shared popover instance, not one per button');
	assert.equal(fullText(reopened.children.find((c) => c.cls.includes('needs-popover-title'))), 'Popover League — QB');
}

console.log('test-team-needs: all assertions passed');
