// Unit test for the NFL tab in myffl.html — buildNflGamesList, formatGameWhen
// and renderNflCards.
//
// The one thing that makes this worth pinning: liveGames is keyed by team
// ABBREVIATION, and every alias of a team (see nflTeamKeys in
// scripts/lib/providers.mjs) points at the exact same entry object, so a
// single real game shows up under several different map keys — LV and LVR
// for the same Raiders game, for instance. buildNflGamesList has to collapse
// that back down to one row per game, keyed by the scoreboard's own event id,
// or the Matchups card would silently double-list every game whose team has
// more than one alias. Also pinned:
//
//   * a game missing either side (a malformed/incomplete entry) is dropped
//     rather than rendered with a blank team.
//   * games sort by kickoff, so Matchups reads like a schedule.
//   * formatGameWhen shows the kickoff time pre-game and the scoreboard's own
//     status string once live or final — never a score before kickoff.
//   * Now Playing includes only state 'in' games; Matchups includes every
//     state. Both must read the same underlying list with nothing to drift
//     between them.
//   * the loading state (gameStatesAttempted still false) never renders "no
//     games" — that would be a false all-clear before the first fetch even
//     resolved.

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
	};
	return n;
}

function makeContext() {
	const ctx = {
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
	vm.createContext(ctx);
	vm.runInContext(scriptSource, ctx);
	return ctx;
}

// liveGames/gameStatesAttempted are top-level `let` bindings in the page's
// script, so a plain ctx.liveGames assignment wouldn't reach the real
// binding — same reasoning as test-now-playing.mjs's identical helpers.
function setLiveGames(ctx, games) {
	ctx.__testGames = games;
	vm.runInContext('liveGames = __testGames;', ctx);
}
function setGameStatesAttempted(ctx, value) {
	ctx.__testAttempted = value;
	vm.runInContext('gameStatesAttempted = __testAttempted;', ctx);
}

function findAll(n, pred, out = []) {
	if (!n || !n.children) return out;
	for (const c of n.children) {
		if (pred(c)) out.push(c);
		findAll(c, pred, out);
	}
	return out;
}
const hasClass = (c) => (n) => n.cls.split(/\s+/).includes(c);

// --- buildNflGamesList -------------------------------------------------

// THE assertion this suite exists for: aliases of the same team must not
// double the game up.
{
	const ctx = makeContext();
	const shared = { id: 'evt1', state: 'in', detail: '4:35 - 1st', kickoff: '2026-09-13T20:05:00Z', isHome: false, team: 'LV', score: 13 };
	const games = {
		LV: shared,
		LVR: shared, // MFL's own padded alias for the same Raiders entry
		DEN: { id: 'evt1', state: 'in', detail: '4:35 - 1st', kickoff: '2026-09-13T20:05:00Z', isHome: true, team: 'DEN', score: 20 },
	};
	const list = ctx.buildNflGamesList(games);
	assert.equal(list.length, 1, 'two aliases of the same team must not produce two rows');
	assert.equal(list[0].away.team, 'LV');
	assert.equal(list[0].away.score, 13);
	assert.equal(list[0].home.team, 'DEN');
	assert.equal(list[0].home.score, 20);
}

// A game missing its other side (a malformed or half-populated entry) is
// dropped rather than rendered with a blank team.
{
	const ctx = makeContext();
	const games = { SEA: { id: 'evt2', state: 'pre', kickoff: '2026-09-14T17:00:00Z', isHome: true, team: 'SEA', score: 0 } };
	assert.equal(ctx.buildNflGamesList(games).length, 0, 'a game with no opponent entry at all renders nothing');
}

// Sorted by kickoff — Matchups should read like a schedule, not map
// iteration order.
{
	const ctx = makeContext();
	const games = {
		LATE_A: { id: 'later', state: 'pre', kickoff: '2026-09-14T20:05:00Z', isHome: false, team: 'DAL', score: 0 },
		LATE_B: { id: 'later', state: 'pre', kickoff: '2026-09-14T20:05:00Z', isHome: true, team: 'PHI', score: 0 },
		EARLY_A: { id: 'earlier', state: 'pre', kickoff: '2026-09-14T17:00:00Z', isHome: false, team: 'NYG', score: 0 },
		EARLY_B: { id: 'earlier', state: 'pre', kickoff: '2026-09-14T17:00:00Z', isHome: true, team: 'WSH', score: 0 },
	};
	const list = ctx.buildNflGamesList(games);
	// A plain array literal built out here, in the OUTER realm, from ids that
	// are themselves primitive strings — sidesteps assert/strict's own
	// prototype check tripping over the vm-realm Array the function itself
	// returned (see test-admin-dirty.mjs's identical note).
	assert.deepEqual([...list].map((g) => g.id), ['earlier', 'later'], 'games sort by kickoff, earliest first');
}

// --- formatGameWhen ------------------------------------------------------

{
	const ctx = makeContext();
	assert.equal(ctx.formatGameWhen({ state: 'in', detail: '4:35 - 1st' }), '4:35 - 1st', 'a live game shows the scoreboard status verbatim');
	assert.equal(ctx.formatGameWhen({ state: 'post', detail: 'Final' }), 'Final');
	// A pre-game entry with an unparseable kickoff degrades to an empty
	// string rather than "Invalid Date" or throwing.
	assert.equal(ctx.formatGameWhen({ state: 'pre', kickoff: 'not-a-date' }), '');
	const when = ctx.formatGameWhen({ state: 'pre', kickoff: '2026-09-14T17:00:00Z' });
	assert.ok(when.length > 0, 'a valid pre-game kickoff renders a non-empty string');
	assert.ok(!/\d+\s*-\s*\d+/.test(when), 'never a score before kickoff');
}

// --- renderNflCards -------------------------------------------------------

// Before the first scoreboard fetch resolves, this must show a loading
// state — not "no games", which would be a false all-clear.
{
	const ctx = makeContext();
	setGameStatesAttempted(ctx, false);
	const grid = domNode();
	ctx.renderNflCards(grid);
	const loading = findAll(grid, hasClass('loading-box'));
	assert.equal(loading.length, 1, 'shows a loading placeholder before the first fetch resolves');
	assert.equal(findAll(grid, hasClass('nfl-game-row')).length, 0);
}

// No games at all once the fetch has resolved: both cards render their own
// empty-state text, not a loading box.
{
	const ctx = makeContext();
	setGameStatesAttempted(ctx, true);
	setLiveGames(ctx, {});
	const grid = domNode();
	ctx.renderNflCards(grid);
	assert.equal(findAll(grid, hasClass('loading-box')).length, 0);
	const cards = findAll(grid, hasClass('nfl-card'));
	assert.equal(cards.length, 2, 'Now Playing and Matchups both render even with nothing to show');
}

// The load-bearing split: Now Playing shows only the live game; Matchups
// shows both the live one and the not-yet-started one.
{
	const ctx = makeContext();
	setGameStatesAttempted(ctx, true);
	setLiveGames(ctx, {
		BUF: { id: 'live1', state: 'in', detail: '4:35 - 1st', kickoff: '2026-09-14T17:00:00Z', isHome: false, team: 'BUF', score: 10 },
		MIA: { id: 'live1', state: 'in', detail: '4:35 - 1st', kickoff: '2026-09-14T17:00:00Z', isHome: true, team: 'MIA', score: 7 },
		DAL: { id: 'later', state: 'pre', kickoff: '2026-09-14T20:25:00Z', isHome: false, team: 'DAL', score: 0 },
		PHI: { id: 'later', state: 'pre', kickoff: '2026-09-14T20:25:00Z', isHome: true, team: 'PHI', score: 0 },
	});
	const grid = domNode();
	ctx.renderNflCards(grid);
	const rows = findAll(grid, hasClass('nfl-game-row'));
	assert.equal(rows.length, 3, '1 live row on Now Playing + 2 rows (live and upcoming) on Matchups');
	assert.equal(findAll(grid, hasClass('nfl-game-live')).length, 2, 'the live game is flagged on both cards it appears on');

	// The live row's score shows; the pre-game row's doesn't (score 0
	// pre-kickoff is a placeholder, not a real score).
	const liveRow = rows.find((r) => findAll(r, hasClass('nfl-game-score')).length > 0);
	assert.ok(liveRow, 'the live game shows a score somewhere');
	const scoreTexts = findAll(liveRow, hasClass('nfl-game-score')).map((n) => n._text);
	assert.deepEqual(scoreTexts.sort(), ['10', '7'].sort());

	// Every row links to ESPN's own box score by the scoreboard's event id.
	const links = findAll(grid, hasClass('nfl-boxscore-link'));
	assert.ok(links.every((a) => /^https:\/\/www\.espn\.com\/nfl\/boxscore\/_\/gameid\/(live1|later)$/.test(a.attrs.href)));
	assert.ok(links.every((a) => a.attrs.target === '_blank' && a.attrs.rel === 'noopener'));
}

console.log('test-nfl-tab.mjs OK');
