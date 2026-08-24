// Unit test for the History tab's Results card — leagueResultsSummary and
// renderResultsCard in myffl.html.
//
// The judgement calls pinned here: the average is the mean of `rank`
// values, never the raw fraction (a 12-team league's numbers must not swamp
// a 10-team league's in the same average); rows render most-recent-first;
// a `guessed` year's Finish cell is visually distinct so an estimate is
// never presented as identical to a confirmed result; a league with no
// results yet still gets a row (naming it and saying why), never silently
// dropped; leagues sort by best (lowest) average finish first, with
// leagues carrying no average at all sorting last, in their original
// relative order (a stable sort, not an arbitrary one); and a year with a
// real payout names the dollar amount in parens (e.g. "1/10 ($300)") —
// never the ordinal, which the rank already spells out — muted on a
// confirmed finish but inheriting the guessed row's red instead of its own
// color on an estimated one. Won is looked up off the same PAYOUT_FIELDS
// the Finances card reads, but never nets against dues — that framing is
// Finances' job, not Results'.

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

// ---- leagueResultsSummary ---------------------------------------------------

{
	const league = { name: 'A', results: [
		{ year: '2023', rank: 3, total: 12, guessed: false },
		{ year: '2025', rank: 1, total: 12, guessed: false },
		{ year: '2024', rank: 7, total: 12, guessed: false },
	] };
	const summary = domCtx.leagueResultsSummary(league);
	assert.deepEqual([...summary.years].map((y) => y.year), ['2025', '2024', '2023'], 'most-recent-first');
	assert.equal(summary.average, (3 + 1 + 7) / 3, 'the mean of rank, never the raw fraction');
}

{
	const league = { name: 'B', results: [] };
	const summary = domCtx.leagueResultsSummary(league);
	assert.deepEqual([...summary.years], []);
	assert.equal(summary.average, null, 'nothing to average yet');
}

{
	// A league object with no `results` field at all (never synced under
	// this feature) degrades exactly like an empty array, not a crash.
	const summary = domCtx.leagueResultsSummary({ name: 'C' });
	assert.deepEqual([...summary.years], []);
	assert.equal(summary.average, null);
}

{
	// won: a real payout looked up by rank, a real $0 outside the top 3, and
	// a real $0 for an unentered payout field — never netted against dues,
	// unlike Finances' Won/Total.
	const league = { name: 'D', dues: 999, payout1: 500, payout3: 0, results: [
		{ year: '2024', rank: 1, total: 10, guessed: false }, // payout1 entered
		{ year: '2023', rank: 2, total: 10, guessed: false }, // payout2 never entered
		{ year: '2022', rank: 3, total: 10, guessed: false }, // payout3 entered as $0
		{ year: '2021', rank: 8, total: 10, guessed: false }, // outside the top 3
	] };
	const summary = domCtx.leagueResultsSummary(league);
	const wonFor = (year) => summary.years.find((y) => y.year === year).won;
	assert.equal(wonFor('2024'), 500);
	assert.equal(wonFor('2023'), 0, 'payout2 was never entered — a real $0, not unknown');
	assert.equal(wonFor('2022'), 0, 'payout3 was entered as exactly $0');
	assert.equal(wonFor('2021'), 0, 'outside the top 3 — no payout field to look up at all');
}

{
	// startYear — a manager-declared floor for a league joined mid-history
	// (config/leagues.json's own field, set via the Admin tab). A year
	// before it is excluded from years AND from the average, since the
	// franchise id these results are keyed to belonged to someone else back
	// then — not a gap to fill, a real answer about the wrong manager.
	const league = { name: 'E', startYear: '2023', results: [
		{ year: '2021', rank: 9, total: 10, guessed: false }, // not this manager's
		{ year: '2022', rank: 10, total: 10, guessed: false }, // not this manager's
		{ year: '2023', rank: 1, total: 10, guessed: false },
		{ year: '2024', rank: 4, total: 10, guessed: false },
	] };
	const summary = domCtx.leagueResultsSummary(league);
	assert.deepEqual([...summary.years].map((y) => y.year), ['2024', '2023'], 'years before startYear are excluded entirely');
	assert.equal(summary.average, (4 + 1) / 2, 'the average only ever counts this manager\'s own years');
}

