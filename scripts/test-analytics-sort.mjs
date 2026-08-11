// Unit test for click-to-sort on the Analytics tables — appendAnalyticsTable in
// myffl.html, shared by all three cards.
//
// Unlike the other tests here this one needs a DOM, because the sort state lives
// in the closure a rendered table owns rather than in a pure function. The stub
// below is the smallest thing that can hold a tree and fire a click: enough to
// render a card, find its headers, click them, and read the rows back out. The
// page's own script block is evaluated in a vm as usual, so this drives the real
// implementation rather than a copy of it.
//
// Five decisions are pinned, and each is invisible when wrong — a sort that is
// subtly off still shows a plausible table:
//
//   - the card's own order is a *state*, reachable again on the third click,
//     not something the first click destroys;
//   - ties fall back to that order, so sorting by Pos doesn't scramble players
//     within a position;
//   - an unranked player stays at the bottom in BOTH directions, rather than
//     taking the top row on the reverse click;
//   - Pos sorts in fantasy order rather than alphabetically;
//   - only the columns actually on screen are sortable, so a logged-out
//     visitor has no ECR header to click.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(root, 'myffl.html'), 'utf8');
const scriptSource = html.match(/<script>([\s\S]*)<\/script>/)[1];

function node(tag = 'div') {
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
		// The real renderPage clears the table this way on every draw.
		set innerHTML(v) { if (v === '') n.children.length = 0; },
		get textContent() { return n._text; },
		set textContent(v) { n._text = v; },
		click() { (n.listeners.click || []).forEach((fn) => fn()); },
	};
	return n;
}

function makeContext({ loggedIn = true } = {}) {
	const context = {
		console,
		localStorage: {
			getItem: (k) => (loggedIn && k === 'mflAuthToken' ? 'test-token' : null),
			setItem() {}, removeItem() {},
		},
		setTimeout, clearTimeout, setInterval, clearInterval,
		document: {
			addEventListener() {},
			getElementById: () => node(),
			createElement: (t) => node(t),
			createTextNode: (t) => { const n = node('#text'); n.textContent = t; return n; },
			querySelector: () => null,
			querySelectorAll: () => [],
			visibilityState: 'visible',
			body: node(),
		},
		window: { addEventListener() {} },
		fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
	};
	vm.createContext(context);
	vm.runInContext(scriptSource, context);
	return context;
}

const ctx = makeContext();

function findAll(n, pred, out = []) {
	if (!n || !n.children) return out;
	for (const c of n.children) {
		if (pred(c)) out.push(c);
		findAll(c, pred, out);
	}
	return out;
}

const headers = (card) => findAll(card, (c) => c.tag === 'th');
const headerNamed = (card, label) => headers(card).find((h) => h._text.startsWith(label));
const clickHeader = (card, label) => headerNamed(card, label).click();
// The player name is the first node of the first cell's first line. The rest of
// that line is the NFL team suffix, and the lines under it are the leagues —
// neither of which this test cares about.
const names = (card) =>
	findAll(card, (c) => c.tag === 'tr').slice(1)
		.map((tr) => tr.children[0].children[0].children[0]._text);

function player(name, { pos = 'RB', ecr = 100, leagues = ['A'] } = {}) {
	return { name, position: pos, team: 'BUF', ecr, url: null, leagues, count: leagues.length, exposure: leagues.length * 10 };
}

// A card built straight from rows, bypassing the compute functions so the
// fixtures say exactly what they mean.
function tableOf(rows, opts = {}, context = ctx) {
	const card = context.el('div', { class: 'card' });
	context.appendAnalyticsTable(card, rows, 10, opts);
	return card;
}

