// Unit test for the History tab's Finances card — formatMoney,
// financesSignClass, leagueFinancesSummary and renderFinancesCard in
// myffl.html.
//
// The judgement calls pinned here: Won is computed from that year's own
// Finish (league.results[].rank) against the three flat payout1/2/3 fields
// (every league is assumed to pay exactly the top 3), never stored
// separately; a payout of exactly $0 for a rank is distinct from that rank
// having no payout field at all (unknown), and only the latter renders as a
// dash; Total is null unless BOTH dues and won are known for that year,
// never a partial sum; a league's own Total is the sum of its known yearly
// totals, and the card-head's overall Total is the sum of every league's own
// Total — sums, not averages, since money accumulates rather than blends;
// leagues sort by best (highest) total first, with leagues carrying no
// total at all sorting last, in their original relative order; a total is
// visually flagged wherever it appears (header, league head, and the
// per-year Total cell) — green for a gain, red for a loss, and neither
// color for a total that's exactly $0 or not yet known; and a league with
// no results at all still gets a row (naming it and saying why), never
// silently dropped.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(root, 'myffl.html'), 'utf8');
const scriptSource = html.match(/<script>([\s\S]*)<\/script>/)[1];

function domNode(tag = 'div') {
	const n = {
		tag, children: [], attrs: {}, cls: '', _text: '', dataset: {}, style: {}, listeners: {},
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
function fullText(node) {
	if (!node) return '';
	if (!node.children || node.children.length === 0) return node._text || '';
	return (node._text || '') + node.children.map(fullText).join('');
}

// ---- formatMoney -------------------------------------------------------------

{
	assert.equal(domCtx.formatMoney(100), '$100');
	assert.equal(domCtx.formatMoney(0), '$0');
	assert.equal(domCtx.formatMoney(-50), '-$50', 'the minus sign leads, never "$-50"');
	assert.equal(domCtx.formatMoney(99.6), '$100', 'whole dollars — no cents');
}

// ---- financesSignClass --------------------------------------------------------

{
	assert.equal(domCtx.financesSignClass(50), 'finances-positive');
	assert.equal(domCtx.financesSignClass(-50), 'finances-negative');
	assert.equal(domCtx.financesSignClass(0), '', 'breaking exactly even is neither a gain nor a loss');
	assert.equal(domCtx.financesSignClass(null), '', 'nothing to total yet gets no color either');
}

// ---- leagueFinancesSummary ----------------------------------------------------

{
	// Dues and all three payouts configured: Won reads off that year's own
	// rank against payout1/payout2/payout3.
	const league = {
		name: 'A',
		dues: 100,
		payout1: 500,
		payout2: 250,
		results: [
			{ year: '2023', rank: 1, total: 10 },
			{ year: '2024', rank: 2, total: 10 },
			{ year: '2025', rank: 5, total: 10 }, // outside the top 3 — no payout field exists for it
		],
	};
	const summary = domCtx.leagueFinancesSummary(league);
	assert.deepEqual([...summary.years].map((y) => y.year), ['2025', '2024', '2023'], 'most-recent-first');

	const y2023 = summary.years.find((y) => y.year === '2023');
	assert.equal(y2023.won, 500);
	assert.equal(y2023.total, 400, '500 won - 100 dues');

	const y2025 = summary.years.find((y) => y.year === '2025');
	assert.equal(y2025.won, null, 'rank 5 has no payout field — every league is assumed top-3-only');
	assert.equal(y2025.total, null, 'no total without a known Won');

	assert.equal(summary.total, 400 + 150, '(500-100) + (250-100), the unresolved 2025 excluded entirely');
}

{
	// A payout of exactly $0 for a rank is a real, known answer — distinct
	// from that rank's field being left blank entirely.
	const league = {
		name: 'B',
		dues: 50,
		payout3: 0,
		results: [{ year: '2024', rank: 3, total: 10 }],
	};
	const summary = domCtx.leagueFinancesSummary(league);
	assert.equal(summary.years[0].won, 0, 'a configured $0 payout is known, not missing');
	assert.equal(summary.years[0].total, -50, '0 won - 50 dues');
}

{
	// Dues configured, payouts not (or vice versa): each cell stays
	// independently null rather than the whole year vanishing.
	const league = { name: 'C', dues: 100, results: [{ year: '2024', rank: 1, total: 10 }] };
	const summary = domCtx.leagueFinancesSummary(league);
	assert.equal(summary.years[0].dues, 100);
	assert.equal(summary.years[0].won, null, 'no payout fields set at all');
	assert.equal(summary.years[0].total, null);
	assert.equal(summary.total, null, 'nothing to sum');
}

{
	// No results at all — today's actual state for every real league.
	const summary = domCtx.leagueFinancesSummary({ name: 'D' });
	assert.deepEqual([...summary.years], []);
	assert.equal(summary.total, null);
}

// ---- renderFinancesCard -------------------------------------------------------

{
	const leagues = [
		{ id: 'D', name: 'League D', type: 'dynasty' }, // no results, no config
		{ id: 'A', name: 'League A', type: 'dynasty', dues: 100, payout1: 500, payout2: 250, results: [
			{ year: '2024', rank: 1, total: 10 },
			{ year: '2025', rank: 2, total: 10 },
		] }, // total: 400 + 150 = 550
		{ id: 'B', name: 'League B', type: 'salarycap', dues: 100, payout1: 500, results: [
			{ year: '2024', rank: 8, total: 10 }, // outside the top 3 — no payout field for it
			{ year: '2025', rank: 1, total: 10 },
		] }, // total: null (2024 unresolved) + 400 = 400
		{ id: 'C', name: 'League C', type: 'salarycap', dues: 200, payout3: 0, results: [
			{ year: '2024', rank: 3, total: 10 },
		] }, // total: 0 - 200 = -200, a loss
	];

	const card = domCtx.renderFinancesCard('dynasty', ['dynasty', 'salarycap'], leagues);
	assert.notEqual(card, null);

	const labels = findAll(card, (c) => c.cls.includes('group-label')).map(fullText);
	assert.deepEqual(labels, ['League A', 'League B', 'League C', 'League D'],
		'best (highest) total first — A: 550, B: 400, C: -200 — then the league with no total at all');

	const cardHead = findAll(card, (c) => c.cls.includes('card-head'))[0];
	assert.equal(fullText(findAll(cardHead, (c) => c.tag === 'h2')[0]), 'Finances');
	const overall = findAll(cardHead, (c) => c.cls.includes('finances-total'))[0];
	assert.equal(fullText(overall), 'Total $750', '550 + 400 + (-200) across the three leagues with a total');
	assert.ok(overall.cls.includes('finances-positive'), 'the overall figure itself is a gain');
	assert.ok(!overall.cls.includes('finances-negative'));

	// League C's own head carries the loss flag; League A's carries the gain
	// flag — never both, and never neither when the total is nonzero.
	const heads = findAll(card, (c) => c.cls.includes('finances-league-head'));
	const headFor = (name) => heads.find((h) => fullText(h).includes(name));
	const totalSpanOf = (name) => findAll(headFor(name), (c) => c.cls.includes('finances-total') && !c.cls.includes('finances-total-overall'))[0];
	assert.equal(fullText(totalSpanOf('League A')), '$550');
	assert.ok(totalSpanOf('League A').cls.includes('finances-positive'), 'a gain is visually flagged too, not just a loss');
	assert.ok(!totalSpanOf('League A').cls.includes('finances-negative'));
	assert.equal(fullText(totalSpanOf('League C')), '-$200');
	assert.ok(totalSpanOf('League C').cls.includes('finances-negative'), 'a loss is visually flagged');
	assert.ok(!totalSpanOf('League C').cls.includes('finances-positive'));

	// League D: no results, no config — a named message, not a silent drop.
	assert.equal(totalSpanOf('League D'), undefined, 'nothing to total, so no figure at all');
	const errorBoxes = findAll(card, (c) => c.cls.includes('error-box'));
	assert.equal(errorBoxes.length, 1);
	assert.ok(fullText(errorBoxes[0]).includes('No financial data yet'));

	// League B's table: the unresolved 2024 row shows dashes, not a
	// fabricated partial total; 2025 shows real figures.
	const tables = findAll(card, (c) => c.tag === 'table');
	const rowsOf = (table) => findAll(table, (c) => c.tag === 'tr');
	const headerOf = (table) => rowsOf(table)[0];
	assert.deepEqual(findAll(headerOf(tables[0]), (c) => c.tag === 'th').map(fullText), ['Year', 'Dues', 'Won', 'Total']);

	const tableB = tables[1];
	const bRows = rowsOf(tableB);
	const rowFor = (year) => bRows.find((r) => fullText(r.children[0]) === year);
	const row2024 = rowFor('2024');
	assert.deepEqual(row2024.children.map(fullText), ['2024', '-$100', '—', '—']);
	const row2025 = rowFor('2025');
	assert.deepEqual(row2025.children.map(fullText), ['2025', '-$100', '$500', '$400']);
	assert.ok(row2025.children[3].cls.includes('finances-positive'));
	assert.ok(!row2025.children[3].cls.includes('finances-negative'));

	// League C's single row: a real, known $0 payout against real dues is a
	// real, known loss — flagged in the table the same way it is in the head.
	const tableC = tables[2];
	const rowC = rowsOf(tableC)[1];
	assert.deepEqual(rowC.children.map(fullText), ['2024', '-$200', '$0', '-$200']);
	assert.ok(rowC.children[3].cls.includes('finances-negative'));
	assert.ok(!rowC.children[3].cls.includes('finances-positive'));

	// Collapsed by default, one <details> per league that has years at all
	// (D has none, so it gets the error box instead).
	const detailsEls = findAll(card, (c) => c.tag === 'details');
	assert.equal(detailsEls.length, 3);
	assert.ok(detailsEls.every((d) => d.attrs.open === undefined));

	// A group with none of its types present renders no card at all.
	assert.equal(domCtx.renderFinancesCard('redraft', ['redraft'], leagues), null);
}

console.log('test-finances-card: all assertions passed');
