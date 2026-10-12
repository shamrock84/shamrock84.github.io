// Unit test for the Scoring tab's Monday Night Mania card in myffl.html
// (computeMondayNightMania / renderMondayNightManiaCard).
//
// Pinned here:
//   * the card exists only on a Monday inside the NFL season, and only
//     when logged in; any other day it is absent, not empty.
//   * a trailing matchup with a player still to play is listed with the
//     smallest score that strictly beats the gap (a tie is not a win).
//   * a lead is listed only while the opponent has someone left.
//   * draft-only leagues and byes (no game in the map) drop; a matchup
//     with one side finished but not 0/100 stays in play and names the
//     other side's players needing NEGATIVE points to flip it.
//   * best-ball leagues (tag BestBall) count bench players as remaining
//     on both sides; other leagues do not.
//   * a lead the opponent cannot touch is "already won" and an
//     unclosable deficit "already lost", listed by nickname at the bottom
//     of the card (also when nothing is left in play).
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
	const e = ctx.computeMondayNightMania([l], games).live;
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
	assert.equal(ctx.computeMondayNightMania([tied], games).live[0].needed, 0.01);
	const noisy = lg('1', '99.9', '100.0', [pl('a', 'Tyreek Hill', 'MIA', null)], []);
	assert.equal(ctx.computeMondayNightMania([noisy], games).live[0].needed, 0.11);
}

{
	const ctx = makeContext();
	// Leading: listed only while the opponent has a player left.
	const leadOppLeft = lg('1', '120.00', '110.00', [pl('b', 'Done Guy', 'KC', 20)], [pl('c', 'Opp Guy', 'NYJ', 5)]);
	const e = ctx.computeMondayNightMania([leadOppLeft], games).live;
	assert.equal(e.length, 1);
	assert.equal(e[0].oppNeeded, 10.01);
	assert.equal(e[0].needed, null);
	const leadClinched = lg('2', '120.00', '110.00', [pl('a', 'Tyreek Hill', 'MIA', null)], [pl('c', 'Opp Guy', 'KC', 5)]);
	// Opponent done but I still have a player: stays in play (not 100%),
	// the risk being only my own player scoring negative.
	assert.equal(ctx.computeMondayNightMania([leadClinched], games).live[0].myRisk, 10.01);
}

{
	const ctx = makeContext();
	// Draft-only drops; trailing with nobody left but the opponent still to
	// play stays in play (winProb 30, not 0), through the opponent going
	// negative. Bye players are not remaining.
	const lost = lg('1', '90.00', '110.00', [pl('b', 'Done Guy', 'KC', 20), pl('d', 'Bye Guy', 'BYE', 0)], [pl('c', 'Opp Guy', 'NYJ', 5)]);
	const draft = lg('2', '90.00', '110.00', [pl('a', 'Tyreek Hill', 'MIA', null)], [], { type: 'draftonly' });
	const r = ctx.computeMondayNightMania([lost, draft], games);
	assert.equal(r.live.length, 1);
	assert.equal(r.live[0].oppMustLose, 20.01);
	assert.equal(r.live[0].myLeft.length, 0);
}

{
	const ctx = makeContext();
	// Likeliest first.
	const a = lg('1', '98.40', '110.00', [pl('a', 'Tyreek Hill', 'MIA', null)], []);
	const b = lg('2', '105.00', '110.00', [pl('a', 'Tyreek Hill', 'MIA', null)], []);
	b.scoring.teams[0].winProb = 60;
	assert.deepEqual(plain(ctx.computeMondayNightMania([a, b], games).live.map((x) => x.league.id)), ['2', '1']);
}

{
	const ctx = makeContext(LOGGED_IN);
	setState(ctx, games);
	const l = lg('1', '98.40', '110.00', [pl('a', 'Tyreek Hill', 'MIA', null), pl('e', 'Jaylen Waddle', 'NYJ', 3)], [pl('c', 'Opp Guy', 'NYJ', 5)]);
	const card = ctx.renderMondayNightManiaCard([l], MONDAY);
	assert.ok(card, 'renders on a Monday in season');
	const text = fullText(card);
	assert.match(text, /Monday Night Mania/);
	assert.match(text, /Down 11\.60/);
	assert.match(text, /need 11\.61 combined/);
	assert.match(text, /11\.61 alone/);
	assert.match(text, /Opponent still has: /);
	assert.equal(ctx.renderMondayNightManiaCard([l], TUESDAY), null);
	assert.equal(ctx.renderMondayNightManiaCard([l], JULY_MONDAY), null);
}

{
	// Logged out: absent. Not yet polled: loading, never "nothing left".
	const out = makeContext();
	setState(out, games);
	assert.equal(out.renderMondayNightManiaCard([], MONDAY), null);
	const ctx = makeContext(LOGGED_IN);
	setState(ctx, games, false);
	assert.match(fullText(ctx.renderMondayNightManiaCard([], MONDAY)), /Loading live scores/);
	setState(ctx, games, true);
	const empty = ctx.renderMondayNightManiaCard([], MONDAY);
	assert.match(fullText(empty), /No matchups left to decide/);
	assert.ok(empty.cls.includes('card-collapsed'));
}

