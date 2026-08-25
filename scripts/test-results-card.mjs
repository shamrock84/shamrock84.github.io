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
// relative order (a stable sort, not an arbitrary one). The Finish cell is
// rank/total only — payout amounts used to be named here too, but the
// Finances card already covers payouts, so this card stays a pure
// record of finish, with a popover the idiom to reach for if the amount
// is ever wanted back.

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
	// League C and D have no backfilled years at all — with the "at least
	// one year of history" gate, they don't get a row (not even one saying
	// "still gathering data"), they simply aren't in the card. Leagues A and
	// B span two different types (dynasty and salarycap) and are combined
	// into the one card without any type filtering — History doesn't split
	// by league type the way every other tab does.
	const leagues = [
		{ id: 'C', name: 'League C', type: 'dynasty' }, // no results at all
		{ id: 'A', name: 'League A', type: 'dynasty', provider: 'espn', results: [
			{ year: '2023', rank: 3, total: 12, guessed: false },
			{ year: '2024', rank: 7, total: 12, guessed: false },
			{ year: '2025', rank: 1, total: 12, guessed: false },
		] },
		{ id: 'D', name: 'League D', type: 'draftonly', results: [] }, // explicitly empty, same as C
		{ id: 'B', name: 'League B', type: 'salarycap', results: [
			{ year: '2024', rank: 8, total: 10, guessed: true },
			{ year: '2025', rank: 2, total: 10, guessed: false },
		] },
	];

	const card = domCtx.renderResultsCard(leagues);
	assert.notEqual(card, null);

	const labels = findAll(card, (c) => c.cls.includes('group-label')).map(fullText);
	assert.deepEqual(labels, ['League A', 'League B'],
		'best average first (A: 3.67, B: 5.0) — leagues C and D have no history and are not listed at all');

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

	// Each league name carries exactly two badges underneath it — provider
	// and type, the same two-badge subset historyBadgesNode builds for both
	// History cards — never the full Rosters-card strip (season, tags).
	const nameCols = findAll(card, (c) => c.cls.includes('results-league-name'));
	assert.equal(nameCols.length, 2, 'one per shown league');
	const badgeTextsOf = (nameCol) => findAll(nameCol, (c) => c.cls.split(/\s+/).includes('badge')).map(fullText);
	assert.deepEqual(badgeTextsOf(nameCols[0]), ['ESPN', 'Dynasty'], 'League A: its own provider, then its type');
	assert.deepEqual(badgeTextsOf(nameCols[1]), ['MFL', 'Salary Cap'], 'League B: provider defaults to MFL when unset');
	const providerBadge = findAll(nameCols[0], (c) => c.cls.includes('badge-provider'))[0];
	assert.ok(providerBadge, 'the provider badge carries the gold badge-provider class, same as on the Rosters cards');
	assert.equal(fullText(providerBadge), 'ESPN');

	// League A's table: rows most-recent-first, no average row mixed in.
	const tables = findAll(card, (c) => c.tag === 'table');
	const rowsOf = (table) => findAll(table, (c) => c.tag === 'tr');
	const [tableA, tableB] = tables;

	const aRows = rowsOf(tableA);
	assert.equal(aRows.length, 4, 'header row plus 3 year rows only');
	assert.deepEqual(aRows.slice(1, 4).map((r) => fullText(r.children[0])), ['2025', '2024', '2023']);
	assert.deepEqual(aRows.slice(1, 4).map((r) => fullText(r.children[1])), ['1/12', '7/12', '3/12'],
		'the Finish cell is rank/total only — no dollar amount, that\'s the Finances card\'s job');

	// League B: the guessed year's Finish cell is flagged, the confirmed
	// year's is not — this isn't a blanket style on the whole row or table.
	const bRows = rowsOf(tableB);
	const finishCellOf = (year) => bRows.find((r) => fullText(r.children[0]) === year)?.children[1];
	assert.ok(finishCellOf('2024').cls.includes('results-guessed'), 'the guessed 2024 finish is flagged');
	assert.ok(!finishCellOf('2025').cls.includes('results-guessed'), 'the confirmed 2025 finish is not');
	assert.equal(fullText(finishCellOf('2024')), '8/10');
	assert.equal(fullText(finishCellOf('2025')), '2/10');

	// Leagues C and D have no backfilled years — they're excluded from the
	// card entirely, no error-box row standing in for them.
	assert.equal(findAll(card, (c) => c.cls.includes('error-box')).length, 0);

	// No league anywhere has a backfilled year: no card at all, the same way
	// every other Analytics/History card behaves when there's nothing to show.
	const noHistory = [
		{ id: 'X', name: 'League X', type: 'dynasty' },
		{ id: 'Y', name: 'League Y', type: 'redraft', results: [] },
	];
	assert.equal(domCtx.renderResultsCard(noHistory), null);
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
	const card = domCtx.renderResultsCard(leagues);
	const label = findAll(card, (c) => c.cls.includes('group-label')).map(fullText)[0];
	assert.equal(label, 'Lincoln Hates Fantasy');
}

// A league with a backfilled year but no resolvable rank on it (still
// passes the "at least one year of history" gate — it has a year, just not
// a ranked one) gets no average, and when it's the only league in the card
// the card-head carries no overall figure either — an empty mean would be
// worse than no number at all.
{
	const leagues = [
		{ id: 'F', name: 'League F', type: 'dynasty', results: [{ year: '2024', total: 10, guessed: true }] },
	];
	const card = domCtx.renderResultsCard(leagues);
	assert.notEqual(card, null, 'still shown — it has a year, even without a resolvable rank');
	const cardHead = findAll(card, (c) => c.cls.includes('card-head'))[0];
	assert.equal(findAll(cardHead, (c) => c.cls.includes('results-avg')).length, 0,
		'no leagues have an average, so the card-head carries none either');
}

console.log('test-results-card: all assertions passed');
