// Unit test for the History tab's Finances card — formatMoney,
// financesSignClass, leagueFinancesSummary and renderFinancesCard in
// myffl.html.
//
// The judgement calls pinned here: Won is computed from that year's own
// Finish (league.results[].rank) against the three flat payout1/2/3 fields
// (every league is assumed to pay exactly the top 3), never stored
// separately; unlike most of this page, an unentered dollar amount here
// (dues, or a rank's payout — whether because the rank is outside the top 3
// or the field just hasn't been filled in) reads as $0 rather than
// "unknown," so every Dues/Won/Total cell for a year with a backfilled
// Finish is always a real number — no dashes; Total therefore goes negative
// the moment dues outweigh whatever was won, which is the point of the
// card; a league's own Total is the sum of its yearly totals, and the
// card-head's overall Total is the sum of every league's own Total — sums,
// not averages, since money accumulates rather than blends; leagues sort by
// best (highest) total first, with a league that has no backfilled Finish
// for any year at all (the one remaining case with no Total to show)
// sorting last; a total is visually flagged wherever it appears (header,
// league head, and the per-year Total cell) — green for a gain, red for a
// loss, and neither color for a total that's exactly $0; a league with
// no results at all still gets a row (naming it and saying why), never
// silently dropped; and a year's Won cell is plain text ONLY when there's
// nothing to explain (won $0, or a rank outside the top 3 with no payout
// field) — any real reason behind the amount turns it into a button
// (.finances-link) opening a popover breakdown, the same idiom .salary-link
// uses on the Rosters tab, rather than spelling every reason out inline in
// the cell.
//
// Also pinned here: weekly/season high-score payouts (payoutWeeklyHigh/
// payoutSeasonHigh) are a second, independent axis from Finish — a
// last-place team can still have had a league-best week — so they add into
// the same year's Won on top of (never instead of) the placement payout.
// weeklyHigh is NOT a once-a-season record — it's awarded fresh every week,
// so results[].scoring.weeklyHighs is an array (one entry per week that
// week's own top scorer won), and this franchise can appear in it more than
// once; Won sums payoutWeeklyHigh once per entry that carries this
// franchise's id, not a flat one-or-nothing amount. seasonHigh stays a
// single record, keyed off league.franchiseId matching it directly. A
// `scoring` field absent (not yet backfilled — see
// backfillLeagueScoringRecords in fetch-rosters.mjs) contributes $0,
// indistinguishable from "confirmed you didn't win it," same as an
// unentered payout field already reads. `leagueFinancesSummary` returns a
// `breakdown` array ({label, amount}), one line item per contributing
// reason — place first, then one row per weekly-high week won, then season
// high — that the popover renders directly; it used to be a flat `labels`
// array of strings rendered inline in the cell, replaced because a
// franchise that wins several weekly-highs in one season (not rare — see
// the real MNMx 2025 case that prompted this) made that inline text run
// long.

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
		// Zeroed rect/offsets — the finances popover's own positioning math
		// runs against these, but this suite checks that it opens with the
		// right content, not where it lands on a real screen.
		getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
		offsetWidth: 0,
		offsetHeight: 0,
		// A real click event always carries a stopPropagation a handler can
		// call without checking; production code (see the Won-cell button)
		// relies on that exactly like a browser would.
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
function fullText(node) {
	if (!node) return '';
	if (!node.children || node.children.length === 0) return node._text || '';
	return (node._text || '') + node.children.map(fullText).join('');
}
// Plain objects built inside the vm context (leagueFinancesSummary's own
// `breakdown` entries) carry that context's Object prototype, not this
// process's — assert.deepEqual treats that as "same structure but not
// reference-equal" and fails even when every field matches. Round-tripping
// through JSON strips the foreign prototype; safe here since breakdown rows
// are only ever {label: string, amount: number}, nothing JSON would mangle.
const plain = (x) => JSON.parse(JSON.stringify(x));

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
	// Dues and two of three payouts configured: Won reads off that year's
	// own rank against payout1/payout2/payout3. A rank outside the top 3
	// (2025, rank 5) is a real, known $0 — not unknown — given the top-3-
	// only assumption, so it still contributes a real Total.
	const league = {
		name: 'A',
		dues: 100,
		payout1: 500,
		payout2: 250,
		results: [
			{ year: '2023', rank: 1, total: 10 },
			{ year: '2024', rank: 2, total: 10 },
			{ year: '2025', rank: 5, total: 10 },
		],
	};
	const summary = domCtx.leagueFinancesSummary(league);
	assert.deepEqual([...summary.years].map((y) => y.year), ['2025', '2024', '2023'], 'most-recent-first');

	const y2023 = summary.years.find((y) => y.year === '2023');
	assert.equal(y2023.won, 500);
	assert.equal(y2023.total, 400, '500 won - 100 dues');

	const y2025 = summary.years.find((y) => y.year === '2025');
	assert.equal(y2025.won, 0, 'rank 5 has no payout field, so it defaults to a real $0 — not unknown');
	assert.equal(y2025.total, -100, '0 won - 100 dues, a real loss');

	assert.equal(summary.total, 400 + 150 - 100, 'every year counts now, including the outside-the-money one');
}

