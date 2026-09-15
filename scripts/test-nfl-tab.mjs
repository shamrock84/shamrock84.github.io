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
//
// Also pins nflBoxscorePlayerLines (scripts/lib/providers.mjs) and the
// per-game stat drawer it feeds (renderNflGameRow/appendNflBoxscoreToggle):
// the category allowlist/order, and the drawer's three empty states
// (pre-kickoff, not-yet-fetched, fetched-but-empty) each meaning something
// different that a reader must not mistake for one of the others.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { nflBoxscorePlayerLines } from './lib/providers.mjs';

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

// --- nflBoxscorePlayerLines: the drawer's own human box score lines -----

{
	const boxscore = {
		players: [
			{
				team: { abbreviation: 'NE' },
				statistics: [
					{
						name: 'passing',
						keys: ['completions/passingAttempts', 'passingYards', 'yardsPerPassAttempt', 'passingTouchdowns', 'interceptions'],
						labels: ['C/ATT', 'YDS', 'AVG', 'TD', 'INT'],
						athletes: [{ athlete: { displayName: 'Drake Maye' }, stats: ['23/33', '178', '5.4', '1', '3'] }],
					},
					// Out of scope (see ESPN_BOXSCORE_TO_MFL_EVENT's own comment on
					// why kicking/team-defense aren't covered) — must not leak in.
					{
						name: 'defensive',
						keys: ['totalTackles', 'sacks'],
						labels: ['TOT', 'SACK'],
						athletes: [{ athlete: { displayName: 'Robert Spillane' }, stats: ['8', '0'] }],
					},
				],
			},
			{
				team: { abbreviation: 'SEA' },
				statistics: [
					// Listed receiving-then-rushing here, the opposite of the
					// display order — this project has never confirmed ESPN's own
					// statistics[] array order is stable, so the fixed order below
					// must not depend on it.
					{
						name: 'receiving',
						keys: ['receptions', 'receivingYards', 'yardsPerReception', 'receivingTouchdowns', 'longReception', 'receivingTargets'],
						labels: ['REC', 'YDS', 'AVG', 'TD', 'LONG', 'TGTS'],
						athletes: [{ athlete: { displayName: 'Jaxon Smith-Njigba' }, stats: ['8', '122', '15.3', '1', '45', '11'] }],
					},
					{
						name: 'rushing',
						keys: ['rushingAttempts', 'rushingYards', 'yardsPerRushAttempt', 'rushingTouchdowns', 'longRushing'],
						labels: ['CAR', 'YDS', 'AVG', 'TD', 'LONG'],
						athletes: [{ athlete: { displayName: 'Jadarian Price' }, stats: ['10', '52', '5.2', '0', '13'] }],
					},
				],
			},
			// A team with nothing in scope at all (e.g. only special-teams/
			// defensive categories recorded so far) contributes no entry, not an
			// empty one a caller would still have to filter.
			{
				team: { abbreviation: 'BYE' },
				statistics: [{ name: 'defensive', keys: ['totalTackles'], labels: ['TOT'], athletes: [{ athlete: { displayName: 'Nobody Relevant' }, stats: ['4'] }] }],
			},
		],
	};

	const teams = nflBoxscorePlayerLines(boxscore);
	assert.equal(teams.length, 2, 'a team with nothing in scope is dropped entirely');
	assert.equal(teams[0].team, 'NE');
	assert.equal(teams[0].categories.length, 1, 'the defensive category never crosses into scope');
	assert.equal(teams[0].categories[0].name, 'passing');
	assert.deepEqual(teams[0].categories[0].labels, ['C/ATT', 'YDS', 'AVG', 'TD', 'INT'], "ESPN's own column labels are used verbatim");
	assert.deepEqual(
		teams[0].categories[0].athletes,
		[{ name: 'Drake Maye', stats: ['23/33', '178', '5.4', '1', '3'] }],
		'a combined stat like "23/33" stays one string — never decomposed the way the MFL join does'
	);

	// Fixed display order (passing, rushing, receiving) regardless of the raw
	// response's own array order.
	assert.deepEqual(
		teams[1].categories.map((c) => c.name),
		['rushing', 'receiving'],
		'category order is fixed, not the order ESPN happened to list them in'
	);
}