// --- The default order is a state you can get back to -------------------------
// This matters most on Injury Exposure, whose default encodes the live/settled
// split. A two-state toggle would strand you in a sort with no way back short of
// reloading the page.
{
	const rows = [player('First', { ecr: 300 }), player('Second', { ecr: 100 }), player('Third', { ecr: 200 })];
	const card = tableOf(rows);
	assert.deepEqual(names(card), ['First', 'Second', 'Third'], 'as the card ordered them');

	clickHeader(card, 'ECR');
	assert.deepEqual(names(card), ['Second', 'Third', 'First'], 'first click: best rank first');
	assert.equal(headerNamed(card, 'ECR').children.map((c) => c._text).join(''), ' ▲');

	clickHeader(card, 'ECR');
	assert.deepEqual(names(card), ['First', 'Third', 'Second'], 'second click: reversed');
	assert.equal(headerNamed(card, 'ECR').children.map((c) => c._text).join(''), ' ▼');

	clickHeader(card, 'ECR');
	assert.deepEqual(names(card), ['First', 'Second', 'Third'], 'third click: back to the card order');
	assert.deepEqual(headerNamed(card, 'ECR').children, [], 'and no arrow, because nothing is sorted');
}

// --- Switching columns starts that column in its own natural direction --------
{
	const rows = [player('A', { pos: 'WR', ecr: 10 }), player('B', { pos: 'QB', ecr: 20 })];
	const card = tableOf(rows);
	clickHeader(card, 'ECR');
	clickHeader(card, 'ECR');
	assert.deepEqual(names(card), ['B', 'A'], 'ECR descending');
	clickHeader(card, 'Pos');
	assert.deepEqual(names(card), ['B', 'A'], 'Pos ascending: QB before WR, not carrying the reversal over');
	assert.deepEqual(headerNamed(card, 'ECR').children, [], 'the old column drops its arrow');
}

// --- Ties keep the card's own order --------------------------------------------
// Without this a Pos sort would scramble players within a position, throwing
// away the exposure ordering that is the reason the card exists.
{
	const rows = [
		player('Most Exposed', { pos: 'RB', leagues: ['A', 'B', 'C'] }),
		player('Middle', { pos: 'RB', leagues: ['A', 'B'] }),
		player('Least', { pos: 'RB', leagues: ['A'] }),
	];
	const card = tableOf(rows);
	clickHeader(card, 'Pos');
	assert.deepEqual(names(card), ['Most Exposed', 'Middle', 'Least'], 'one position, so the card order survives intact');
}

// --- An unranked player stays at the bottom in both directions -----------------
// The obvious treatment — sorting null as a rank worse than everybody — reads
// correctly ascending and then hands him the top row on the reverse click. No
// ECR means the rankings didn't have him, not that he is the worst player alive.
{
	const rows = [player('Ranked Well', { ecr: 5 }), player('Unranked', { ecr: null }), player('Ranked Badly', { ecr: 400 })];
	const card = tableOf(rows);
	clickHeader(card, 'ECR');
	assert.deepEqual(names(card), ['Ranked Well', 'Ranked Badly', 'Unranked'], 'ascending: unranked last');
	clickHeader(card, 'ECR');
	assert.deepEqual(names(card), ['Ranked Badly', 'Ranked Well', 'Unranked'], 'descending: still last');
}

// --- Pos sorts in fantasy order, not alphabetical ------------------------------
// Alphabetical would open with Def and bury the quarterbacks in the middle.
{
	const rows = ['Def', 'PK', 'TE', 'WR', 'RB', 'QB'].map((pos) => player(pos, { pos }));
	const card = tableOf(rows, { pageSize: 10 });
	clickHeader(card, 'Pos');
	assert.deepEqual(names(card), ['QB', 'RB', 'WR', 'TE', 'PK', 'Def']);
}

// --- Sorting returns to page one ------------------------------------------------
// Re-sorting under the reader while leaving them on page 3 shows a page of rows
// with no relationship to the click they just made.
{
	const rows = Array.from({ length: 20 }, (_, i) => player(`P${String(i).padStart(2, '0')}`, { ecr: 500 - i }));
	const card = tableOf(rows, { pageSize: 5 });
	const nextBtn = findAll(card, (c) => c.tag === 'button' && c._text === 'Next')[0];
	nextBtn.click();
	nextBtn.click();
	assert.equal(names(card)[0], 'P10', 'on page 3');
	clickHeader(card, 'ECR');
	assert.equal(names(card)[0], 'P19', 'sorting drops back to page 1, best rank first');
}