{
	// An explicit $0 payout behaves identically to a rank with no payout
	// field at all — this card no longer distinguishes "entered as zero"
	// from "never entered."
	const league = {
		name: 'B',
		dues: 50,
		payout3: 0,
		results: [{ year: '2024', rank: 3, total: 10 }],
	};
	const summary = domCtx.leagueFinancesSummary(league);
	assert.equal(summary.years[0].won, 0);
	assert.equal(summary.years[0].total, -50, '0 won - 50 dues');
}

{
	// Dues configured, no payouts entered at all: Won defaults to $0 for
	// every year rather than leaving Total blank — the Total column's whole
	// job is to show the loss of a paid entry fee against nothing won.
	const league = { name: 'C', dues: 100, results: [{ year: '2024', rank: 1, total: 10 }] };
	const summary = domCtx.leagueFinancesSummary(league);
	assert.equal(summary.years[0].dues, 100);
	assert.equal(summary.years[0].won, 0, 'no payout fields set at all — defaults to $0, not unknown');
	assert.equal(summary.years[0].total, -100);
	assert.equal(summary.total, -100);
}

{
	// Payouts configured, no dues entered: dues defaults to $0 too, so a
	// real payout nets to a real gain rather than an unknown Total.
	const league = { name: 'E', payout1: 300, results: [{ year: '2024', rank: 1, total: 10 }] };
	const summary = domCtx.leagueFinancesSummary(league);
	assert.equal(summary.years[0].dues, 0, 'no dues entered — defaults to $0, not unknown');
	assert.equal(summary.years[0].won, 300);
	assert.equal(summary.years[0].total, 300);
}

{
	// No results at all — the one remaining case where nothing can be
	// computed, since there's no Finish to look a payout up against.
	const summary = domCtx.leagueFinancesSummary({ name: 'F' });
	assert.deepEqual([...summary.years], []);
	assert.equal(summary.total, null);
}

{
	// startYear — same manager-declared floor Results respects, applied here
	// too so Total never includes a payout for a year that was never this
	// manager's finish to begin with.
	const league = { name: 'G', startYear: '2023', dues: 50, payout1: 500, results: [
		{ year: '2021', rank: 1, total: 10 }, // not this manager's, even though it's a 1st
		{ year: '2023', rank: 1, total: 10 },
	] };
	const summary = domCtx.leagueFinancesSummary(league);
	assert.deepEqual([...summary.years].map((y) => y.year), ['2023']);
	assert.equal(summary.total, 450, 'only the 2023 win counts toward Total, not the excluded 2021 one');
}

// ---- leagueFinancesSummary: weekly/season high-score payouts -----------------