// A category whose only athlete carries no usable name is dropped — same
// "don't render a blank" posture as buildNflGamesList's own filter.
{
	const boxscore = {
		players: [{ team: { abbreviation: 'KC' }, statistics: [
			{ name: 'passing', keys: ['passingYards'], labels: ['YDS'], athletes: [{ athlete: {}, stats: ['10'] }] },
		] }],
	};
	assert.deepEqual(nflBoxscorePlayerLines(boxscore), [], 'an athlete with no displayName produces no row, and an empty category produces no team entry');
}

// A boxscore that's missing entirely (a failed fetch) degrades to [], never a throw.
assert.deepEqual(nflBoxscorePlayerLines(null), []);
assert.deepEqual(nflBoxscorePlayerLines(undefined), []);

// SACKS, LONG and RTG are dropped wherever they appear, on user request —
// and since stats are positional (parallel to labels), removing a column
// has to shift every OTHER value into the right place too, not just delete
// the dropped ones and leave the rest misaligned under the wrong header.
// RTG sits BETWEEN two kept columns here (not trailing, like SACKS) so a
// regression that only handled a dropped trailing column would still be
// caught: TD must still line up with TD's own value, not RTG's old slot.
{
	const boxscore = {
		players: [{
			team: { abbreviation: 'BUF' },
			statistics: [
				{
					name: 'passing',
					keys: ['completions/passingAttempts', 'passingYards', 'QBRating', 'passingTouchdowns', 'sacks'],
					labels: ['C/ATT', 'YDS', 'RTG', 'TD', 'SACKS'],
					athletes: [{ athlete: { displayName: 'Josh Allen' }, stats: ['22/31', '275', '118.4', '2', '3'] }],
				},
				{
					name: 'rushing',
					keys: ['rushingAttempts', 'rushingYards', 'longRushing'],
					labels: ['CAR', 'YDS', 'LONG'],
					athletes: [{ athlete: { displayName: 'James Cook' }, stats: ['14', '82', '22'] }],
				},
				{
					name: 'receiving',
					keys: ['receptions', 'receivingYards', 'longReception'],
					labels: ['REC', 'YDS', 'LONG'],
					athletes: [{ athlete: { displayName: 'Stefon Diggs' }, stats: ['7', '98', '32'] }],
				},
			],
		}],
	};
	const [team] = nflBoxscorePlayerLines(boxscore);
	const [passing, rushing, receiving] = team.categories;
	assert.deepEqual(passing.labels, ['C/ATT', 'YDS', 'TD'], 'RTG and SACKS are both dropped from passing');
	assert.deepEqual(passing.athletes[0].stats, ['22/31', '275', '2'], "TD's own value (2) survives in TD's own slot, not RTG's old one");
	assert.deepEqual(rushing.labels, ['CAR', 'YDS'], "rushing's LONG (longRushing) is dropped");
	assert.deepEqual(rushing.athletes[0].stats, ['14', '82']);
	assert.deepEqual(receiving.labels, ['REC', 'YDS'], "receiving's LONG (longReception) — a DIFFERENT key, same label — is dropped too");
	assert.deepEqual(receiving.athletes[0].stats, ['7', '98']);
}

// --- The per-game stat drawer --------------------------------------------

