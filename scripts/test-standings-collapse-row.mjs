// Unit test for renderStandingsCard's collapse behavior in myffl.html —
// collapsing a Standings card is how a manager gets every OTHER team's row
// out of the way, and it must not blank out their own team's row (or the
// header labeling it) too. Three markers make that work together (see the
// CSS rule beside .me-row and the .card.card-collapsed > *:not(...) rule
// near the top of the file):
//   - the table itself carries .card-collapse-visible, so it isn't
//     blanket-hidden the way an ungated table would be;
//   - the header row carries .standings-head-row, so the "#"/"Team"/"W-L"
//     column labels stay on screen giving the isMe row context;
//   - the [data-view="standings"] scoping on the nested collapse rule keeps
//     it from also catching Scoring's own fallback .standings table, which
//     has nothing marking it .card-collapse-visible and so must stay fully
//     hidden when collapsed, same as before this change.
// This only pins the DOM/class wiring (no CSS engine runs in the vm here);
// the actual hide/show behavior under a real stylesheet was checked by hand
// in a headless browser.

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
function classes(node) {
	return node.cls.trim().split(/\s+/).filter(Boolean);
}

{
	const league = {
		id: 'L1', name: 'League One', type: 'redraft',
		standings: [
			{ franchiseId: '1', teamName: 'Team One', wins: 3, losses: 1, pointsFor: '100.0', pointsAgainst: '90.0' },
			{ franchiseId: '2', teamName: 'My Team', wins: 2, losses: 2, pointsFor: '95.0', pointsAgainst: '92.0', isMe: true },
			{ franchiseId: '3', teamName: 'Team Three', wins: 1, losses: 3, pointsFor: '80.0', pointsAgainst: '99.0' },
		],
	};

	const card = domCtx.renderStandingsCard(league);
	assert.equal(card.attrs['data-view'], 'standings');

	const table = findAll(card, (c) => classes(c).includes('standings'))[0];
	assert.ok(table, 'the table exists');
	assert.ok(classes(table).includes('card-collapse-visible'), 'the table itself is exempt from the blanket collapse rule');

	const rows = table.children.filter((c) => c.tag === 'tr');
	// header row + 3 team rows
	assert.equal(rows.length, 4);
	const meMarked = rows.filter((r) => classes(r).includes('me-row'));
	assert.equal(meMarked.length, 1, 'exactly one row is marked as mine');
	assert.ok(classes(rows[0]).includes('standings-head-row'), 'the header row is marked so it stays visible alongside the isMe row when collapsed');
	assert.ok(!classes(rows[0]).includes('me-row'), 'the header row is not itself marked as mine');
}

{
	// Nobody flagged isMe (a logged-out viewer, or a league this login
	// doesn't hold a franchise in) — no row should claim to be mine.
	const league = {
		id: 'L2', name: 'League Two', type: 'redraft',
		standings: [
			{ franchiseId: '1', teamName: 'Team One', wins: 3, losses: 1, pointsFor: '100.0', pointsAgainst: '90.0' },
			{ franchiseId: '2', teamName: 'Team Two', wins: 2, losses: 2, pointsFor: '95.0', pointsAgainst: '92.0' },
		],
	};
	const card = domCtx.renderStandingsCard(league);
	const table = findAll(card, (c) => classes(c).includes('standings'))[0];
	const rows = table.children.filter((c) => c.tag === 'tr');
	assert.equal(rows.filter((r) => classes(r).includes('me-row')).length, 0, 'no row is marked mine when nobody is isMe');
}

console.log('test-standings-collapse-row.mjs OK');
