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
//   * a player carrying Out (or any settled designation, or a league IR
//     slot) in ANY of my leagues is not playing and is not listed, for me
//     and for an opponent who has him; Doubtful/Questionable stay, badged.
//   * the same card runs as Sunday Night Simmer from 6:30 PM Central Sunday.
//   * each matchup collapses (player rows only; summary, min left and win %
//     stay): auto when win % is above 80 or below 20, and a hand toggle wins.
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
	assert.match(text, /Monday Night Mayhem/);
	assert.match(text, /Down 11\.60/);
	assert.match(text, /Down 11\.60 — score 11\.61 combined to win/);
	assert.doesNotMatch(text, /alone|stay above/);
	assert.match(text, /3\.00 so far/);
	assert.match(text, /Them/);
	assert.match(text, /O\. Guy[\s\S]*5\.00 so far/);
	assert.match(text, /League 1/);
	// "combined" only with several players on the side that must score.
	const one = lg('2', '98.40', '110.00', [pl('a', 'Tyreek Hill', 'MIA', null)], [pl('c', 'Opp Guy', 'NYJ', 5)]);
	assert.match(fullText(ctx.renderMondayNightManiaCard([one], MONDAY)), /Down 11\.60 — score 11\.61 to win/);
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
	assert.match(fullText(card), /score 11\.61 to win[\s\S]*Already won: L1[\s\S]*Already lost: L2/);
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
	assert.match(fullText(ctx.renderMondayNightManiaCard([down], MONDAY)), /Down 10\.00 — you are done; opponent must score −10\.01 or lower for you to win/);
	// 99% with the opponent done: lost only if my own player goes negative.
	const up = lg('2', '100.00', '90.00', [pl('a', 'Tyreek Hill', 'MIA', null)], [pl('c', 'Opp Guy', 'KC', 5)]);
	up.scoring.teams[0].winProb = 99;
	const r2 = ctx.computeMondayNightMania([up], games);
	assert.equal(r2.won.length, 0);
	assert.equal(r2.live[0].myRisk, 10.01);
	assert.match(fullText(ctx.renderMondayNightManiaCard([up], MONDAY)), /Up 10\.00 — opponent is done; score −9\.99 or better to win/);
	// A tie with nobody left on either side is neither in play nor decided.
	const dead = lg('3', '100.00', '100.00', [pl('b', 'Done Guy', 'KC', 20)], [pl('c', 'Opp Guy', 'KC', 5)]);
	dead.scoring.teams[0].winProb = 50;
	const r3 = ctx.computeMondayNightMania([dead], games);
	assert.equal(r3.live.length + r3.won.length + r3.lost.length, 0);
}

{
	const ctx = makeContext(LOGGED_IN);
	setState(ctx, games);
	// A starter who is Out (or IR) is not playing, so he is not "remaining":
	// with him gone I have nobody left and the card says the opponent must
	// go negative. Doubtful and Questionable stay, badged. Opponent players
	// cannot be checked (their roster is not ours) and stay listed.
	const rp = (name, status, extra = {}) => ({ id: name, name, team: 'MIA', position: 'WR', status: 'ROSTER', injuryStatus: status, ...extra });
	const out = lg('1', '90.00', '100.00', [pl('a', 'DJ Moore', 'MIA', null), pl('k', 'Done Guy', 'KC', 20)], [pl('c', 'Opp Guy', 'NYJ', 5)]);
	out.players = [rp('DJ Moore', 'O')];
	const r = ctx.computeMondayNightMania([out], games);
	assert.equal(r.live.length, 1);
	assert.equal(r.live[0].myLeft.length, 0);
	assert.equal(r.live[0].oppMustLose, 10.01);
	const ir = lg('2', '90.00', '100.00', [pl('a', 'DJ Moore', 'MIA', null)], [pl('c', 'Opp Guy', 'NYJ', 5)]);
	ir.players = [rp('DJ Moore', null, { status: 'INJURED_RESERVE' })];
	assert.equal(ctx.computeMondayNightMania([ir], games).live[0].myLeft.length, 0);
	const q = lg('3', '90.00', '100.00', [pl('a', 'DJ Moore', 'MIA', null)], [pl('c', 'Opp Guy', 'NYJ', 5)]);
	q.players = [rp('DJ Moore', 'Q')];
	const e = ctx.computeMondayNightMania([q], games).live[0];
	assert.equal(e.myLeft.length, 1);
	assert.equal(e.myLeft[0].injury, 'Q');
	assert.match(fullText(ctx.renderMondayNightManiaCard([q], MONDAY)), /D\. Moore.*\(Q\)|DJ Moore.*\(Q\)|\(Q\)/);
	// One league's Out designation counts for the same man everywhere (his
	// other leagues' feeds may say nothing), and for an opponent who has him.
	const elsewhere = lg('5', '90.00', '100.00', [pl('a', 'D.J. Moore', 'MIA', null)], [pl('c', 'Opp Guy', 'NYJ', 5), pl('m', 'DJ Moore', 'MIA', null)]);
	elsewhere.players = [];
	const other = lg('6', '1.00', '1.00', [], []);
	other.players = [rp('DJ Moore', 'O')];
	const rr = ctx.computeMondayNightMania([elsewhere, other], games).live.find((x) => x.league.id === '5');
	assert.equal(rr.myLeft.length, 0);
	assert.deepEqual(plain(rr.oppLeft.map((x) => x.name)), ['Opp Guy']);
	const d = lg('4', '90.00', '100.00', [pl('a', 'DJ Moore', 'MIA', null)], [pl('c', 'Opp Guy', 'NYJ', 5)]);
	d.players = [rp('DJ Moore', 'D')];
	assert.equal(ctx.computeMondayNightMania([d], games).live[0].myLeft.length, 1);
}

