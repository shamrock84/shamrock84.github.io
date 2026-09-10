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
		set textContent(v) { n._text = v; },
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
		// cardCollapseStorageKey buckets its key by viewport, so the drawer's
		// own state helpers need this — desktop bucket here.
		window: { addEventListener() {}, matchMedia: () => ({ matches: false }) },
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
				},
				{
					franchiseId: '2', teamName: 'Team Two', score: '10.0',
					players: [
						{ id: '333', name: 'Trevor Lawrence', position: 'QB', team: 'JAX', points: 0 },
						{ id: '444', name: 'Bijan Robinson', position: 'RB', team: 'ATL', points: 7.25 },
						{ id: '555', name: 'Drake London', position: 'WR', team: 'ATL', points: 3 },
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

	// Team defenses are never abbreviated, in either provider's spelling.
	assert.equal(abbr('Baltimore Ravens', 'Def'), 'Baltimore Ravens', "MFL's spelling");
	assert.equal(abbr('Eagles D/ST', 'Def'), 'Eagles D/ST', "ESPN's spelling");
	// ...and the D/ST guard holds even if the position is missing or spelled
	// differently, since Sleeper reports DEF and ESPN's map says Def.
	assert.equal(abbr('Eagles D/ST', null), 'Eagles D/ST');
	assert.equal(abbr('Baltimore Ravens', 'DEF'), 'Baltimore Ravens');

	// Degenerate inputs don't throw or produce a stray dot.
	assert.equal(abbr('Ravens', 'Def'), 'Ravens');
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

console.log('test-scoring-details.mjs OK');
