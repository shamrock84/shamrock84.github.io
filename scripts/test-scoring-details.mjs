// Unit test for the Scoring tab's per-matchup detail drawer in myffl.html.
//
// The drawer lays a matchup's two lineups side by side, aligned by position,
// the way ESPN's own live scoreboard does. Everything it can get wrong is
// silent — a starter dropped from the grid, a points value invented for a
// player whose game hasn't started, or one side's players rendered against
// the wrong opponent's column all produce a perfectly plausible-looking
// table. So this pins the judgement calls rather than the markup:
//
//   * pairStartersByPosition emits a row per position with the DEEPER side's
//     count, padding the shallower side — the property that keeps a flex
//     difference legible instead of shifting every row below it.
//   * position groups come out in POSITION_ORDER order, with anything
//     unrecognised kept and pushed to the end rather than dropped.
//   * within a group the provider's own order survives (a re-sort by points
//     would pair "their best WR" against "your best WR", a matchup no
//     lineup actually set).
//   * a null `points` renders as a dash, never 0.0 — see mflLiveStarters'
//     comment on why a missing field must not be dressed up as a real zero.
//   * the drawer is login-gated and skipped for a lone team (a bye), the
//     two cases where it must not appear at all.
//   * the open/closed state round-trips through localStorage, which is the
//     only reason an open drawer survives refreshLiveScoring tearing down
//     and rebuilding every Scoring card on each ~30s poll.
//   * isPlayerLive flags the toggle and a starter's own row-half red only
//     while their game is actually underway (state 'in') — never for a game
//     that hasn't kicked off, is already final, or a team the scoreboard
//     never covered, any of which would otherwise be mistaken for live.

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
		// Real DOM semantics: setting textContent replaces every existing
		// child, not just the plain-text fallback fullText() reads when
		// there are none. Needed now that the live-status tests below reuse
		// one node across several setLiveStatus calls (setLiveStatus itself
		// clears via `textContent = ''` before appendChild-ing fresh nodes)
		// — without clearing children here too, those calls would silently
		// accumulate every prior render's nodes underneath the latest one.
		set textContent(v) { n._text = v; n.children = []; },
		// Zeroed rect/offsets — the Stat Breakdown popover's own positioning
		// math (makePopover's position()) runs against these, but this suite
		// checks that it opens with the right content, not where it lands on
		// a real screen. Same stub shape as test-team-needs.mjs's domNode.
		getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
		offsetWidth: 0,
		offsetHeight: 0,
	};
	return n;
}

// A real backing store, unlike the read-only-null stub the other page tests
// use: this suite needs to seed an auth token (the drawer is login-gated, and
// authToken is read once at script-eval time) and to read back what the
// toggle persisted.
function makeContext(seed = {}) {
	const store = new Map(Object.entries(seed));
	const ctx = {
		console,
		localStorage: {
			getItem: (k) => (store.has(k) ? store.get(k) : null),
			setItem(k, v) { store.set(k, String(v)); },
			removeItem(k) { store.delete(k); },
			// The real Storage interface's iteration pair — benchDetailLeagueIds
			// scans every stored key to find bench-open ones, so the stub needs
			// these too, not just get/set/remove.
			key(i) { return [...store.keys()][i] ?? null; },
			get length() { return store.size; },
		},
		setTimeout, clearTimeout, setInterval, clearInterval,
		document: {
			// Real enough to drive the visibilitychange pause/resume suite:
			// recorded per event type rather than a no-op, so a test can fire
			// what the real event would trigger.
			__listeners: {},
			addEventListener(type, fn) { (this.__listeners[type] = this.__listeners[type] || []).push(fn); },
			getElementById: () => domNode(),
			createElement: (t) => domNode(t),
			createTextNode: (t) => { const n = domNode('#text'); n.textContent = t; return n; },
			querySelector: () => null,
			querySelectorAll: () => [],
			visibilityState: 'visible',
			body: domNode(),
		},
		// cardCollapseStorageKey buckets its key by viewport, so the drawer's
		// own state helpers need this — desktop bucket here.
		window: { addEventListener() {}, matchMedia: () => ({ matches: false }), innerWidth: 1024 },
		fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
	};
	vm.createContext(ctx);
	vm.runInContext(scriptSource, ctx);
	ctx.__store = store;
	return ctx;
}

const LOGGED_IN = { mflAuthToken: 'test-token' };

// `liveGames` is a top-level `let` in the page's script, and a `let` binding
// in a vm script is NOT a property of the context object — so assigning
// ctx.liveGames would quietly create a second, unrelated global that
// playerGameLine never reads. Assigning from inside the context resolves
// lexically to the real binding.
function setLiveGames(ctx, games) {
	ctx.__testGames = games;
	vm.runInContext('liveGames = __testGames;', ctx);
}

// Drives the document.visibilitychange listener registered alongside the
// live-scoring poll (see its own comment), the same way a real background/
// foreground tab switch would.
function fireVisibilityChange(ctx, state) {
	ctx.document.visibilityState = state;
	(ctx.document.__listeners.visibilitychange || []).forEach((fn) => fn());
}

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
const hasClass = (c) => (n) => n.cls.split(/\s+/).includes(c);