// A fuller localStorage stub than makeContext's read-only-null one: this
// needs a real backing store (round-tripping the toggle's open state) PLUS
// the Storage iteration pair, key()/length, since nflBoxscoreOpenGameIds
// scans every stored key — mirrors test-scoring-details.mjs's identical
// stub for benchDetailLeagueIds. window.matchMedia is real here too (the
// other tests' stub omits it, which is harmless there only because
// isCardCollapsed/setCardCollapsed swallow the resulting throw and quietly
// report "closed" — fine for tests that never open a drawer, wrong for
// these, which need the real open/closed value back).
function makeDrawerContext() {
	const store = new Map();
	const ctx = {
		console,
		localStorage: {
			getItem: (k) => (store.has(k) ? store.get(k) : null),
			setItem(k, v) { store.set(k, String(v)); },
			removeItem(k) { store.delete(k); },
			key(i) { return [...store.keys()][i] ?? null; },
			get length() { return store.size; },
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
		window: { addEventListener() {}, matchMedia: () => ({ matches: false }) },
		fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
	};
	vm.createContext(ctx);
	vm.runInContext(scriptSource, ctx);
	return ctx;
}

function fireClick(node) {
	(node.listeners.click || []).forEach((fn) => fn());
}

// The drawer lives INSIDE the same pill — a second, floating box below it
// (rather than the same bordered card growing to hold it) was rejected on
// sight, so this is the one assertion that actually pins the requested
// layout: renderNflGameRow returns ONE element, and everything the toggle
// controls is a descendant of it, not a sibling.
{
	const ctx = makeDrawerContext();
	const game = { id: 'g0', state: 'pre', kickoff: '2026-09-14T17:00:00Z', away: { team: 'DAL', score: 0 }, home: { team: 'PHI', score: 0 } };
	const pill = ctx.renderNflGameRow(game);
	assert.ok(!Array.isArray(pill), 'renderNflGameRow returns the one bordered card, not a [pill, drawer] pair');
	const toggle = findAll(pill, hasClass('nfl-boxscore-toggle'))[0];
	const drawer = findAll(pill, hasClass('nfl-boxscore-body'))[0];
	assert.ok(drawer, 'the drawer body is a descendant of the pill');
	assert.ok(!pill.cls.includes('nfl-boxscore-open'), 'closed by default, so the pill has not grown yet');
	fireClick(toggle);
	assert.ok(pill.cls.includes('nfl-boxscore-open'), 'opening claims the full row for this SAME card (see .nfl-boxscore-open\'s own CSS comment)');
	assert.equal(drawer.hidden, false, 'opens on click');
}

// The toggle flags a live game gold the same way the Scoring tab's own
// scoring-detail-live does — before the drawer is even opened, so a manager
// sees it without a click. Fixed off game.state at build time, so this
// checks all three states rather than just confirming 'in' looks right.
{
	const ctx = makeDrawerContext();
	const stateToggleClass = (state) => {
		const game = { id: `g-${state}`, state, kickoff: '2026-09-14T17:00:00Z', away: { team: 'DAL', score: 0 }, home: { team: 'PHI', score: 0 } };
		const pill = ctx.renderNflGameRow(game);
		return findAll(pill, hasClass('nfl-boxscore-toggle'))[0].cls;
	};
	assert.ok(stateToggleClass('in').includes('nfl-boxscore-live'), 'a live game gets the gold modifier');
	assert.ok(!stateToggleClass('pre').includes('nfl-boxscore-live'), 'a game that has not started does not');
	assert.ok(!stateToggleClass('post').includes('nfl-boxscore-live'), 'a final game does not');
}

// A pre-kickoff game's drawer says so without ever needing nflBoxscores at
// all — api/live-scoring.js never fetches one for a game that hasn't
// started (nothing to fetch yet), and the drawer must say why rather than
// showing "loading" forever.
{
	const ctx = makeDrawerContext();
	const game = { id: 'g1', state: 'pre', kickoff: '2026-09-14T17:00:00Z', away: { team: 'DAL', score: 0 }, home: { team: 'PHI', score: 0 } };
	const pill = ctx.renderNflGameRow(game);
	const toggle = findAll(pill, hasClass('nfl-boxscore-toggle'))[0];
	const drawer = findAll(pill, hasClass('nfl-boxscore-body'))[0];
	assert.equal(drawer.hidden, true, 'closed by default');
	fireClick(toggle);
	assert.equal(drawer.hidden, false, 'opens on click');
	assert.equal(toggle.attrs['aria-expanded'], 'true');
	assert.equal(findAll(drawer, hasClass('nfl-boxscore-empty'))[0]._text, "Game hasn't started yet.");
}

// A live game with no boxscore fetched yet (this poll hasn't answered, or
// the fetch failed) reads as "loading" — "not asked" must never look like
// "nothing happened", same reasoning as the Scoring drawer's own empty state.
{
	const ctx = makeDrawerContext();
	const game = { id: 'g2', state: 'in', kickoff: '2026-09-14T17:00:00Z', away: { team: 'BUF', score: 10 }, home: { team: 'MIA', score: 7 } };
	const pill = ctx.renderNflGameRow(game);
	fireClick(findAll(pill, hasClass('nfl-boxscore-toggle'))[0]);
	assert.equal(findAll(pill, hasClass('nfl-boxscore-empty'))[0]._text, 'Loading box score…');
}

// A live game with a boxscore in hand but nothing recorded in scope yet
// (moments after kickoff) reads as "no stats yet", not a loading message
// and not an empty table.
{
	const ctx = makeDrawerContext();
	ctx.__teams = [];
	vm.runInContext('nflBoxscores = { g3: __teams };', ctx);
	const game = { id: 'g3', state: 'in', kickoff: '2026-09-14T17:00:00Z', away: { team: 'BUF', score: 0 }, home: { team: 'MIA', score: 0 } };
	const pill = ctx.renderNflGameRow(game);
	fireClick(findAll(pill, hasClass('nfl-boxscore-toggle'))[0]);
	assert.equal(findAll(pill, hasClass('nfl-boxscore-empty'))[0]._text, 'No stats recorded yet.');
}

// The real case: a populated boxscore renders one table per category,
// headed by ESPN's own labels alongside a Player column this project adds,
// one row per athlete — and the section heading is human-worded rather than
// the raw category name.
{
	const ctx = makeDrawerContext();
	ctx.__teams = [
		{ team: 'BUF', categories: [{ name: 'passing', labels: ['C/ATT', 'YDS', 'TD'], athletes: [{ name: 'Josh Allen', stats: ['20/28', '245', '2'] }] }] },
	];
	vm.runInContext('nflBoxscores = { g4: __teams };', ctx);
	const game = { id: 'g4', state: 'in', kickoff: '2026-09-14T17:00:00Z', away: { team: 'BUF', score: 14 }, home: { team: 'MIA', score: 7 } };
	const pill = ctx.renderNflGameRow(game);
	fireClick(findAll(pill, hasClass('nfl-boxscore-toggle'))[0]);

	assert.equal(findAll(pill, hasClass('nfl-boxscore-team-head'))[0]._text, 'BUF');
	assert.equal(findAll(pill, hasClass('nfl-boxscore-category-label'))[0]._text, 'Passing', 'the section heading is human-worded, not the raw category name');
	const headerCells = findAll(pill, (n) => n.tag === 'th').map((n) => n._text);
	assert.deepEqual(headerCells, ['Player', 'C/ATT', 'YDS', 'TD']);
	const dataCells = findAll(pill, (n) => n.tag === 'td').map((n) => n._text);
	assert.deepEqual(dataCells, ['Josh Allen', '20/28', '245', '2']);
}

// Toggling closed and back open again re-derives from the same nflBoxscores
// rather than getting stuck on whatever the first open showed — there is no
// `filled`-style guard here (see appendNflBoxscoreToggle's own comment), so
// this pins that the re-fill actually happens. Also pins that closing
// shrinks the pill back down rather than leaving it stuck full-width.
{
	const ctx = makeDrawerContext();
	ctx.__teams = [{ team: 'BUF', categories: [{ name: 'passing', labels: ['YDS'], athletes: [{ name: 'Josh Allen', stats: ['245'] }] }] }];
	vm.runInContext('nflBoxscores = { g5: __teams };', ctx);
	const game = { id: 'g5', state: 'in', kickoff: '2026-09-14T17:00:00Z', away: { team: 'BUF', score: 14 }, home: { team: 'MIA', score: 7 } };
	const pill = ctx.renderNflGameRow(game);
	const toggle = findAll(pill, hasClass('nfl-boxscore-toggle'))[0];
	const drawer = findAll(pill, hasClass('nfl-boxscore-body'))[0];
	fireClick(toggle); // open
	fireClick(toggle); // close
	assert.equal(drawer.hidden, true);
	assert.equal(toggle.attrs['aria-expanded'], 'false');
	assert.ok(!pill.cls.includes('nfl-boxscore-open'), 'closing shrinks the card back down');
	fireClick(toggle); // open again
	assert.equal(drawer.hidden, false);
	assert.ok(pill.cls.includes('nfl-boxscore-open'));
	assert.equal(findAll(pill, hasClass('nfl-boxscore-team-head'))[0]._text, 'BUF', 'still renders correctly the second time open');
}

console.log('test-nfl-tab.mjs OK');