{
	// A year with scoring data: this franchise won the weekly high once,
	// another franchise won the season high — only the weekly-high payout
	// should land, for the one week actually won.
	const league = {
		name: 'G', franchiseId: '0001', dues: 0, payoutWeeklyHigh: 25, payoutSeasonHigh: 50,
		results: [{
			year: '2024', rank: 5, total: 10,
			scoring: {
				weeklyHighs: [
					{ franchiseId: '0002', teamName: 'Theirs', week: 3, points: 160 },
					{ franchiseId: '0001', teamName: 'Mine', week: 7, points: 178.4 },
				],
				seasonHigh: { franchiseId: '0002', teamName: 'Theirs', points: 2100 },
			},
		}],
	};
	const summary = domCtx.leagueFinancesSummary(league);
	const y = summary.years[0];
	assert.equal(y.won, 25, 'only the one week this franchise actually won, not every week in the array');
	assert.deepEqual(plain(y.breakdown), [{ label: 'Weekly High (Wk 7)', amount: 25 }]);
}

{
	// The SAME franchise wins the weekly high THREE separate weeks in one
	// season — the normal shape of this award, not an edge case — plus the
	// season high and a top-3 finish. All amounts stack; the breakdown gets
	// one row per week won, in the order the weeks appear in the array
	// (which computeSeasonScoringRecords already sorts by week).
	const league = {
		name: 'H', franchiseId: '0001', dues: 0, payout2: 200, payoutWeeklyHigh: 25, payoutSeasonHigh: 50,
		results: [{
			year: '2024', rank: 2, total: 10,
			scoring: {
				weeklyHighs: [
					{ franchiseId: '0001', teamName: 'Mine', week: 3, points: 190 },
					{ franchiseId: '0002', teamName: 'Theirs', week: 4, points: 145 },
					{ franchiseId: '0001', teamName: 'Mine', week: 9, points: 200 },
					{ franchiseId: '0001', teamName: 'Mine', week: 12, points: 175 },
				],
				seasonHigh: { franchiseId: '0001', teamName: 'Mine', points: 2300 },
			},
		}],
	};
	const summary = domCtx.leagueFinancesSummary(league);
	const y = summary.years[0];
	assert.equal(y.won, 200 + 25 * 3 + 50, 'weekly-high payout sums once per week this franchise won');
	assert.deepEqual(plain(y.breakdown), [
		{ label: '2nd', amount: 200 },
		{ label: 'Weekly High (Wk 3)', amount: 25 },
		{ label: 'Weekly High (Wk 9)', amount: 25 },
		{ label: 'Weekly High (Wk 12)', amount: 25 },
		{ label: 'Season High', amount: 50 },
	]);
}

{
	// scoring present but the payout fields aren't entered — reads as $0,
	// same as an unentered placement payout, never a crash or "unknown".
	const league = {
		name: 'I', franchiseId: '0001', results: [{
			year: '2024', rank: 9, total: 10,
			scoring: { weeklyHighs: [{ franchiseId: '0001', teamName: 'Mine', week: 2, points: 150 }], seasonHigh: null },
		}],
	};
	const summary = domCtx.leagueFinancesSummary(league);
	assert.equal(summary.years[0].won, 0);
	assert.deepEqual([...summary.years[0].breakdown], []);
}

{
	// A year with no `scoring` field at all (not yet backfilled) is
	// indistinguishable from "didn't win it" — deliberately, per the config
	// schema note — and never throws on the missing field.
	const league = { name: 'J', franchiseId: '0001', payoutWeeklyHigh: 25, results: [
		{ year: '2024', rank: 4, total: 10 },
	] };
	const summary = domCtx.leagueFinancesSummary(league);
	assert.equal(summary.years[0].won, 0);
}

// ---- renderFinancesCard -------------------------------------------------------