{
	// A blank startYear (the normal, unset state) excludes nothing — same
	// as a league with no startYear field at all.
	const league = { name: 'F', startYear: '', results: [
		{ year: '2020', rank: 5, total: 10, guessed: false },
		{ year: '2024', rank: 2, total: 10, guessed: false },
	] };
	const summary = domCtx.leagueResultsSummary(league);
	assert.deepEqual([...summary.years].map((y) => y.year), ['2024', '2020']);
}

// ---- renderResultsCard ------------------------------------------------------

{
	const leagues = [
		{ id: 'C', name: 'League C', type: 'dynasty' }, // no results at all
		{ id: 'A', name: 'League A', type: 'dynasty', payout1: 500, payout3: 100, results: [
			{ year: '2023', rank: 3, total: 12, guessed: false },
			{ year: '2024', rank: 7, total: 12, guessed: false },
			{ year: '2025', rank: 1, total: 12, guessed: false },
		] },
		{ id: 'D', name: 'League D', type: 'dynasty', results: [] }, // explicitly empty, same as C
		{ id: 'B', name: 'League B', type: 'salarycap', payout2: 250, results: [
			{ year: '2024', rank: 8, total: 10, guessed: true },
			{ year: '2025', rank: 2, total: 10, guessed: false },
		] },
	];

	const card = domCtx.renderResultsCard('dynasty', ['dynasty', 'salarycap'], leagues);
	assert.notEqual(card, null);

	const labels = findAll(card, (c) => c.cls.includes('group-label')).map(fullText);
	assert.deepEqual(labels, ['League A', 'League B', 'League C', 'League D'],
		'best average first (A: 3.67, B: 5.0), then leagues with no average, in their original relative order');

	// The average now sits beside the league name, not as a footer row in
	// the table, and the year-by-year rows live inside a collapsed-by-
	// default <details> underneath it.
	const avgs = findAll(card, (c) => c.cls.includes('results-avg')).map(fullText);
	assert.deepEqual(avgs, ['Avg Finish 4.3', 'Avg Finish 3.7', 'Avg Finish 5.0'],
		'card-head carries the overall mean first (3.67 and 5.0 -> 4.33 -> 4.3), then each league\'s own');

	// The overall figure lives in the card-head, beside the "Results" title
	// itself — not mixed in with the per-league ones below.
	const cardHead = findAll(card, (c) => c.cls.includes('card-head'))[0];
	assert.ok(cardHead, 'card-head wraps the title and the overall average');
	assert.equal(fullText(findAll(cardHead, (c) => c.tag === 'h2')[0]), 'Results');
	assert.equal(fullText(findAll(cardHead, (c) => c.cls.includes('results-avg'))[0]), 'Avg Finish 4.3');

	const detailsEls = findAll(card, (c) => c.tag === 'details');
	assert.equal(detailsEls.length, 2, 'one <details> per league that has results');
	assert.ok(detailsEls.every((d) => d.attrs.open === undefined), 'hidden by default, not pre-expanded');

	// League A's table: rows most-recent-first, no average row mixed in.
	const tables = findAll(card, (c) => c.tag === 'table');
	const rowsOf = (table) => findAll(table, (c) => c.tag === 'tr');
	const [tableA, tableB] = tables;

	const aRows = rowsOf(tableA);
	assert.equal(aRows.length, 4, 'header row plus 3 year rows only');
	assert.deepEqual(aRows.slice(1, 4).map((r) => fullText(r.children[0])), ['2025', '2024', '2023']);
	// 1st ($500) and 3rd ($100) both get a payout amount; 7th (outside the
	// top 3, so no payout field to look up) gets none.
	assert.deepEqual(aRows.slice(1, 4).map((r) => fullText(r.children[1])), ['1/12 ($500)', '7/12', '3/12 ($100)']);

	// League B: the guessed year's Finish cell is flagged, the confirmed
	// year's is not — this isn't a blanket style on the whole row or table.
	const bRows = rowsOf(tableB);
	const finishCellOf = (year) => bRows.find((r) => fullText(r.children[0]) === year)?.children[1];
	assert.ok(finishCellOf('2024').cls.includes('results-guessed'), 'the guessed 2024 finish is flagged');
	assert.ok(!finishCellOf('2025').cls.includes('results-guessed'), 'the confirmed 2025 finish is not');
	assert.equal(fullText(finishCellOf('2024')), '8/10', 'outside the top 3 — no payout amount, guessed or not');
	// A confirmed top-3 finish (2nd, $250) names the amount in parens, muted
	// — same idiom as the Finances card's Won cell, but the dollar figure
	// rather than the redundant ordinal.
	assert.equal(fullText(finishCellOf('2025')), '2/10 ($250)');
	const payoutSpanOf = (year) => findAll(finishCellOf(year), (c) => c.cls.includes('results-payout'))[0];
	assert.ok(payoutSpanOf('2025'), 'the confirmed finish gets its own muted payout span');

	// Leagues C and D: no table at all, an explanatory message instead —
	// never silently dropped from the card.
	const errorBoxes = findAll(card, (c) => c.cls.includes('error-box'));
	assert.equal(errorBoxes.length, 2, 'both C and D get the message, not just one');
	for (const box of errorBoxes) {
		assert.ok(fullText(box).includes('No results yet'));
	}

	// A group with none of its types present renders no card at all, the
	// same way every other Analytics/History card behaves.
	assert.equal(domCtx.renderResultsCard('redraft', ['redraft'], leagues), null);
}