{
	const ctx = makeContext(LOGGED_IN);
	setState(ctx, games);
	// Best ball: no "bench" wording. A player outside the lineup helps only
	// by outscoring the starter he replaces, by the difference, so the
	// number is the side's own target (here: down 10.00, so 10.01) — never
	// a starter's score. The other side gets the plain line.
	const bbLeague = lg('1', '90.00', '100.00', [pl('s1', 'Starter One', 'KC', 8)], [pl('c', 'Opp Guy', 'NYJ', 5)], { tags: ['BestBall'] });
	bbLeague.scoring.teams[0].bench = [pl('b1', 'Bench One', 'MIA', 3)];
	bbLeague.scoring.teams[1].bench = [pl('ob', 'Opp Bench', 'NYJ', 1)];
	const text = fullText(ctx.renderMondayNightManiaCard([bbLeague], MONDAY));
	assert.doesNotMatch(text, /Bench —|counts only|Already ahead/);
	assert.match(text, /B\. One[\s\S]*Outscore starter by 10\.01/);
	assert.match(text, /O\. Bench[\s\S]*Outscore a starter(?! by)/);
	// Leading: the opponent's bench player needs margin + 0.01; mine is plain.
	const lead = lg('3', '100.00', '90.00', [pl('s1', 'Starter One', 'KC', 8)], [pl('c', 'Opp Guy', 'NYJ', 5)], { tags: ['BestBall'] });
	lead.scoring.teams[0].bench = [pl('b1', 'Bench One', 'MIA', 3)];
	lead.scoring.teams[1].bench = [pl('ob', 'Opp Bench', 'NYJ', 1)];
	const t3 = fullText(ctx.renderMondayNightManiaCard([lead], MONDAY));
	assert.match(t3, /B\. One[\s\S]*Outscore a starter(?! by)/);
	assert.match(t3, /O\. Bench[\s\S]*Outscore starter by 10\.01/);
	// Team sections: mine first, then the opponent, a side with nobody
	// left says so, and the header is the league name.
	const empty = lg('2', '120.00', '110.00', [], [pl('c', 'Opp Guy', 'NYJ', 5)]);
	const t2 = fullText(ctx.renderMondayNightManiaCard([empty], MONDAY));
	assert.match(t2, /League 2[\s\S]*Me[\s\S]*Nobody left to play[\s\S]*Them[\s\S]*O\. Guy/);
}

{
	// "Up X" carries its own green class, like "Down X" carries the red one.
	const ctx = makeContext(LOGGED_IN);
	setState(ctx, games);
	const up = lg('1', '120.00', '110.00', [pl('b', 'Done Guy', 'KC', 20)], [pl('c', 'Opp Guy', 'NYJ', 5)]);
	const down = lg('2', '90.00', '110.00', [pl('a', 'Tyreek Hill', 'MIA', null)], []);
	const card = ctx.renderMondayNightManiaCard([up, down], MONDAY);
	const cls = (c) => findAll(card, (n) => n.cls.split(/\s+/).includes(c)).map(fullText);
	assert.deepEqual(plain(cls('monday-leading')), ['Up 10.00']);
	assert.deepEqual(plain(cls('monday-trailing')), ['Down 20.00']);
}

{
	// Sunday Night Simmer: same card from 6:30 PM Central Sunday, absent before.
	// Instants are UTC so the test doesn't depend on the runner's zone
	// (CDT = UTC-5 in October).
	const ctx = makeContext(LOGGED_IN);
	setState(ctx, games);
	const l = lg('1', '90.00', '100.00', [pl('a', 'Tyreek Hill', 'MIA', null)], []);
	const before = new Date(Date.UTC(2026, 9, 11, 23, 29)); // Sun 6:29 PM CT
	const at = new Date(Date.UTC(2026, 9, 11, 23, 30)); // Sun 6:30 PM CT
	const lateNight = new Date(Date.UTC(2026, 9, 12, 4, 30)); // Sun 11:30 PM CT
	assert.equal(ctx.renderMondayNightManiaCard([l], before), null);
	const card = ctx.renderMondayNightManiaCard([l], at);
	assert.equal(card.id ?? card.attrs.id, 'sunday-night');
	assert.match(fullText(card), /Sunday Night Simmer/);
	assert.match(fullText(card), /Down 10\.00 — score 10\.01 to win/);
	assert.match(fullText(ctx.renderMondayNightManiaCard([l], lateNight)), /Sunday Night Simmer/);
	assert.match(fullText(ctx.renderMondayNightManiaCard([l], MONDAY)), /Monday Night Mayhem/);
	const july = new Date(Date.UTC(2026, 6, 12, 23, 30));
	assert.equal(ctx.renderMondayNightManiaCard([l], july), null);
}