{
	const leagues = [
		{ id: 'D', name: 'League D', type: 'dynasty' }, // no results at all
		{ id: 'A', name: 'League A', type: 'dynasty', dues: 100, payout1: 500, payout2: 250, results: [
			{ year: '2024', rank: 1, total: 10 },
			{ year: '2025', rank: 2, total: 10 },
		] }, // total: 400 + 150 = 550
		{ id: 'B', name: 'League B', type: 'salarycap', dues: 100, payout1: 500, results: [
			{ year: '2024', rank: 8, total: 10 }, // outside the top 3 — a real $0, not unknown
			{ year: '2025', rank: 1, total: 10 },
		] }, // total: -100 + 400 = 300
		{ id: 'C', name: 'League C', type: 'salarycap', dues: 200, payout3: 0, results: [
			{ year: '2024', rank: 3, total: 10 },
		] }, // total: 0 - 200 = -200, a loss
	];

	const card = domCtx.renderFinancesCard('dynasty', ['dynasty', 'salarycap'], leagues);
	assert.notEqual(card, null);

	const labels = findAll(card, (c) => c.cls.includes('group-label')).map(fullText);
	assert.deepEqual(labels, ['League A', 'League B', 'League C', 'League D'],
		'best (highest) total first — A: 550, B: 300, C: -200 — then the league with no total at all');

	const cardHead = findAll(card, (c) => c.cls.includes('card-head'))[0];
	assert.equal(fullText(findAll(cardHead, (c) => c.tag === 'h2')[0]), 'Finances');
	const overall = findAll(cardHead, (c) => c.cls.includes('finances-total'))[0];
	assert.equal(fullText(overall), 'Total $650', '550 + 300 + (-200) across the three leagues with a total');
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

	// League D: no results at all — a named message, not a silent drop.
	assert.equal(totalSpanOf('League D'), undefined, 'nothing to total, so no figure at all');
	const errorBoxes = findAll(card, (c) => c.cls.includes('error-box'));
	assert.equal(errorBoxes.length, 1);
	assert.ok(fullText(errorBoxes[0]).includes('No financial data yet'));

	// League B's table: 2024 (outside the top 3) shows a real $0 Won and a
	// real negative Total — never a dash — and 2025 shows the real payout.
	const tables = findAll(card, (c) => c.tag === 'table');
	const rowsOf = (table) => findAll(table, (c) => c.tag === 'tr');
	const headerOf = (table) => rowsOf(table)[0];
	assert.deepEqual(findAll(headerOf(tables[0]), (c) => c.tag === 'th').map(fullText), ['Year', 'Dues', 'Won', 'Total']);

	const tableB = tables[1];
	const bRows = rowsOf(tableB);
	const rowFor = (year) => bRows.find((r) => fullText(r.children[0]) === year);
	const row2024 = rowFor('2024');
	// Outside the top 3: no payout field to look up, so nothing to explain
	// — a bare $0 as plain text, not a button with an empty popover.
	assert.deepEqual(row2024.children.map(fullText), ['2024', '-$100', '$0', '-$100']);
	assert.equal(findAll(row2024.children[2], (c) => c.tag === 'button').length, 0, 'no breakdown, no button');
	assert.ok(row2024.children[3].cls.includes('finances-negative'), 'an entry fee paid against nothing won is a real loss');
	const row2025 = rowFor('2025');
	// A real payout ($500, 1st) turns the Won cell into a button rather than
	// spelling the reason out inline — the reason lives in the popover.
	assert.deepEqual(row2025.children.map(fullText), ['2025', '-$100', '$500', '$400']);
	const wonBtn2025 = findAll(row2025.children[2], (c) => c.tag === 'button')[0];
	assert.equal(wonBtn2025.cls, 'finances-link');
	assert.ok(!row2025.children[2].cls, 'the <td> itself carries no class — only its button does');
	assert.ok(row2025.children[3].cls.includes('finances-positive'));
	assert.ok(!row2025.children[3].cls.includes('finances-negative'));

	// Clicking the button opens a popover naming the finish behind the
	// amount; clicking again (the same toggle idiom .salary-link uses)
	// closes it rather than opening a second one.
	wonBtn2025.click();
	const popover = domCtx.document.body.children.find((c) => c.cls.includes('finances-popover'));
	assert.ok(popover, 'a shared popover instance is appended to <body>');
	assert.ok(!popover.cls.includes('hidden'), 'visible after the first click');
	assert.equal(fullText(findAll(popover, (c) => c.cls.includes('finances-popover-title'))[0]), '2025 — Won Breakdown');
	const rows = findAll(popover, (c) => c.cls.includes('finances-popover-row'));
	assert.equal(rows.length, 1);
	assert.deepEqual(rows[0].children.map(fullText), ['1st', '$500']);
	wonBtn2025.click();
	assert.ok(popover.cls.includes('hidden'), 'a second click on the same button closes it again');

	// League A: both a 1st ($500) and a 2nd ($250) place finish, each its
	// own button — plain $ text only for a year with nothing to explain.
	const tableA = tables[0];
	const aRows = rowsOf(tableA);
	const aRowFor = (year) => aRows.find((r) => fullText(r.children[0]) === year);
	assert.equal(fullText(aRowFor('2024').children[2]), '$500');
	assert.ok(findAll(aRowFor('2024').children[2], (c) => c.tag === 'button').length, '2024 (1st) is a button');
	assert.equal(fullText(aRowFor('2025').children[2]), '$250');
	assert.ok(findAll(aRowFor('2025').children[2], (c) => c.tag === 'button').length, '2025 (2nd) is a button too');

	// League C's single row: a real, known $0 payout against real dues is a
	// real, known loss — flagged in the table the same way it is in the head.
	// Rank 3 (top 3) but a configured $0 payout: no breakdown, since a $0
	// payout has nothing worth explaining — plain "$0", not a button.
	const tableC = tables[2];
	const rowC = rowsOf(tableC)[1];
	assert.deepEqual(rowC.children.map(fullText), ['2024', '-$200', '$0', '-$200']);
	assert.equal(findAll(rowC.children[2], (c) => c.tag === 'button').length, 0);
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

// A placement payout and a weekly-high payout landing the same year both add
// into Won, and the popover names both reasons, place first, each its own row.
{
	const leagues = [
		{ id: 'A', name: 'League A', type: 'dynasty', franchiseId: '0001', dues: 50, payout1: 500, payoutWeeklyHigh: 25, results: [
			{ year: '2024', rank: 1, total: 10, scoring: {
				weeklyHighs: [{ franchiseId: '0001', teamName: 'Mine', week: 6, points: 180 }], seasonHigh: null,
			} },
		] },
	];
	const card = domCtx.renderFinancesCard('dynasty', ['dynasty'], leagues);
	const table = findAll(card, (c) => c.tag === 'table')[0];
	const dataRow = findAll(table, (c) => c.tag === 'tr')[1];
	assert.equal(fullText(dataRow.children[2]), '$525', 'Won: $500 place + $25 weekly high, summed');
	const btn = findAll(dataRow.children[2], (c) => c.tag === 'button')[0];
	btn.click();
	const popover = domCtx.document.body.children.find((c) => c.cls.includes('finances-popover'));
	const rows = findAll(popover, (c) => c.cls.includes('finances-popover-row'));
	assert.deepEqual(rows.map((r) => r.children.map(fullText)), [
		['1st', '$500'],
		['Weekly High (Wk 6)', '$25'],
	], 'both contributing reasons in the popover, place first');
}

// The live-synced leagueName wins over config's own static name, same as
// every other card on the page — this mattered for real: both ESPN
// leagues in production carry a generic config name ("ESPN League 1")
// that isn't what their commissioners actually named them.
{
	const leagues = [{ id: 'G', name: 'ESPN League 1', leagueName: 'Lincoln Hates Fantasy', type: 'redraft', results: [
		{ year: '2025', rank: 1, total: 10 },
	] }];
	const card = domCtx.renderFinancesCard('redraft', ['redraft'], leagues);
	const label = findAll(card, (c) => c.cls.includes('group-label')).map(fullText)[0];
	assert.equal(label, 'Lincoln Hates Fantasy');
}

console.log('test-finances-card: all assertions passed');