// A guessed top-3 finish with a real payout still names the amount, but the
// label carries no muted color of its own — it inherits .results-guessed's
// red from the parent cell, so the whole cell reads as one estimate rather
// than a confirmed rank sitting next to an unsure amount.
{
	const leagues = [{ id: 'H', name: 'League H', type: 'dynasty', payout1: 300, results: [
		{ year: '2025', rank: 1, total: 10, guessed: true },
	] }];
	const card = domCtx.renderResultsCard('dynasty', ['dynasty'], leagues);
	const table = findAll(card, (c) => c.tag === 'table')[0];
	const row = findAll(table, (c) => c.tag === 'tr')[1];
	const finishCell = row.children[1];
	assert.ok(finishCell.cls.includes('results-guessed'));
	assert.equal(fullText(finishCell), '1/10 ($300)', 'the amount is still named even though the finish is estimated');
	assert.equal(findAll(finishCell, (c) => c.cls.includes('results-payout')).length, 0,
		'no separate muted class — the amount inherits the cell\'s red instead');
}

// The live-synced leagueName wins over config's own static name, same as
// every other card on the page (buildLeagueHeading, the Admin tab's
// disclosure name, the problems digest, etc.) — config's `name` is only a
// fallback for a league the provider can't be reached for, and this
// mattered for real: both ESPN leagues in production carry a generic
// config name ("ESPN League 1") that isn't what their commissioners
// actually named them.
{
	const leagues = [{ id: 'G', name: 'ESPN League 1', leagueName: 'Lincoln Hates Fantasy', type: 'redraft', results: [
		{ year: '2025', rank: 3, total: 10, guessed: false },
	] }];
	const card = domCtx.renderResultsCard('redraft', ['redraft'], leagues);
	const label = findAll(card, (c) => c.cls.includes('group-label')).map(fullText)[0];
	assert.equal(label, 'Lincoln Hates Fantasy');
}

// A group where nothing has an average yet gets no overall figure — an
// empty mean would be worse than no number at all, and there's nothing
// here for "Avg Finish" to summarize.
{
	const leagues = [
		{ id: 'E', name: 'League E', type: 'dynasty' },
		{ id: 'F', name: 'League F', type: 'dynasty', results: [] },
	];
	const card = domCtx.renderResultsCard('dynasty', ['dynasty'], leagues);
	const cardHead = findAll(card, (c) => c.cls.includes('card-head'))[0];
	assert.equal(findAll(cardHead, (c) => c.cls.includes('results-avg')).length, 0,
		'no leagues have an average, so the card-head carries none either');
}

console.log('test-results-card: all assertions passed');
