// Unit test for renderScoringCard's matchup ordering in myffl.html.
//
// The Scoring tab groups teams into head-to-head pills (see the comment
// above renderScoringCard's `matchups` block for why). This pins that the
// pill containing the logged-in manager's own team (t.isMe) always renders
// first, while every other pill keeps the provider's original relative
// order behind it — a plain re-sort by score or name would scramble that
// order for no reason, and Array#sort's stability is what this test would
// catch a regression in.

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

// My team (franchiseId '3') sits in the third of four matchups. It must
// render first; the other three keep their original relative order (1v2,
// then 5v6, then 7v8) behind it.
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
				{ franchiseId: '5', teamName: 'Team Five', score: '50.0' },
				{ franchiseId: '6', teamName: 'Team Six', score: '60.0' },
				{ franchiseId: '7', teamName: 'Team Seven', score: '70.0' },
				{ franchiseId: '8', teamName: 'Team Eight', score: '80.0' },
			],
			matchups: [
				{ teamIds: ['1', '2'] },
				{ teamIds: ['5', '6'] },
				{ teamIds: ['3', '4'] },
				{ teamIds: ['7', '8'] },
			],
		},
	};

	const card = domCtx.renderScoringCard(league);
	const pills = findAll(card, (c) => c.cls.split(/\s+/).includes('scoring-matchup-pill'));
	assert.equal(pills.length, 4);

	const namesOf = (pill) => findAll(pill, (c) => c.cls.split(/\s+/).includes('scoring-matchup-name')).map(fullText);
	assert.deepEqual(namesOf(pills[0]), ['Team Four', 'My Team'], 'the pill holding my team renders first (rows within a pill sort by score, highest first)');
	assert.deepEqual(namesOf(pills[1]), ['Team Two', 'Team One'], 'then the remaining pills in their original order (1v2)');
	assert.deepEqual(namesOf(pills[2]), ['Team Six', 'Team Five'], '...then 5v6...');
	assert.deepEqual(namesOf(pills[3]), ['Team Eight', 'Team Seven'], '...then 7v8, last as before');
}

// No team in the league is flagged isMe (a logged-out viewer, or a league
// with no known franchise id) — every pill's relative order is preserved,
// since there's nothing to promote.
{
	const league = {
		id: 'L2', name: 'League Two', type: 'redraft',
		scoring: {
			week: '1',
			teams: [
				{ franchiseId: '1', teamName: 'Team One', score: '10.0' },
				{ franchiseId: '2', teamName: 'Team Two', score: '20.0' },
				{ franchiseId: '3', teamName: 'Team Three', score: '30.0' },
				{ franchiseId: '4', teamName: 'Team Four', score: '40.0' },
			],
			matchups: [
				{ teamIds: ['3', '4'] },
				{ teamIds: ['1', '2'] },
			],
		},
	};

	const card = domCtx.renderScoringCard(league);
	const pills = findAll(card, (c) => c.cls.split(/\s+/).includes('scoring-matchup-pill'));
	const namesOf = (pill) => findAll(pill, (c) => c.cls.split(/\s+/).includes('scoring-matchup-name')).map(fullText);
	assert.deepEqual(namesOf(pills[0]), ['Team Four', 'Team Three'], 'unchanged order when nobody is flagged isMe');
	assert.deepEqual(namesOf(pills[1]), ['Team Two', 'Team One']);
}

console.log('test-scoring-matchup-order.mjs OK');
