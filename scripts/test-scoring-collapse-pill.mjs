// Unit test for renderScoringCard's collapse behavior in myffl.html —
// collapsing a Scoring card is how a manager gets every OTHER league's
// matchups out of the way, and it must not take their own game down with
// it. Two markers make that work together (see the CSS rule beside
// .scoring-matchup-pill and the .card.card-collapsed > *:not(...) rule near
// the top of the file):
//   - .scoring-matchup-pills itself carries .card-collapse-visible, so the
//     whole wrapper isn't blanket-hidden the way .scoring-matchup-header is;
//   - the one pill holding the isMe team additionally carries .me-matchup,
//     which is what a nested collapse rule keys off to hide every OTHER
//     pill specifically while the card is collapsed.
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
		scoring: {
			week: '1',
			teams: [
				{ franchiseId: '1', teamName: 'Team One', score: '10.0' },
				{ franchiseId: '2', teamName: 'Team Two', score: '20.0' },
				{ franchiseId: '3', teamName: 'My Team', score: '30.0', isMe: true },
				{ franchiseId: '4', teamName: 'Team Four', score: '40.0' },
			],
			matchups: [
				{ teamIds: ['1', '2'] },
				{ teamIds: ['3', '4'] },
			],
		},
	};

	const card = domCtx.renderScoringCard(league);

	const pillsWrap = findAll(card, (c) => classes(c).includes('scoring-matchup-pills'))[0];
	assert.ok(pillsWrap, 'the pills wrapper exists');
	assert.ok(classes(pillsWrap).includes('card-collapse-visible'), 'the wrapper itself is exempt from the blanket collapse rule');

	const pills = findAll(card, (c) => classes(c).includes('scoring-matchup-pill'));
	assert.equal(pills.length, 2);
	const meMarked = pills.filter((p) => classes(p).includes('me-matchup'));
	assert.equal(meMarked.length, 1, 'exactly one pill is marked as mine');
	assert.ok(findAll(meMarked[0], (c) => classes(c).includes('me-row')).length > 0, 'the marked pill is the one actually holding the isMe row');

	const otherPill = pills.find((p) => p !== meMarked[0]);
	assert.ok(!classes(otherPill).includes('me-matchup'), "the other league's pill is not marked");
}

{
	// Nobody flagged isMe (a logged-out viewer, or a league this login
	// doesn't hold a franchise in) — no pill should claim to be mine.
	const league = {
		id: 'L2', name: 'League Two', type: 'redraft',
		scoring: {
			week: '1',
			teams: [
				{ franchiseId: '1', teamName: 'Team One', score: '10.0' },
				{ franchiseId: '2', teamName: 'Team Two', score: '20.0' },
			],
			matchups: [{ teamIds: ['1', '2'] }],
		},
	};
	const card = domCtx.renderScoringCard(league);
	const pills = findAll(card, (c) => classes(c).includes('scoring-matchup-pill'));
	assert.equal(pills.filter((p) => classes(p).includes('me-matchup')).length, 0, 'no pill is marked mine when nobody is isMe');
}

console.log('test-scoring-collapse-pill.mjs OK');
