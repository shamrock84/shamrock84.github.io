// Unit test for myMatchupLine and its wiring into renderScoringCard in
// myffl.html — the one-line "My Team 24.50 – Rival 19.80" subtitle that
// stays visible when a Scoring card is collapsed (see the .team.card-
// collapse-visible convention documented above renderScoringCard's own
// "Week N" line). The point of the feature is exactly this: collapsing a
// card is how a manager gets seventeen OTHER leagues' matchups out of the
// way, and the one matchup they actually care about must not disappear
// along with everyone else's.
//
// Every case pinned here is a way that line could either say nothing when
// it should, or say something misleading:
//   - no "me" team at all (a league this login doesn't own a franchise in)
//     must return null rather than picking an arbitrary team;
//   - a real two-team matchup shows both sides;
//   - a bye (my own matchup entry has no resolvable second team) and a
//     flat leaderboard (no matchups field at all, an older cached sync)
//     both fall back to just my own score rather than inventing an
//     opponent or crashing;
//   - renderScoringCard actually appends the line as .team.card-collapse-
//     visible, right after the Week line and before the full matchup pills
//     — the class is what the collapse-rule keys off, so a plain div here
//     would silently vanish along with everything else the moment the card
//     is collapsed.

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

const { myMatchupLine } = domCtx;

// ---- myMatchupLine as a pure function --------------------------------

{
	const league = { scoring: { teams: [{ franchiseId: '1', teamName: 'Team One', score: '10.0' }] } };
	assert.equal(myMatchupLine(league), null, 'no isMe team: nothing to say');
}

{
	const league = {
		scoring: {
			teams: [
				{ franchiseId: '1', teamName: 'My Team', score: '24.50', isMe: true },
				{ franchiseId: '2', teamName: 'Rival', score: '19.80' },
			],
			matchups: [{ teamIds: ['1', '2'] }],
		},
	};
	assert.equal(myMatchupLine(league), 'My Team 24.50 – Rival 19.80', 'a real two-team matchup names both sides');
}

{
	// A bye: my own matchup entry carries only my own id, so there's no
	// second team to resolve.
	const league = {
		scoring: {
			teams: [{ franchiseId: '1', teamName: 'My Team', score: '0.00', isMe: true }],
			matchups: [{ teamIds: ['1'] }],
		},
	};
	assert.equal(myMatchupLine(league), 'My Team 0.00', 'a bye falls back to just my own score');
}

{
	// No matchups field at all — the flat-leaderboard fallback for an older
	// cached sync (see renderScoringCard's own comment on that branch).
	const league = {
		scoring: {
			teams: [
				{ franchiseId: '1', teamName: 'My Team', score: '15.00', isMe: true },
				{ franchiseId: '2', teamName: 'Someone Else', score: '22.00' },
			],
		},
	};
	assert.equal(myMatchupLine(league), 'My Team 15.00', 'no matchup pairing at all: just my own score, no invented opponent');
}

{
	// The owner-name convention rides along unchanged (teamNameWithOwner).
	const league = {
		scoring: {
			teams: [
				{ franchiseId: '1', teamName: 'My Team', ownerName: 'Rick', score: '24.50', isMe: true },
				{ franchiseId: '2', teamName: 'Rival', ownerName: null, score: '19.80' },
			],
			matchups: [{ teamIds: ['1', '2'] }],
		},
	};
	assert.equal(myMatchupLine(league), 'My Team (Rick) 24.50 – Rival 19.80');
}

// ---- Wired into renderScoringCard as a collapse-visible subtitle ------

function findAll(n, pred, out = []) {
	if (!n || !n.children) return out;
	for (const c of n.children) {
		if (pred(c)) out.push(c);
		findAll(c, pred, out);
	}
	return out;
}

{
	const league = {
		id: 'L1', name: 'League One', type: 'redraft',
		scoring: {
			week: '1',
			teams: [
				{ franchiseId: '1', teamName: 'My Team', score: '24.50', isMe: true },
				{ franchiseId: '2', teamName: 'Rival', score: '19.80' },
			],
			matchups: [{ teamIds: ['1', '2'] }],
		},
	};
	const card = domCtx.renderScoringCard(league);
	const teamLines = card.children.filter((c) => c.cls.split(/\s+/).includes('team'));
	assert.deepEqual(teamLines.map((c) => c._text), ['Week 1', 'My Team 24.50 – Rival 19.80'], 'the matchup subtitle follows the Week line');
	for (const line of teamLines) {
		assert.ok(line.cls.split(/\s+/).includes('card-collapse-visible'), 'every subtitle line survives a collapse');
	}
	// It must appear before the full pill stack in DOM order too, not just
	// exist somewhere in the card — the collapse rule doesn't care about
	// order, but a reader skimming the expanded card does.
	const pillsIndex = card.children.findIndex((c) => c.cls.split(/\s+/).includes('scoring-matchup-pills'));
	const myLineIndex = card.children.indexOf(teamLines[1]);
	assert.ok(myLineIndex < pillsIndex, 'the subtitle renders above the full matchup pills');
}

{
	// No isMe team at all: renderScoringCard must not append a bogus second
	// .team line.
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
	const teamLines = card.children.filter((c) => c.cls.split(/\s+/).includes('team'));
	assert.deepEqual(teamLines.map((c) => c._text), ['Week 1'], 'no my-matchup line when nobody is flagged isMe');
}

console.log('test-scoring-my-matchup-line.mjs OK');