// --- pairStartersByPosition, the load-bearing pure function ---
{
	const ctx = makeContext();
	const pair = ctx.pairStartersByPosition;

	// Even sides: one row per position, both filled.
	{
		const rows = pair(
			[{ name: 'A', position: 'QB' }, { name: 'B', position: 'RB' }],
			[{ name: 'C', position: 'QB' }, { name: 'D', position: 'RB' }]
		);
		assert.equal(rows.length, 2);
		assert.deepEqual([...rows].map((r) => r.position), ['QB', 'RB']);
		assert.deepEqual([...rows].map((r) => [r.left.name, r.right.name]), [['A', 'C'], ['B', 'D']]);
	}

	// Uneven sides — the flex case this exists for. Three WRs against one WR
	// must produce three WR rows, with the shallower side padded null, NOT
	// one row that silently hides two starters.
	{
		const rows = pair(
			[{ name: 'W1', position: 'WR' }, { name: 'W2', position: 'WR' }, { name: 'W3', position: 'WR' }],
			[{ name: 'X1', position: 'WR' }, { name: 'T1', position: 'TE' }]
		);
		assert.equal(rows.length, 4, 'three WR rows plus the TE row the other side has alone');
		assert.deepEqual([...rows].map((r) => r.position), ['WR', 'WR', 'WR', 'TE']);
		assert.deepEqual([...rows].map((r) => r.left?.name ?? null), ['W1', 'W2', 'W3', null]);
		assert.deepEqual([...rows].map((r) => r.right?.name ?? null), ['X1', null, null, 'T1']);
	}

	// Position groups come out in POSITION_ORDER order regardless of the
	// order the providers listed them in, and every starter survives.
	{
		const rows = pair(
			[{ name: 'K', position: 'PK' }, { name: 'Q', position: 'QB' }, { name: 'D', position: 'Def' }],
			[{ name: 'Q2', position: 'QB' }, { name: 'K2', position: 'PK' }, { name: 'D2', position: 'Def' }]
		);
		assert.deepEqual([...rows].map((r) => r.position), ['QB', 'PK', 'Def']);
	}

	// An unrecognised position (an IDP league, or a provider position this
	// page's shorter POSITION_ORDER doesn't carry) is KEPT and sorted to the
	// end — never dropped from a drawer that claims to show a whole lineup.
	{
		const rows = pair(
			[{ name: 'LB1', position: 'LB' }, { name: 'Q', position: 'QB' }],
			[{ name: 'LB2', position: 'LB' }, { name: 'Q2', position: 'QB' }]
		);
		assert.deepEqual([...rows].map((r) => r.position), ['QB', 'LB']);
		assert.equal(rows.length, 2, 'the IDP starter is still in the grid');
	}

	// A missing position falls into its own '?' bucket rather than throwing
	// or colliding with a real position.
	{
		const rows = pair([{ name: 'Mystery' }], [{ name: 'Q', position: 'QB' }]);
		assert.deepEqual([...rows].map((r) => r.position), ['QB', '?']);
	}

	// Provider order within a group survives — NOT re-sorted by points.
	{
		const rows = pair(
			[{ name: 'Low', position: 'WR', points: 2 }, { name: 'High', position: 'WR', points: 30 }],
			[{ name: 'R1', position: 'WR', points: 1 }, { name: 'R2', position: 'WR', points: 40 }]
		);
		assert.deepEqual([...rows].map((r) => r.left.name), ['Low', 'High'], 'lineup order, not points order');
		assert.deepEqual([...rows].map((r) => r.right.name), ['R1', 'R2']);
	}

	// Absent/empty player lists are handled rather than thrown on — the
	// pre-first-poll case, since the committed snapshot carries no players[].
	assert.deepEqual([...pair(undefined, undefined)], []);
	assert.deepEqual([...pair([], [])], []);
	assert.equal(pair([{ name: 'A', position: 'QB' }], undefined).length, 1);
}

// --- The rendered drawer ---
function leagueWithMatchup() {
	return {
		id: 'L1', name: 'League One', type: 'redraft',
		scoring: {
			week: '1',
			teams: [
				{
					franchiseId: '1', teamName: 'Team One', score: '20.0', isMe: true,
					players: [
						{ id: '111', name: 'Joe Burrow', position: 'QB', team: 'CIN', points: 18.4 },
						{ id: '222', name: 'James Cook', position: 'RB', team: 'BUF', points: null },
					],
					bench: [
						{ id: '666', name: 'Bench One', position: 'WR', team: 'MIA', points: 2 },
					],
				},
				{
					franchiseId: '2', teamName: 'Team Two', score: '10.0',
					players: [
						{ id: '333', name: 'Trevor Lawrence', position: 'QB', team: 'JAX', points: 0 },
						{ id: '444', name: 'Bijan Robinson', position: 'RB', team: 'ATL', points: 7.25 },
						{ id: '555', name: 'Drake London', position: 'WR', team: 'ATL', points: 3 },
					],
					bench: [
						{ id: '777', name: 'Bench Two', position: 'TE', team: 'DAL', points: 5 },
					],
				},
			],
			matchups: [{ teamIds: ['1', '2'] }],
		},
	};
}

// Logged in: the drawer exists, is closed by default, and its grid pairs the
// two lineups.
{
	const ctx = makeContext(LOGGED_IN);
	ctx.liveScoringAttempted = true;
	const card = ctx.renderScoringCard(leagueWithMatchup());

	const toggles = findAll(card, hasClass('scoring-detail-toggle'));
	assert.equal(toggles.length, 1, 'one drawer toggle for the one matchup');
	assert.equal(toggles[0].getAttribute('aria-expanded'), 'false', 'closed by default');
	assert.match(fullText(toggles[0]), /Show detail/);

	const body = findAll(card, hasClass('scoring-detail-body'))[0];
	assert.ok(body, 'the drawer body exists');
	assert.equal(body.hidden, true, 'and is hidden while closed');
	// Lazily filled: nothing is built until the reader opens it, so the poll
	// isn't churning thousands of hidden rows every 30 seconds.
	assert.equal(findAll(body, hasClass('scoring-detail-row')).length, 0, 'closed drawer builds no rows');

	// Open it.
	toggles[0].listeners.click[0]();
	assert.equal(body.hidden, false);
	assert.equal(toggles[0].getAttribute('aria-expanded'), 'true');
	assert.match(fullText(toggles[0]), /Hide detail/);

	const rows = findAll(body, hasClass('scoring-detail-row'));
	assert.equal(rows.length, 3, 'QB, RB, and the WR only one side started');
	assert.deepEqual(
		rows.map((r) => fullText(findAll(r, hasClass('scoring-detail-pos'))[0])),
		['QB', 'RB', 'WR']
	);

	// The left column is the pill's top row (the higher score, Team One);
	// the right column its bottom row. A reader's eye carries straight down
	// from a team's score into that team's column, so this must not flip.
	// Names render abbreviated — see abbreviatePlayerName's own suite below.
	const names = rows.map((r) => findAll(r, hasClass('scoring-detail-name')).map(fullText));
	assert.match(names[0][0], /J\. Burrow/);
	assert.match(names[0][1], /T\. Lawrence/);
	assert.match(names[1][0], /J\. Cook/);
	assert.match(names[1][1], /B\. Robinson/);
	// The WR row: Team One started none, so its side is the blank pad.
	assert.match(names[2][1], /D\. London/);

	// The NFL team rides along as a suffix, never its own column.
	assert.match(names[0][0], /CIN/);

	const pts = rows.map((r) => findAll(r, hasClass('scoring-detail-pts')).map((c) => c._text));
	// Two decimals, matching the team score in the pill row above — a
	// breakdown that doesn't visibly sum to the total it breaks down is the
	// first thing a reader would distrust.
	assert.equal(pts[0][0], '18.40');
	// THE assertion this card is most likely to get wrong quietly: a null
	// points value must read as a dash, not as 0.0. A real 0 (Trevor
	// Lawrence, whose game has started and who has scored nothing yet) must
	// still read as 0.0 — the two are different facts.
	assert.equal(pts[1][0], '–', 'null points renders as an en dash, never 0.0');
	assert.equal(pts[0][1], '0.00', 'a genuine zero still renders as a number');
	assert.equal(pts[1][1], '7.25');
	// The blank pad side of the unpaired WR row: an em dash, a different
	// glyph from the "points unknown" en dash, since "no starter here" and
	// "this starter's points aren't in yet" are different facts.
	assert.equal(pts[2][0], '—', 'an absent starter is an em dash');
}

