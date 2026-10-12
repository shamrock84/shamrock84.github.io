// Unit test for the Scoring tab's Monday Night Winner card in myffl.html
// (computeMondayNightWinner / renderMondayNightWinnerCard).
//
// Pinned here:
//   * the card exists only on a Monday inside the NFL season, and only
//     when logged in; any other day it is absent, not empty.
//   * a trailing matchup with a player still to play is listed with the
//     smallest score that strictly beats the gap (a tie is not a win).
//   * a lead is listed only while the opponent has someone left.
//   * decided matchups drop: trailing with nobody left, leading with the
//     opponent done, draft-only leagues, byes (no game in the map).
//   * "remaining" means the game is pre or in progress.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { resolveBackup } from '../api/_lib/gametime.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(root, 'myffl.html'), 'utf8');
const scriptSource = html.match(/<script>([\s\S]*)<\/script>/)[1];

function domNode(tag = 'div') {
	const n = {
		tag, children: [], attrs: {}, cls: '', _text: '', dataset: {}, style: {}, listeners: {},
		hidden: false,
		classList: {
			add(c) { const t = n.cls.trim().split(/\s+/).filter(Boolean); if (!t.includes(c)) n.cls = [...t, c].join(' '); },
			remove(c) { n.cls = n.cls.trim().split(/\s+/).filter((x) => x && x !== c).join(' '); },
			toggle(c, force) {
				const has = n.cls.trim().split(/\s+/).includes(c);
				const want = force === undefined ? !has : force;
				if (want) this.add(c); else this.remove(c);
			},
			contains: (c) => n.cls.trim().split(/\s+/).includes(c),
		},
		addEventListener(type, fn) { (n.listeners[type] = n.listeners[type] || []).push(fn); },
		removeEventListener() {},
		setAttribute(k, v) { n.attrs[k] = v; },
		getAttribute(k) { return n.attrs[k]; },
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
		getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
		offsetWidth: 0,
		offsetHeight: 0,
	};
	return n;
}

function makeContext(seed = {}) {
	const store = new Map(Object.entries(seed));
	const ctx = {
		console,
		localStorage: {
			getItem: (k) => (store.has(k) ? store.get(k) : null),
			setItem(k, v) { store.set(k, String(v)); },
			removeItem(k) { store.delete(k); },
		},
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
		window: { addEventListener() {}, matchMedia: () => ({ matches: false }), innerWidth: 1024 },
		fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
	};
	vm.createContext(ctx);
	vm.runInContext(scriptSource, ctx);
	ctx.__store = store;
	// Past the weekly rollover cutoff unless a test says otherwise, so the
	// suite doesn't fail when it happens to run Tuesday or Wednesday daytime.
	// computeGameTimeWatchlist's defaulted `pastCutoff` and the card's own
	// call both resolve this global binding at call time.
	ctx.pastWeeklyRolloverCutoff = () => true;
	return ctx;
}


const LOGGED_IN = { mflAuthToken: 'test-token' };
const MONDAY = new Date(2026, 9, 12, 12, 0, 0); // local Mon 12 Oct 2026
const TUESDAY = new Date(2026, 9, 13, 12, 0, 0);
const JULY_MONDAY = new Date(2026, 6, 13, 12, 0, 0);
const plain = (x) => JSON.parse(JSON.stringify(x));

function setState(ctx, games, attempted = true) {
	ctx.__g = games;
	ctx.__a = attempted;
	vm.runInContext('liveGames = __g; liveScoringAttempted = __a;', ctx);
}
function findAll(n, pred, out = []) {
	if (!n || !n.children) return out;
	for (const c of n.children) { if (pred(c)) out.push(c); findAll(c, pred, out); }
	return out;
}
function fullText(node) {
	if (!node) return '';
	if (!node.children || node.children.length === 0) return node._text || '';
	return (node._text || '') + node.children.map(fullText).join('');
}

const st = (state) => ({ state, opponent: 'X', isHome: true, kickoff: '2026-10-13T00:15:00Z', detail: null });
const pl = (id, name, team, points) => ({ id, name, team, position: 'WR', points });
function lg(id, mineScore, oppScore, minePlayers, oppPlayers, extra = {}) {
	return {
		id, type: 'dynasty', season: '2026', nickname: `L${id}`, displayName: `League ${id}`,
		scoring: {
			week: 6,
			matchups: [{ teamIds: ['1', '2'] }],
			teams: [
				{ franchiseId: '1', teamName: 'Me', isMe: true, score: mineScore, players: minePlayers, winProb: 30 },
				{ franchiseId: '2', teamName: 'Them', score: oppScore, players: oppPlayers, winProb: 70 },
			],
		},
		...extra,
	};
}
const games = { MIA: st('pre'), NYJ: st('in'), KC: st('post') };