// --- Only the columns on screen are sortable -----------------------------------
{
	// Top Available has no Pct column — a percentage of leagues means nothing
	// there — so its two counts are the only way to sort by reach.
	const card = tableOf([player('Free Agent')], { showExposure: false, countHeader: 'Free In', showOwned: true });
	const labels = headers(card).filter((h) => h.cls.includes('sortable')).map((h) => h._text);
	assert.deepEqual(labels, ['Pos', 'ECR', 'Free In', 'Own In']);

	// Logged out, the ECR column isn't rendered at all, so there is nothing to
	// click — even though the card's default order still uses the number.
	const out = makeContext({ loggedIn: false });
	const outCard = tableOf([player('Somebody')], {}, out);
	const outLabels = headers(outCard).filter((h) => h.cls.includes('sortable')).map((h) => h._text);
	assert.deepEqual(outLabels, ['Pos', 'Own In', 'Pct']);
	assert.equal(headerNamed(outCard, 'ECR'), undefined);

	// Every column but the player's name. Sorting a table by the column it is
	// already keyed on says nothing, and the name cell carries the sub-lines
	// too, so there is no single value to sort it by.
	assert.equal(headerNamed(card, 'Player').cls.includes('sortable'), false);
}

// --- The count columns sort by reach --------------------------------------------
{
	// Top Available's shape: the two counts differ, and each sorts on its own
	// number rather than both falling through to the first one.
	const rows = [
		{ ...player('Narrow'), count: 1, ownedCount: 5 },
		{ ...player('Wide'), count: 4, ownedCount: 1 },
		{ ...player('Middle'), count: 2, ownedCount: 3 },
	];
	const card = tableOf(rows, { showExposure: false, countHeader: 'Free In', showOwned: true });
	clickHeader(card, 'Free In');
	assert.deepEqual(names(card), ['Wide', 'Middle', 'Narrow'], 'free in most leagues first');
	clickHeader(card, 'Free In');
	assert.deepEqual(names(card), ['Narrow', 'Middle', 'Wide'], 'and reversed');
	clickHeader(card, 'Own In');
	assert.deepEqual(names(card), ['Narrow', 'Middle', 'Wide'], 'the other count sorts on its own number');
	clickHeader(card, 'Own In');
	assert.deepEqual(names(card), ['Wide', 'Middle', 'Narrow']);
	clickHeader(card, 'Own In');
	assert.deepEqual(names(card), ['Narrow', 'Wide', 'Middle'], 'third click restores the card order');
}
{
	// On the exposure cards the count column and Pct are the same ordering, since
	// exposure is count/total and total is fixed for the whole card. Sortable
	// anyway: the reader clicking the number in front of them shouldn't have to
	// know that.
	const rows = [
		player('Narrow', { leagues: ['A'] }),
		player('Wide', { leagues: ['A', 'B', 'C'] }),
		player('Middle', { leagues: ['A', 'B'] }),
	];
	const byCount = tableOf(rows);
	clickHeader(byCount, 'Own In');
	const byPct = tableOf(rows);
	clickHeader(byPct, 'Pct');
	assert.deepEqual(names(byCount), ['Wide', 'Middle', 'Narrow']);
	assert.deepEqual(names(byCount), names(byPct));
}

// --- The Pct column sorts most-exposed first ------------------------------------
{
	const rows = [
		player('Narrow', { leagues: ['A'] }),
		player('Wide', { leagues: ['A', 'B', 'C'] }),
		player('Middle', { leagues: ['A', 'B'] }),
	];
	const card = tableOf(rows);
	clickHeader(card, 'Pct');
	assert.deepEqual(names(card), ['Wide', 'Middle', 'Narrow']);
	clickHeader(card, 'Pct');
	assert.deepEqual(names(card), ['Narrow', 'Middle', 'Wide']);
}

console.log('analytics sort: all assertions passed');