// Logged out: no drawer at all, but the pill and its scores are untouched.
// The gate matters — this is every franchise's current lineup, a step past
// the team-level scores the pill itself shows.
{
	const ctx = makeContext();
	ctx.liveScoringAttempted = true;
	const card = ctx.renderScoringCard(leagueWithMatchup());
	assert.equal(findAll(card, hasClass('scoring-detail-toggle')).length, 0, 'no drawer when logged out');
	assert.equal(findAll(card, hasClass('scoring-matchup-pill')).length, 1, 'the pill still renders');
	assert.equal(findAll(card, hasClass('scoring-matchup-row')).length, 2, 'and both team rows with it');
}

// A lone team (a bye week, or an odd team count) gets no drawer — there is
// no opposing column to lay its lineup against.
{
	const ctx = makeContext(LOGGED_IN);
	ctx.liveScoringAttempted = true;
	const league = leagueWithMatchup();
	league.scoring.matchups = [{ teamIds: ['1'] }, { teamIds: ['2'] }];
	const card = ctx.renderScoringCard(league);
	assert.equal(findAll(card, hasClass('scoring-matchup-pill')).length, 2, 'two one-team pills');
	assert.equal(findAll(card, hasClass('scoring-detail-toggle')).length, 0, 'neither gets a drawer');
}

// The open state round-trips through localStorage. This is the whole reason
// the drawer is usable: rerenderScoringCards tears down and rebuilds every
// Scoring card on each ~30s poll, so a drawer held only in the DOM would
// snap shut under the reader twice a minute.
{
	const ctx = makeContext(LOGGED_IN);
	ctx.liveScoringAttempted = true;

	const card1 = ctx.renderScoringCard(leagueWithMatchup());
	const toggle1 = findAll(card1, hasClass('scoring-detail-toggle'))[0];
	toggle1.listeners.click[0]();
	assert.equal([...ctx.__store.keys()].filter((k) => k.startsWith('myfflScoringDetailOpen')).length, 1,
		'opening writes exactly one key');

	// Re-render, the same way a poll would.
	const card2 = ctx.renderScoringCard(leagueWithMatchup());
	const body2 = findAll(card2, hasClass('scoring-detail-body'))[0];
	assert.equal(body2.hidden, false, 'the rebuilt card comes back open');
	assert.equal(findAll(body2, hasClass('scoring-detail-row')).length, 3,
		'and is filled immediately, not left as an empty open drawer');

	// Closing removes the key rather than storing a "false" — absence is the
	// default, so a drawer nobody has open costs nothing in storage.
	const toggle2 = findAll(card2, hasClass('scoring-detail-toggle'))[0];
	toggle2.listeners.click[0]();
	assert.equal([...ctx.__store.keys()].filter((k) => k.startsWith('myfflScoringDetailOpen')).length, 0,
		'closing removes the key');

	const card3 = ctx.renderScoringCard(leagueWithMatchup());
	assert.equal(findAll(card3, hasClass('scoring-detail-body'))[0].hidden, true, 'and it stays closed');
}

// Two different matchups in one league get independent keys, and the key is
// order-insensitive so the score sort putting a different team on top does
// not read as a different matchup.
{
	const ctx = makeContext(LOGGED_IN);
	const league = { id: 'L9' };
	const a = ctx.matchupDetailKey(league, [{ franchiseId: '1' }, { franchiseId: '2' }]);
	const b = ctx.matchupDetailKey(league, [{ franchiseId: '2' }, { franchiseId: '1' }]);
	const c = ctx.matchupDetailKey(league, [{ franchiseId: '3' }, { franchiseId: '4' }]);
	assert.equal(a, b, 'the same two teams key identically whichever is leading');
	assert.notEqual(a, c, 'a different matchup gets a different key');
	assert.ok(a.startsWith('L9:'), 'and the league scopes it');
}

// Before the first live poll answers, the snapshot carries no players[] at
// all (fetch-rosters.mjs strips it — see stripScoringPlayers). The drawer
// must say so rather than opening onto an empty grid, which reads as a
// rendering bug instead of as missing data.
{
	const ctx = makeContext(LOGGED_IN);
	ctx.liveScoringAttempted = true;
	const league = leagueWithMatchup();
	for (const t of league.scoring.teams) delete t.players;
	const card = ctx.renderScoringCard(league);
	const toggle = findAll(card, hasClass('scoring-detail-toggle'))[0];
	toggle.listeners.click[0]();
	const body = findAll(card, hasClass('scoring-detail-body'))[0];
	assert.equal(findAll(body, hasClass('scoring-detail-row')).length, 0);
	const empty = findAll(body, hasClass('scoring-detail-empty'))[0];
	assert.ok(empty, 'an explanatory line instead');
	assert.match(fullText(empty), /No starter detail yet/);
}