{
	const ctx = makeContext();
	// Trailing 98.40 to 110.00: need 11.61, one player left.
	const l = lg('1', '98.40', '110.00', [pl('a', 'Tyreek Hill', 'MIA', null), pl('b', 'Done Guy', 'KC', 20)], [pl('c', 'Opp Guy', 'NYJ', 5)]);
	const e = ctx.computeMondayNightWinner([l], games);
	assert.equal(e.length, 1);
	assert.equal(e[0].needed, 11.61);
	assert.equal(e[0].myLeft.length, 1);
	assert.equal(e[0].oppLeft.length, 1);
	assert.equal(e[0].oppNeeded, null);
}

{
	const ctx = makeContext();
	// A tie needs one hundredth; a float-noise gap still rounds correctly.
	const tied = lg('1', '100.00', '100.00', [pl('a', 'Tyreek Hill', 'MIA', null)], []);
	assert.equal(ctx.computeMondayNightWinner([tied], games)[0].needed, 0.01);
	const noisy = lg('1', '99.9', '100.0', [pl('a', 'Tyreek Hill', 'MIA', null)], []);
	assert.equal(ctx.computeMondayNightWinner([noisy], games)[0].needed, 0.11);
}

{
	const ctx = makeContext();
	// Leading: listed only while the opponent has a player left.
	const leadOppLeft = lg('1', '120.00', '110.00', [pl('b', 'Done Guy', 'KC', 20)], [pl('c', 'Opp Guy', 'NYJ', 5)]);
	const e = ctx.computeMondayNightWinner([leadOppLeft], games);
	assert.equal(e.length, 1);
	assert.equal(e[0].oppNeeded, 10.01);
	assert.equal(e[0].needed, null);
	const leadClinched = lg('2', '120.00', '110.00', [pl('a', 'Tyreek Hill', 'MIA', null)], [pl('c', 'Opp Guy', 'KC', 5)]);
	assert.equal(ctx.computeMondayNightWinner([leadClinched], games).length, 0);
}

{
	const ctx = makeContext();
	// Trailing with nobody left, bye players, and draft-only all drop.
	const lost = lg('1', '90.00', '110.00', [pl('b', 'Done Guy', 'KC', 20), pl('d', 'Bye Guy', 'BYE', 0)], [pl('c', 'Opp Guy', 'NYJ', 5)]);
	const draft = lg('2', '90.00', '110.00', [pl('a', 'Tyreek Hill', 'MIA', null)], [], { type: 'draftonly' });
	assert.equal(ctx.computeMondayNightWinner([lost, draft], games).length, 0);
}

{
	const ctx = makeContext();
	// Likeliest first.
	const a = lg('1', '98.40', '110.00', [pl('a', 'Tyreek Hill', 'MIA', null)], []);
	const b = lg('2', '105.00', '110.00', [pl('a', 'Tyreek Hill', 'MIA', null)], []);
	b.scoring.teams[0].winProb = 60;
	assert.deepEqual(plain(ctx.computeMondayNightWinner([a, b], games).map((x) => x.league.id)), ['2', '1']);
}

{
	const ctx = makeContext(LOGGED_IN);
	setState(ctx, games);
	const l = lg('1', '98.40', '110.00', [pl('a', 'Tyreek Hill', 'MIA', null), pl('e', 'Jaylen Waddle', 'NYJ', 3)], [pl('c', 'Opp Guy', 'NYJ', 5)]);
	const card = ctx.renderMondayNightWinnerCard([l], MONDAY);
	assert.ok(card, 'renders on a Monday in season');
	const text = fullText(card);
	assert.match(text, /Monday Night Winner/);
	assert.match(text, /Down 11\.60/);
	assert.match(text, /need 11\.61 combined/);
	assert.match(text, /11\.61 alone/);
	assert.match(text, /Opponent still has: /);
	assert.equal(ctx.renderMondayNightWinnerCard([l], TUESDAY), null);
	assert.equal(ctx.renderMondayNightWinnerCard([l], JULY_MONDAY), null);
}

{
	// Logged out: absent. Not yet polled: loading, never "nothing left".
	const out = makeContext();
	setState(out, games);
	assert.equal(out.renderMondayNightWinnerCard([], MONDAY), null);
	const ctx = makeContext(LOGGED_IN);
	setState(ctx, games, false);
	assert.match(fullText(ctx.renderMondayNightWinnerCard([], MONDAY)), /Loading live scores/);
	setState(ctx, games, true);
	const empty = ctx.renderMondayNightWinnerCard([], MONDAY);
	assert.match(fullText(empty), /No matchups left to decide/);
	assert.ok(empty.cls.includes('card-collapsed'));
}

console.log('test-monday-night-winner: ok');