{
	const ctx = makeContext();
	// Best ball: a bench player yet to play keeps a trailing team alive and
	// is flagged; a normal league ignores the same bench player.
	const mk = (extra) => lg('1', '90.00', '110.00', [pl('b', 'Done Guy', 'KC', 20)], [pl('c', 'Opp Guy', 'KC', 5)], extra);
	const bb = mk({ tags: ['BestBall'] });
	bb.scoring.teams[0].bench = [pl('z', 'Bench Guy', 'MIA', null)];
	bb.scoring.teams[1].bench = [pl('y', 'Opp Bench', 'NYJ', null)];
	const r = ctx.computeMondayNightMania([bb], games);
	assert.equal(r.live.length, 1);
	assert.equal(r.live[0].myLeft[0].bench, true);
	assert.equal(r.live[0].oppLeft[0].bench, true);
	const plainLeague = mk({});
	plainLeague.scoring.teams[0].bench = bb.scoring.teams[0].bench;
	plainLeague.scoring.teams[0].winProb = 0;
	const r2 = ctx.computeMondayNightMania([plainLeague], games);
	assert.equal(r2.live.length, 0);
	assert.equal(r2.lost.length, 1);
}

{
	const ctx = makeContext(LOGGED_IN);
	setState(ctx, games);
	const won = lg('1', '120.00', '110.00', [], [pl('c', 'Opp Guy', 'KC', 5)]);
	const lost = lg('2', '90.00', '110.00', [pl('b', 'Done Guy', 'KC', 20)], []);
	const tiedDone = lg('3', '100.00', '100.00', [pl('b', 'Done Guy', 'KC', 20)], []);
	won.scoring.teams[0].winProb = 100;
	lost.scoring.teams[0].winProb = 0;
	const r = ctx.computeMondayNightMania([won, lost, tiedDone], games);
	assert.deepEqual(plain(r.won.map((l) => l.id)), ['1']);
	assert.deepEqual(plain(r.lost.map((l) => l.id)), ['2']);
	assert.equal(r.live.length, 0);
	const text = fullText(ctx.renderMondayNightManiaCard([won, lost, tiedDone], MONDAY));
	assert.match(text, /Already won: L1/);
	assert.match(text, /Already lost: L2/);
	assert.doesNotMatch(text, /L3/);
	// With live matchups too, the summary still closes the card.
	const live = lg('4', '98.40', '110.00', [pl('a', 'Tyreek Hill', 'MIA', null)], []);
	const card = ctx.renderMondayNightManiaCard([live, won, lost], MONDAY);
	assert.match(fullText(card), /need 11\.61 to win[\s\S]*Already won: L1[\s\S]*Already lost: L2/);
}

{
	// With no winProb the scores and unplayed players decide.
	const ctx = makeContext();
	const wonNoWp = lg('w', '120.00', '110.00', [], [pl('c', 'Opp Guy', 'KC', 5)]);
	const lostNoWp = lg('l', '90.00', '110.00', [pl('b', 'Done Guy', 'KC', 20)], []);
	wonNoWp.scoring.teams[0].winProb = null;
	lostNoWp.scoring.teams[0].winProb = null;
	const r = ctx.computeMondayNightMania([wonNoWp, lostNoWp], games);
	assert.deepEqual(plain(r.won.map((l) => l.id)), ['w']);
	assert.deepEqual(plain(r.lost.map((l) => l.id)), ['l']);
}

{
	const ctx = makeContext();
	// The decided call follows winProb: 100 won, 0 lost, even if players
	// look unplayed; anything between stays in play.
	const set = (id, wp, mineLeft = []) => {
		const l = lg(id, '100.00', '90.00', mineLeft, [pl('c', 'Opp Guy', 'NYJ', 5)]);
		l.scoring.teams[0].winProb = wp;
		return l;
	};
	const r = ctx.computeMondayNightMania([set('w', 100), set('l', 0, [pl('a', 'Tyreek Hill', 'MIA', null)]), set('m', 63)], games);
	assert.deepEqual(plain(r.won.map((l) => l.id)), ['w']);
	assert.deepEqual(plain(r.lost.map((l) => l.id)), ['l']);
	assert.deepEqual(plain(r.live.map((e) => e.league.id)), ['m']);
}

{
	const ctx = makeContext(LOGGED_IN);
	setState(ctx, games);
	// 1% and nobody left for me: alive only through the opponent's
	// remaining player scoring negative points, and said so.
	const down = lg('1', '90.00', '100.00', [pl('b', 'Done Guy', 'KC', 20)], [pl('c', 'Opp Guy', 'NYJ', 5)]);
	down.scoring.teams[0].winProb = 1;
	const r = ctx.computeMondayNightMania([down], games);
	assert.equal(r.lost.length, 0);
	assert.equal(r.live.length, 1);
	assert.equal(r.live[0].needed, null);
	assert.equal(r.live[0].oppMustLose, 10.01);
	assert.match(fullText(ctx.renderMondayNightManiaCard([down], MONDAY)), /Down 10\.00 — nobody left to play; need the opponent's remaining player to score −10\.01 or worse/);
	// 99% with the opponent done: lost only if my own player goes negative.
	const up = lg('2', '100.00', '90.00', [pl('a', 'Tyreek Hill', 'MIA', null)], [pl('c', 'Opp Guy', 'KC', 5)]);
	up.scoring.teams[0].winProb = 99;
	const r2 = ctx.computeMondayNightMania([up], games);
	assert.equal(r2.won.length, 0);
	assert.equal(r2.live[0].myRisk, 10.01);
	assert.match(fullText(ctx.renderMondayNightManiaCard([up], MONDAY)), /Up 10\.00 — opponent is done; lost only if your remaining player scores −10\.01 or worse/);
	// A tie with nobody left on either side is neither in play nor decided.
	const dead = lg('3', '100.00', '100.00', [pl('b', 'Done Guy', 'KC', 20)], [pl('c', 'Opp Guy', 'KC', 5)]);
	dead.scoring.teams[0].winProb = 50;
	const r3 = ctx.computeMondayNightMania([dead], games);
	assert.equal(r3.live.length + r3.won.length + r3.lost.length, 0);
}

console.log('test-monday-night-mania: ok');