// A starter whose name the provider couldn't resolve (MFL when the global
// player map didn't reach the poll — see getMflPlayerMap) falls back to the
// raw id rather than an empty cell.
{
	const ctx = makeContext(LOGGED_IN);
	ctx.liveScoringAttempted = true;
	const league = leagueWithMatchup();
	league.scoring.teams[0].players = [{ id: '9911', name: null, position: null, team: null, points: 5 }];
	league.scoring.teams[1].players = [{ id: '9912', name: 'Someone', position: null, team: null, points: 6 }];
	const card = ctx.renderScoringCard(league);
	findAll(card, hasClass('scoring-detail-toggle'))[0].listeners.click[0]();
	const body = findAll(card, hasClass('scoring-detail-body'))[0];
	const names = findAll(body, hasClass('scoring-detail-name')).map(fullText);
	assert.match(names[0], /#9911/, 'the raw id stands in for an unresolved name');
	assert.match(names[1], /Someone/, 'a one-word name is left whole, not cut to an initial');
}

// A team defense's name is cut to its mascot ("Baltimore Ravens" ->
// "Ravens", "Eagles D/ST" -> "Eagles") and still gets the same team-code
// suffix every other starter gets — the two no longer say the same thing,
// so unlike a full location name, the suffix isn't spending width on a
// repeat.
{
	const ctx = makeContext(LOGGED_IN);
	ctx.liveScoringAttempted = true;
	const league = leagueWithMatchup();
	league.scoring.teams[0].players = [
		{ id: '111', name: 'Joe Burrow', position: 'QB', team: 'CIN', points: 18.4 },
		{ id: '999', name: 'Philadelphia Eagles', position: 'Def', team: 'PHI', points: 6 },
	];
	league.scoring.teams[1].players = [
		{ id: '333', name: 'Trevor Lawrence', position: 'QB', team: 'JAX', points: 0 },
		// ESPN's own spelling — lands on the same mascot-only result as
		// MFL's "Baltimore Ravens" above. (Position casing must match the
		// other side's 'Def' here so pairStartersByPosition puts both
		// defenses in one row; Sleeper's uppercase DEF is pinned separately
		// in abbreviatePlayerName's own suite below.)
		{ id: '998', name: 'Eagles D/ST', position: 'Def', team: 'PHI', points: 4 },
	];
	const card = ctx.renderScoringCard(league);
	findAll(card, hasClass('scoring-detail-toggle'))[0].listeners.click[0]();
	const body = findAll(card, hasClass('scoring-detail-body'))[0];
	const rows = findAll(body, hasClass('scoring-detail-row'));
	const cells = rows.map((r) => findAll(r, hasClass('scoring-detail-name')));
	const suffixes = (cell) => findAll(cell, hasClass('team-suffix')).map(fullText);

	// The QB row is the control: unaffected by any of this.
	assert.deepEqual(suffixes(cells[0][0]), ['CIN']);
	assert.match(fullText(cells[0][0]), /J\. Burrow/);

	// Both sides land on the identical "Eagles PHI" even though one came
	// from MFL's "Location Mascot" shape and the other from ESPN's
	// "Mascot D/ST" shape — proof the two spellings converge.
	assert.deepEqual(suffixes(cells[1][0]), ['PHI']);
	assert.deepEqual(suffixes(cells[1][1]), ['PHI']);
	assert.equal(fullText(cells[1][0]).replace(/\s+/g, ' ').trim(), 'Eagles PHI', "MFL's spelling");
	assert.equal(fullText(cells[1][1]).replace(/\s+/g, ' ').trim(), 'Eagles PHI', "ESPN's spelling");
}

// An unresolved starter (MFL when the global player map didn't reach the
// poll) falls back to "#id" rather than a mascot — there's no name to cut
// down — and still keeps its team code, which is the only thing left
// identifying it.
{
	const ctx = makeContext(LOGGED_IN);
	ctx.liveScoringAttempted = true;
	const league = leagueWithMatchup();
	league.scoring.teams[0].players = [{ id: '9911', name: null, position: 'Def', team: 'BAL', points: 5 }];
	league.scoring.teams[1].players = [{ id: '9912', name: 'Someone', position: null, team: 'ATL', points: 6 }];
	const card = ctx.renderScoringCard(league);
	findAll(card, hasClass('scoring-detail-toggle'))[0].listeners.click[0]();
	const body = findAll(card, hasClass('scoring-detail-body'))[0];
	const names = findAll(body, hasClass('scoring-detail-name'));
	assert.match(fullText(names[0]), /#9911/);
	assert.deepEqual(findAll(names[0], hasClass('team-suffix')).map(fullText), ['BAL']);
}

// --- abbreviatePlayerName ---
{
	const ctx = makeContext();
	const abbr = ctx.abbreviatePlayerName;

	assert.equal(abbr('Joe Burrow', 'QB'), 'J. Burrow');
	assert.equal(abbr('Trevor Lawrence', 'QB'), 'T. Lawrence');
	// A generational suffix is part of the surname half and survives whole.
	assert.equal(abbr('James Cook III', 'RB'), 'J. Cook III');
	assert.equal(abbr('Chris Godwin Jr.', 'WR'), 'C. Godwin Jr.');
	// A multi-part surname likewise — everything after the first token is kept.
	assert.equal(abbr('Amon-Ra St. Brown', 'WR'), 'A. St. Brown');
	assert.equal(abbr("De'Von Achane", 'RB'), 'D. Achane');

	// A given name that is already initials is left alone — cutting "A.J."
	// to "A." drops information without saving the row any width, since it
	// was never the part making the row long.
	assert.equal(abbr('A.J. Brown', 'WR'), 'A.J. Brown');
	assert.equal(abbr('T.J. Hockenson', 'TE'), 'T.J. Hockenson');

	// A team defense keeps only its mascot, in either provider's spelling.
	assert.equal(abbr('Baltimore Ravens', 'Def'), 'Ravens', "MFL's spelling");
	assert.equal(abbr('Eagles D/ST', 'Def'), 'Eagles', "ESPN's spelling — D/ST isn't the mascot");
	// ...and the D/ST guard holds even if the position is missing or spelled
	// differently, since Sleeper reports DEF and ESPN's map says Def.
	assert.equal(abbr('Eagles D/ST', null), 'Eagles');
	assert.equal(abbr('Baltimore Ravens', 'DEF'), 'Ravens');

	// THE case this exists for: a two-word city must not leave its second
	// word stuck to the mascot. Nine of the league's 32 franchises have one
	// (New England, Kansas City, Green Bay, Tampa Bay, Las Vegas, New
	// Orleans, San Francisco, both New York teams) — "drop the first word"
	// would have left "England Patriots" on the row. Keeping the LAST word
	// instead is right regardless of how many words came before it.
	assert.equal(abbr('New England Patriots', 'Def'), 'Patriots');
	assert.equal(abbr('Kansas City Chiefs', 'DEF'), 'Chiefs');
	assert.equal(abbr('San Francisco 49ers', 'Def'), '49ers', 'a numeric mascot is still just the last word');

	// Degenerate inputs don't throw or produce a stray dot.
	assert.equal(abbr('Ravens', 'Def'), 'Ravens', 'already just the mascot');
	assert.equal(abbr('Cher', 'WR'), 'Cher', 'a one-word name has no first name to cut');
	assert.equal(abbr('', 'WR'), '');
	assert.equal(abbr(null, 'WR'), '');
}

// --- playerGameLine, and the abbreviation join it depends on ---
{
	const ctx = makeContext();
	// Shaped exactly as api/live-scoring.js serializes fetchNflGames' map:
	// keyed under every provider's spelling of the same team.
	const kickoff = '2026-09-13T17:00:00.000Z';
	setLiveGames(ctx, {
		CIN: { opponent: 'TB', isHome: true, kickoff, state: 'pre', detail: null, secondsRemaining: 3600 },
		BUF: { opponent: 'HOU', isHome: false, kickoff, state: 'pre', detail: null, secondsRemaining: 3600 },
		// "4:35 - 1st" is the real shortDetail shape the scoreboard publishes
		// for a live game (probe-live-scoring-players.yml), not the "Q3 5:22"
		// this was first written against.
		LV: { opponent: 'DEN', isHome: false, kickoff, state: 'in', detail: '4:35 - 1st', secondsRemaining: 1200 },
		LVR: { opponent: 'DEN', isHome: false, kickoff, state: 'in', detail: '4:35 - 1st', secondsRemaining: 1200 },
		SEA: { opponent: 'NE', isHome: true, kickoff, state: 'post', detail: 'Final', secondsRemaining: 0 },
		NYG: { opponent: null, isHome: true, kickoff, state: 'pre', detail: null, secondsRemaining: 3600 },
	});

	// A home game is the bare opponent code; away carries the @. ESPN's own
	// convention, and the screenshot this card was modelled on.
	// The time half is joined with non-breaking spaces (see playerGameLine),
	// so comparisons here normalize it back to plain spaces for readability.
	const line = (team) => { const l = ctx.playerGameLine(team); return l && l.replace(/\u00a0/g, ' '); };
	assert.match(line('CIN'), /^TB /, 'home game has no @');
	assert.match(line('BUF'), /^@HOU /, 'away game carries the @');

	// The only breakable space is the one between the opponent and the time.
	// Without this a desktop-width card strands a lone "PM" on its own line.
	const raw = ctx.playerGameLine('BUF');
	assert.equal((raw.match(/ /g) || []).length, 1, 'exactly one ordinary space, after the opponent');
	assert.ok(raw.includes('\u00a0'), 'and the time itself is non-breaking');

	// Once a game is underway the kickoff time stops being the useful fact
	// and the scoreboard's own status string takes over, verbatim.
	assert.equal(line('LV'), '@DEN 4:35 - 1st');
	assert.equal(line('SEA'), 'NE Final');

	// THE join assertion: MFL pads its team codes, so the same player read
	// from MFL (LVR) and from Sleeper (LV) must both resolve. Without the
	// alias keys, eight teams' worth of players get no line at all and
	// nothing on screen says why.
	assert.equal(line('LVR'), line('LV'), "MFL's LVR resolves the same game as LV");

	// A team not in the map (a bye, or the scoreboard not covering it) gets
	// no line rather than a half-built one.
	assert.equal(ctx.playerGameLine('MIA'), null, 'a bye team has no line');
	assert.equal(ctx.playerGameLine(null), null);
	assert.equal(ctx.playerGameLine(undefined), null);

	// An unidentifiable opponent still yields the time half rather than
	// dropping the line or printing a bare "@".
	const lone = line('NYG');
	assert.ok(lone && !lone.includes('@'), 'no opponent means no @ and no empty code');

	// The kickoff is formatted from the ISO timestamp in the VIEWER's
	// timezone — never on the server, which runs in UTC. Asserted as
	// "whatever this runtime's locale makes of that instant" rather than a
	// fixed string, since the point is that it is locale-driven.
	const at = new Date(kickoff);
	const expected = `${at.toLocaleDateString(undefined, { weekday: 'short' })} ${at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
	assert.equal(line('CIN'), `TB ${expected}`);
	assert.ok(/\d/.test(expected) && !expected.includes(','), 'weekday and time, no comma between them');

	// A malformed kickoff degrades to the opponent alone rather than
	// rendering "Invalid Date".
	setLiveGames(ctx, { CIN: { opponent: 'TB', isHome: true, kickoff: 'not-a-date', state: 'pre', detail: null } });
	assert.equal(line('CIN'), 'TB');
}

// --- both, as actually rendered into the drawer ---
{
	const ctx = makeContext(LOGGED_IN);
	ctx.liveScoringAttempted = true;
	setLiveGames(ctx, {
		CIN: { opponent: 'TB', isHome: true, kickoff: '2026-09-13T17:00:00.000Z', state: 'pre', detail: null },
		JAX: { opponent: 'CLE', isHome: true, kickoff: '2026-09-13T17:00:00.000Z', state: 'pre', detail: null },
	});
	const league = leagueWithMatchup();
	const card = ctx.renderScoringCard(league);
	findAll(card, hasClass('scoring-detail-toggle'))[0].listeners.click[0]();
	const body = findAll(card, hasClass('scoring-detail-body'))[0];

	const names = findAll(body, hasClass('scoring-detail-name')).map(fullText);
	assert.match(names[0], /J\. Burrow/, 'the first name is abbreviated in the rendered row');
	assert.ok(!names[0].includes('Joe'), 'and the full given name is gone');
	assert.match(names[1], /T\. Lawrence/);

	// The game line renders as its own sub-line under the name, not inline
	// with it and not as a column.
	const gameLines = findAll(body, hasClass('scoring-detail-game')).map(fullText);
	assert.equal(gameLines.length, 2, 'only the two players whose teams are in the schedule get a line');
	assert.ok(gameLines.some((g) => g.startsWith('TB ')), 'Burrow (CIN, home vs TB)');
	assert.ok(gameLines.some((g) => g.startsWith('CLE ')), 'Lawrence (JAX, home vs CLE)');
	// The players on teams absent from the schedule are still rendered — they
	// just carry no game line.
	assert.equal(findAll(body, hasClass('scoring-detail-row')).length, 3);
}

// --- isPlayerLive and the red "still moving" flag on the toggle + rows ---
// A currently-playing player (scoreboard state 'in') is the one thing this
// drawer highlights unprompted — everyone else (pre-kickoff, final, or a
// team the scoreboard never covered) must render exactly as before.
{
	const ctx = makeContext(LOGGED_IN);
	ctx.liveScoringAttempted = true;
	setLiveGames(ctx, {
		CIN: { opponent: 'TB', isHome: true, kickoff: null, state: 'in', detail: '4:35 - 1st' },
		JAX: { opponent: 'CLE', isHome: true, kickoff: null, state: 'pre', detail: null },
		ATL: { opponent: 'CAR', isHome: true, kickoff: null, state: 'post', detail: 'Final' },
		// BUF deliberately absent — a team the scoreboard doesn't cover is not
		// live, same as a bye.
	});
	const league = leagueWithMatchup();
	const card = ctx.renderScoringCard(league);

	// The toggle strip carries the flag collapsed, before the drawer is even
	// opened — Burrow (CIN) is live, so the matchup as a whole is flagged.
	const toggle = findAll(card, hasClass('scoring-detail-toggle'))[0];
	assert.ok(toggle.cls.split(/\s+/).includes('scoring-detail-live'), 'a live player in the matchup flags the toggle');

	toggle.listeners.click[0]();
	const body = findAll(card, hasClass('scoring-detail-body'))[0];
	const rows = findAll(body, hasClass('scoring-detail-row'));
	assert.deepEqual(rows.map((r) => fullText(findAll(r, hasClass('scoring-detail-pos'))[0])), ['QB', 'RB', 'WR']);

	const isLive = (cell) => cell.cls.split(/\s+/).includes('live');
	// QB row: Burrow (CIN, 'in') is live; Lawrence (JAX, 'pre') is not.
	const qbNames = findAll(rows[0], hasClass('scoring-detail-name'));
	const qbPts = findAll(rows[0], hasClass('scoring-detail-pts'));
	assert.ok(isLive(qbNames[0]) && isLive(qbPts[0]), 'the live starter’s name and score both flag red');
	assert.ok(!isLive(qbNames[1]) && !isLive(qbPts[1]), 'a game that hasn’t kicked off gets no highlight');

	// RB row: Cook (BUF, not in the schedule map) and Robinson (ATL, 'post')
	// are both non-live — a missing team must not be mistaken for live.
	const rbNames = findAll(rows[1], hasClass('scoring-detail-name'));
	const rbPts = findAll(rows[1], hasClass('scoring-detail-pts'));
	assert.ok(!isLive(rbNames[0]) && !isLive(rbPts[0]), 'a team absent from the schedule is not live');
	assert.ok(!isLive(rbNames[1]) && !isLive(rbPts[1]), 'a finished game gets no highlight');

	// WR row: London (ATL, 'post') — same, no highlight once the game is over.
	const wrNames = findAll(rows[2], hasClass('scoring-detail-name'));
	assert.ok(!isLive(wrNames[1]), 'a finished game’s starter is never highlighted');
}

// No live player anywhere in the matchup: the toggle stays exactly as it was
// before this feature existed.
{
	const ctx = makeContext(LOGGED_IN);
	ctx.liveScoringAttempted = true;
	setLiveGames(ctx, {
		CIN: { opponent: 'TB', isHome: true, kickoff: null, state: 'pre', detail: null },
	});
	const card = ctx.renderScoringCard(leagueWithMatchup());
	const toggle = findAll(card, hasClass('scoring-detail-toggle'))[0];
	assert.ok(!toggle.cls.split(/\s+/).includes('scoring-detail-live'), 'nobody live means no red flag');
}

// --- Stat breakdown popover: a starter carrying providers.mjs' `stats`
// array (see espnStatBreakdown/sleeperStatBreakdown/
// mflStatBreakdownFromBoxscore — test-stat-breakdown.mjs and
// test-mfl-boxscore-breakdown.mjs pin those) gets a clickable score that
// opens the Stat Breakdown popover with one row per category, in the order
// providers.mjs already sorted them (largest contribution first); every
// other starter in the same drawer, carrying no `stats` at all (an
// unresolved name join, a missing rate, a bye — MFL players never carried
// this before the ESPN-boxscore workaround, and can still land here empty
// for any of those reasons even with it), keeps a plain-text score exactly
// as before this feature existed. This front-end wiring test doesn't care
// which provider a `stats` array came from — it only cares whether one is
// present. ---
{
	const ctx = makeContext(LOGGED_IN);
	ctx.liveScoringAttempted = true;
	const league = leagueWithMatchup();
	league.scoring.teams[0].players[0].stats = [
		{ label: 'Passing Yards', raw: 300, points: 12 },
		{ label: 'Passing Touchdowns', raw: 2, points: 12 },
	];
	const card = ctx.renderScoringCard(league);
	const toggle = findAll(card, hasClass('scoring-detail-toggle'))[0];
	toggle.listeners.click[0]();
	const body = findAll(card, hasClass('scoring-detail-body'))[0];

	const links = findAll(body, hasClass('scoring-detail-pts-link'));
	assert.equal(links.length, 1, 'only the one starter carrying a stats array gets a clickable score');
	assert.equal(fullText(links[0]), '18.40', 'the button still shows the same formatted score plain text would');

	links[0].listeners.click[0]({ stopPropagation() {} });
	const popover = findAll(ctx.document.body, hasClass('scoringDetail-popover'))[0];
	assert.ok(popover, 'clicking the score opens the Stat Breakdown popover');
	assert.match(fullText(findAll(popover, hasClass('popover-title'))[0]), /Joe Burrow — Stat Breakdown/);
	const rows = findAll(popover, hasClass('popover-row'));
	assert.equal(rows.length, 2);
	assert.equal(fullText(rows[0].children[0]), '300 Passing Yards');
	assert.equal(fullText(rows[0].children[1]), '12.0');
	assert.equal(fullText(rows[1].children[0]), '2 Passing Touchdowns');
	assert.equal(fullText(rows[1].children[1]), '12.0');
}

// --- The nested "Show bench" drawer (appendBenchDetail) ---
// A second toggle inside the starter drawer's own body, for t.bench[] — the
// same drawer machinery (pairStartersByPosition, appendDetailSide, the
// empty-state message, localStorage round-tripping) reused rather than
// duplicated, since a bench player renders no differently from a starter
// once you have one in hand.
{
	const ctx = makeContext(LOGGED_IN);
	ctx.liveScoringAttempted = true;
	const card = ctx.renderScoringCard(leagueWithMatchup());

	// Before the starter drawer is even opened, nothing bench-related exists
	// yet — appendBenchDetail is only called from inside fill(), same lazy
	// posture as the starter rows themselves.
	assert.equal(findAll(card, hasClass('scoring-bench-toggle')).length, 0, 'no bench toggle before the starter drawer opens');

	const outerToggle = findAll(card, hasClass('scoring-detail-toggle'))[0];
	outerToggle.listeners.click[0]();

	// The starter grid fills as usual — three rows (QB, RB, and the WR only
	// Team Two started) — before the bench toggle has been touched at all.
	const starterBody = findAll(card, hasClass('scoring-detail-body'))[0];
	assert.equal(findAll(starterBody, hasClass('scoring-detail-row')).length, 3);

	const benchToggle = findAll(card, hasClass('scoring-bench-toggle'))[0];
	assert.ok(benchToggle, 'opening the starter drawer builds the nested bench toggle');
	assert.equal(benchToggle.getAttribute('aria-expanded'), 'false', 'the bench drawer starts closed independently of the starter drawer above it');
	assert.match(fullText(benchToggle), /Show bench/);
	// It's still a .scoring-detail-toggle (shares the base styling/markup),
	// just never carries the starter toggle's own live-flag modifier — see
	// appendBenchDetail's own comment for why a bench player's real-world
	// game state isn't "notable" the way a starter's is.
	assert.ok(benchToggle.cls.split(/\s+/).includes('scoring-detail-toggle'));
	assert.ok(!benchToggle.cls.split(/\s+/).includes('scoring-detail-live'));

	const benchBody = findAll(card, hasClass('scoring-bench-body'))[0];
	assert.ok(benchBody, 'the bench body exists');
	assert.equal(benchBody.hidden, true, 'and is hidden while closed');
	assert.equal(findAll(benchBody, hasClass('scoring-detail-row')).length, 0, 'closed bench drawer builds no rows');

	// Open it.
	benchToggle.listeners.click[0]();
	assert.equal(benchBody.hidden, false);
	assert.equal(benchToggle.getAttribute('aria-expanded'), 'true');
	assert.match(fullText(benchToggle), /Hide bench/);

	const benchRows = findAll(benchBody, hasClass('scoring-detail-row'));
	assert.equal(benchRows.length, 2, 'the WR bench player on one side and the TE on the other, unpaired by position');
	const benchNames = benchRows.map((r) => findAll(r, hasClass('scoring-detail-name')).map(fullText));
	// Same abbreviatePlayerName treatment as any starter's name — nothing
	// about being on the bench changes how a name renders.
	assert.match(benchNames[0][0], /B\. One/, "Team One's bench player renders through the exact same name pipeline as a starter");
	assert.equal(benchNames[0][1], '', 'no Team Two bench player at WR — the padded side');
	assert.match(benchNames[1][1], /B\. Two/);

	// The starter grid above is completely unaffected by opening the nested
	// drawer — the bench body nests inside the starter body's own DOM
	// subtree (hence 3 + 2 here), but the starter rows built above are still
	// exactly the same three; nothing was rebuilt or duplicated.
	assert.equal(findAll(starterBody, hasClass('scoring-detail-row')).length, 5, '3 starter rows plus the 2 bench rows nested inside the same body');
}

// The bench toggle's own open state round-trips through localStorage, under
// its own key (the starter drawer's key plus a suffix) — independently of
// the starter drawer, which is the whole point of nesting a SECOND toggle
// rather than one flag for the whole body.
{
	const ctx = makeContext(LOGGED_IN);
	ctx.liveScoringAttempted = true;

	const card1 = ctx.renderScoringCard(leagueWithMatchup());
	findAll(card1, hasClass('scoring-detail-toggle'))[0].listeners.click[0]();
	findAll(card1, hasClass('scoring-bench-toggle'))[0].listeners.click[0]();

	const keys = [...ctx.__store.keys()].filter((k) => k.startsWith('myfflScoringDetailOpen'));
	assert.equal(keys.length, 2, 'the starter drawer and the bench drawer each write their own key');
	assert.ok(keys.some((k) => k.endsWith(':bench')), 'the bench key is the starter key with a :bench suffix');

	// Re-render, the same way a poll would — both stay open, and the bench
	// grid is filled immediately rather than reopening empty.
	const card2 = ctx.renderScoringCard(leagueWithMatchup());
	const benchBody2 = findAll(card2, hasClass('scoring-bench-body'))[0];
	assert.equal(benchBody2.hidden, false, 'the rebuilt bench drawer comes back open');
	assert.equal(findAll(benchBody2, hasClass('scoring-detail-row')).length, 2);

	// Closing only the bench toggle leaves the starter drawer's own key
	// alone.
	findAll(card2, hasClass('scoring-bench-toggle'))[0].listeners.click[0]();
	const keysAfter = [...ctx.__store.keys()].filter((k) => k.startsWith('myfflScoringDetailOpen'));
	assert.equal(keysAfter.length, 1, 'closing the bench drawer removes only its own key');
	assert.ok(!keysAfter[0].endsWith(':bench'));
}

// Before the first live poll answers (or a provider matchup carries no
// bench at all), the bench grid says so rather than opening onto nothing —
// same posture as the starter grid's own "No starter detail yet" message.
{
	const ctx = makeContext(LOGGED_IN);
	ctx.liveScoringAttempted = true;
	const league = leagueWithMatchup();
	for (const t of league.scoring.teams) delete t.bench;
	const card = ctx.renderScoringCard(league);
	findAll(card, hasClass('scoring-detail-toggle'))[0].listeners.click[0]();
	findAll(card, hasClass('scoring-bench-toggle'))[0].listeners.click[0]();
	const benchBody = findAll(card, hasClass('scoring-bench-body'))[0];
	assert.equal(findAll(benchBody, hasClass('scoring-detail-row')).length, 0);
	const empty = findAll(benchBody, hasClass('scoring-detail-empty'))[0];
	assert.ok(empty, 'an explanatory line instead');
	assert.match(fullText(empty), /No bench detail yet/);
}

// --- benchDetailLeagueIds: which leagues get bench fetched this poll ---
// Read straight from localStorage (see its own comment for why) rather
// than tracked incrementally, so this pins the parsing directly: a real
// bench key counts, a starter-only key or an unrelated namespace's key
// doesn't, two different leagues both count, and a key stored under the
// OTHER viewport bucket (matchMedia stubbed to desktop here) is ignored —
// a phone reader's open bench drawer must not leak into a desktop poll's
// request and vice versa.
{
	const ctx = makeContext({
		'myfflScoringDetailOpen:desktop:26696:0009v0010:bench': '1',
		'myfflScoringDetailOpen:desktop:99999:0001v0002:bench': '1',
		'myfflScoringDetailOpen:desktop:26696:0009v0010': '1', // starter-only, no :bench suffix
		'myfflScoringDetailOpen:mobile:11111:0003v0004:bench': '1', // wrong bucket
		'myfflCardCollapsed:desktop:some-other-card': '1', // unrelated namespace
	});
	assert.deepEqual([...ctx.benchDetailLeagueIds()].sort(), ['26696', '99999']);
}
{
	// Nothing stored at all — the common case (nobody has any bench drawer
	// open) — degrades to an empty set, not an error.
	const ctx = makeContext();
	assert.deepEqual([...ctx.benchDetailLeagueIds()], []);
}

// --- Opening a bench drawer kicks an immediate refresh; closing doesn't ---
// Bench is only ever fetched for leagues named in benchDetailLeagueIds, so
// the poll that was already in flight when the reader clicked "Show bench"
// never asked for this league's bench — without this nudge the drawer
// would sit on "waiting on the next live update" for up to
// LIVE_SCORING_POLL_MS instead of resolving right away. refreshLiveScoring
// is a top-level function declaration, reassignable the same way
// setLiveGames reassigns the `let liveGames` binding.
{
	const ctx = makeContext(LOGGED_IN);
	ctx.liveScoringAttempted = true;
	let calls = 0;
	ctx.__spy = () => { calls++; };
	vm.runInContext('refreshLiveScoring = __spy;', ctx);

	const card = ctx.renderScoringCard(leagueWithMatchup());
	findAll(card, hasClass('scoring-detail-toggle'))[0].listeners.click[0]();
	const benchToggle = findAll(card, hasClass('scoring-bench-toggle'))[0];

	benchToggle.listeners.click[0](); // open
	assert.equal(calls, 1, 'opening a bench drawer kicks an immediate refresh');

	benchToggle.listeners.click[0](); // close
	assert.equal(calls, 1, 'closing does not — data already in hand does not go stale by being hidden');
}

// --- refreshLiveScoring's own URL carries benchLeagues only when something's open ---
{
	const ctx = makeContext({
		'myfflScoringDetailOpen:desktop:26696:0009v0010:bench': '1',
	});
	ctx.liveScoringAttempted = true;
	let capturedUrl = null;
	ctx.fetch = async (url) => {
		capturedUrl = url;
		return { ok: true, json: async () => ({ generatedAt: new Date().toISOString(), games: {}, leagues: [] }) };
	};
	ctx.__testPageData = { leagues: [] };
	vm.runInContext('pageData = __testPageData;', ctx);

	await ctx.refreshLiveScoring();
	assert.ok(capturedUrl.includes('benchLeagues=26696'), `expected a benchLeagues param, got ${capturedUrl}`);
}
{
	const ctx = makeContext();
	ctx.liveScoringAttempted = true;
	let capturedUrl = null;
	ctx.fetch = async (url) => {
		capturedUrl = url;
		return { ok: true, json: async () => ({ generatedAt: new Date().toISOString(), games: {}, leagues: [] }) };
	};
	ctx.__testPageData = { leagues: [] };
	vm.runInContext('pageData = __testPageData;', ctx);

	await ctx.refreshLiveScoring();
	assert.ok(!capturedUrl.includes('benchLeagues'), `expected no benchLeagues param when nothing is open, got ${capturedUrl}`);
}

// --- Live-status ticking, and the "Live updates on" framing gated on
// anyGameLive() ---
// LIVE_SCORING_IDLE_POLL_MS can now be 30 minutes (see its own comment) —
// without a display-only clock independent of the poll itself, "last
// refreshed X ago" would freeze at whatever it said the instant the last
// poll landed (almost always "just now") and silently lie for the next 29
// minutes. renderLiveStatusFreshness is what repaints it from
// lastLiveGeneratedAt, on liveStatusTickTimer's own interval — and, since a
// manager isn't watching anything actually update outside a live game, it
// shows only the bare freshness fact then, saving the "Live updates on"/
// reload-warning framing for when a game is genuinely in progress.
{
	const ctx = makeContext();
	// The shared domNode()/getElementById() stub hands back a fresh blank
	// node on every call, by id or not — fine for tests that only care
	// what one call built, useless for one that needs to read the SAME
	// node back after a later, separate repaint. Overriding just the
	// 'live-status' id here (not the shared helper, which every other test
	// in this file still relies on returning a fresh node) is what makes
	// that observable.
	const statusNode = domNode();
	const realGetById = ctx.document.getElementById;
	ctx.document.getElementById = (id) => (id === 'live-status' ? statusNode : realGetById(id));

	ctx.liveScoringAttempted = true;
	ctx.fetch = async () => ({
		ok: true,
		json: async () => ({ generatedAt: new Date().toISOString(), games: { BUF: { state: 'in' } }, leagues: [] }),
	});
	ctx.__testPageData = { leagues: [] };
	vm.runInContext('pageData = __testPageData;', ctx);
	// Mirrors what startLiveScoringPolling sets before its own
	// refreshLiveScoring call — a direct refreshLiveScoring() call with
	// polling never started (exactly what the benchLeagues tests above do)
	// must NOT start a ticker; see the case below.
	vm.runInContext('liveScoringPollingEnabled = true;', ctx);

	await ctx.refreshLiveScoring();
	assert.match(fullText(statusNode), /Live updates on — last refreshed just now — No need to manually refresh/, 'em-dash-joined, no periods, freshly landed, a game genuinely live');
	assert.equal(vm.runInContext('!!liveStatusTickTimer', ctx), true, 'the ticker starts once polling is actually enabled');

	// The clock moves on with no new poll landing — the ticker repaints
	// from the SAME lastLiveGeneratedAt the poll set, not a string frozen
	// at poll time. Still framed as "Live updates on" — this game is still
	// live, from the same poll's own liveGames.
	vm.runInContext('lastLiveGeneratedAt = new Date(Date.now() - 5 * 60000).toISOString();', ctx);
	vm.runInContext('renderLiveStatusFreshness();', ctx);
	assert.match(fullText(statusNode), /Live updates on — last refreshed 5 min ago — No need to manually refresh/, 'a tick repaints from the stored timestamp instead of staying "just now", still framed as live');

	// Nothing live any more (the idle 30-minute fallback window) — the
	// framing drops to a bare fact rather than continuing to claim
	// something is actively updating.
	vm.runInContext('liveGames = {};', ctx);
	vm.runInContext('renderLiveStatusFreshness();', ctx);
	assert.equal(fullText(statusNode), 'Last refreshed 5 min ago', 'no game live: just the fact, no "Live updates on" framing or reload warning');

	vm.runInContext('stopLiveScoringPolling();', ctx);
	assert.equal(vm.runInContext('!!liveStatusTickTimer', ctx), false, 'leaving/backgrounding the Scoring tab clears the ticker');
}

// A one-off refreshLiveScoring() call outside the regular polling chain —
// exactly what the benchLeagues tests above do, and exactly the shape a
// real setInterval left running would have hung this very test file on
// (Node has nothing else keeping the process open once the script body
// finishes) — must never start a ticker nobody will ever stop.
{
	const ctx = makeContext();
	ctx.liveScoringAttempted = true;
	ctx.fetch = async () => ({ ok: true, json: async () => ({ generatedAt: new Date().toISOString(), games: {}, leagues: [] }) });
	ctx.__testPageData = { leagues: [] };
	vm.runInContext('pageData = __testPageData;', ctx);

	await ctx.refreshLiveScoring();
	assert.equal(vm.runInContext('!!liveStatusTickTimer', ctx), false, 'no ticker when polling was never started');
}

// --- nextLiveScoringDelayMs: fast while something's live, the slow
// fallback otherwise (nearly all of a week, since games are live only a
// handful of hours) — pins the actual threshold, not just "some number",
// and that the fallback really is slower rather than a copy-paste of the
// fast constant.
{
	const ctx = makeContext();
	const fastMs = vm.runInContext('LIVE_SCORING_POLL_MS', ctx);
	const idleMs = vm.runInContext('LIVE_SCORING_IDLE_POLL_MS', ctx);
	assert.ok(idleMs > fastMs, 'the idle fallback is genuinely slower than the live cadence');

	setLiveGames(ctx, {});
	assert.equal(ctx.nextLiveScoringDelayMs(), idleMs, 'no games at all: the slow fallback');

	setLiveGames(ctx, { CIN: { state: 'pre' }, ATL: { state: 'post' } });
	assert.equal(ctx.nextLiveScoringDelayMs(), idleMs, 'scheduled and final are not "live" — still the fallback');

	setLiveGames(ctx, { CIN: { state: 'pre' }, SEA: { state: 'in' } });
	assert.equal(ctx.nextLiveScoringDelayMs(), fastMs, 'one genuinely live game anywhere is enough to stay fast');
}

// --- Pausing the live-scoring poll while the browser tab is backgrounded ---
// A manager who leaves the Scoring tab open in a hidden browser tab must not
// keep polling MFL every 30s for a screen nobody is looking at, and must
// pick back up immediately — not wait out the interval — the moment it's
// visible again.
{
	const ctx = makeContext(LOGGED_IN);
	vm.runInContext("currentView = 'scoring';", ctx);
	let calls = 0;
	ctx.__spy = () => { calls++; };
	vm.runInContext('refreshLiveScoring = __spy;', ctx);

	ctx.startLiveScoringPolling();
	assert.equal(calls, 1, 'starting polling fires an immediate poll');
	assert.equal(vm.runInContext('liveScoringPollingEnabled', ctx), true);

	fireVisibilityChange(ctx, 'hidden');
	assert.equal(vm.runInContext('liveScoringPollingEnabled', ctx), false, 'backgrounding the tab pauses polling');
	assert.equal(calls, 1, 'and does not itself trigger a poll');

	fireVisibilityChange(ctx, 'visible');
	assert.equal(calls, 2, 'coming back resumes with an immediate poll rather than waiting out the interval');
	assert.equal(vm.runInContext('liveScoringPollingEnabled', ctx), true);
}

// The pause/resume listener must never act for a reader who backgrounds the
// browser from some OTHER tab (Rosters, say) — switchToView's own
// start/stopLiveScoringPolling calls already own that transition, and this
// listener firing there too would be at best redundant and at worst wrong
// if the two ever disagreed.
{
	const ctx = makeContext(LOGGED_IN);
	// currentView defaults to 'rosters' — deliberately left untouched.
	let calls = 0;
	ctx.__spy = () => { calls++; };
	vm.runInContext('refreshLiveScoring = __spy;', ctx);

	fireVisibilityChange(ctx, 'hidden');
	fireVisibilityChange(ctx, 'visible');
	assert.equal(calls, 0, 'polling was never started for this view, so visibility changes are a no-op');
	assert.equal(vm.runInContext('liveScoringPollingEnabled', ctx), false);
}

console.log('test-scoring-details.mjs OK');