{
	// Per-matchup collapse: above 80% / below 20% starts collapsed, the band
	// between (and no probability) starts open; a click flips it and is
	// remembered; the summary with minutes left and win % stays either way.
	const mk = (id, prob) => {
		const l = lg(id, '90.00', '100.00', [pl('a', 'Tyreek Hill', 'MIA', null)], []);
		l.scoring.teams[0].winProb = prob;
		l.scoring.teams[0].minutesRemaining = 42;
		return l;
	};
	const ctx = makeContext(LOGGED_IN);
	setState(ctx, games);
	const leagues = [mk('1', 81), mk('2', 80), mk('3', 20), mk('4', 19), mk('5', null)];
	const card = ctx.renderMondayNightManiaCard(leagues, MONDAY);
	const boxes = findAll(card, (n) => n.cls.split(/\s+/).includes('monday-matchup'));
	const bodyOf = (b) => b.children.find((c) => c.cls.split(/\s+/).includes('monday-matchup-body'));
	// Rendered likeliest first: 81, 80, 20, 19, none.
	assert.deepEqual(plain(boxes.map((b) => bodyOf(b).hidden)), [true, false, false, true, false]);
	// Collapsed still shows the summary: the gap, minutes left, win %.
	assert.match(fullText(boxes[0]), /Down 10\.00[\s\S]*42 min left · Win 81%/);
	// Clicking a collapsed head opens it and the choice survives a rebuild.
	const head = boxes[0].children[0];
	head.listeners.click[0]();
	assert.equal(bodyOf(boxes[0]).hidden, false);
	const again = findAll(ctx.renderMondayNightManiaCard(leagues, MONDAY), (n) => n.cls.split(/\s+/).includes('monday-matchup'));
	assert.deepEqual(plain(again.map((b) => bodyOf(b).hidden)), [false, false, false, true, false]);
	// And an open matchup can be collapsed by hand.
	again[1].children[0].listeners.click[0]();
	assert.equal(bodyOf(again[1]).hidden, true);
}

{
	// Each team is a plain collapsible group like Now Playing's Starters /
	// Bench: "Name (N)" label, players inside, "Nobody left" when empty, and
	// a click collapses it (remembered across a rebuild).
	const l = lg('1', '98.40', '110.00', [pl('a', 'Tyreek Hill', 'MIA', null)], []);
	const ctx = makeContext(LOGGED_IN);
	setState(ctx, games);
	const groups = () => findAll(ctx.renderMondayNightManiaCard([l], MONDAY), (n) => n.cls.split(/\s+/).includes('roster-group'));
	let g = groups();
	assert.equal(g.length, 2);
	assert.match(fullText(g[0]), /^▾?Me \(1\)/);
	assert.match(fullText(g[1]), /Them \(0\)[\s\S]*Nobody left to play/);
	assert.ok(!g[0].classList.contains('roster-group-collapsed'));
	const label = g[0].children[0];
	label.listeners.click[0]();
	assert.ok(g[0].classList.contains('roster-group-collapsed'));
	g = groups();
	assert.ok(g[0].classList.contains('roster-group-collapsed'));
	assert.ok(!g[1].classList.contains('roster-group-collapsed'));
}

{
	// A page left open across 6:30 PM Sunday must swap the card in without
	// waiting for the 30-minute idle poll: syncNightCard repaints when the
	// clock calls for a different card than the one last rendered.
	const ctx = makeContext(LOGGED_IN);
	const at = new Date(Date.UTC(2026, 9, 25, 23, 46)); // Sun 6:46 PM CT
	assert.equal(ctx.nightCardVariant(new Date(Date.UTC(2026, 9, 25, 23, 29))), null);
	assert.equal(ctx.nightCardVariant(at), 'sunday');
	assert.equal(ctx.nightCardVariant(MONDAY), 'monday');
	let repaints = 0;
	ctx.rerenderScoringCards = () => { repaints += 1; vm.runInContext('renderedNightCardVariant = "sunday"', ctx); };
	ctx.nightCardVariant = () => 'sunday';
	vm.runInContext('pageData = { leagues: [] }; renderedNightCardVariant = null;', ctx);
	vm.runInContext('syncNightCard()', ctx);
	assert.equal(repaints, 1);
	vm.runInContext('syncNightCard()', ctx);
	assert.equal(repaints, 1, 'no repaint once the right card is up');
}

console.log('test-monday-night-mania: ok');
