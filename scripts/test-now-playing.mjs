// Unit test for the Scoring tab's Now Playing card in myffl.html.
//
// The one rule this card exists to enforce, stated explicitly by the
// manager who asked for it: it shows players who are BOTH currently live
// AND on one of MY OWN teams — never every live player league-wide. That
// distinction is easy to get quietly wrong, since a league's live-scoring
// response carries every franchise's starters, not just mine, and every
// failure mode here renders as a perfectly plausible row: an opponent's
// star quarterback having a big game looks exactly like one of mine would.
// So this pins:
//
//   * computeNowPlaying only ever reads the ONE team per league flagged
//     isMe — an opponent's live starter, however live or however big his
//     score, never produces a row.
//   * a league with no isMe team at all (misconfigured, or one you're only
//     watching) contributes nothing, not every team in it.
//   * isPlayerLive still gates entry — a benched-in-time-but-not-yet-kicked-
//     off starter of mine doesn't appear just because he's mine.
//   * kickers and defenses appear the same as any other live starter of
//     mine — no position is excluded from this card.
//   * draftonly leagues (no live scoring at all) contribute nothing.
//   * the cross-league merge by normalizeName only ever merges MY OWN
//     entries across leagues — a same-named player an opponent owns in a
//     different league must not be folded in as a third "team" I hold him
//     in, which would silently inflate the league count and the score.
//   * the rendered card reflects all of the above — an opponent's player
//     never appears on screen, even when live in the same matchup as mine.
//   * when a player's cross-league merge spans more than one provider, the
//     displayed entry is picked by provider (MFL, then ESPN, then Sleeper),
//     never by whichever league happens to score him highest — a league
//     running deliberately nonstandard scoring (the concrete case: a Scott
//     Fish Bowl Sleeper league) must not lead the row just because its
//     rules pay out more for the same play.

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
	return ctx;
}

const LOGGED_IN = { mflAuthToken: 'test-token' };

// `liveGames` is a top-level `let` in the page's script — see
// test-scoring-details.mjs's identical helper for why a plain
// ctx.liveGames assignment wouldn't reach the real binding.
function setLiveGames(ctx, games) {
	ctx.__testGames = games;
	vm.runInContext('liveGames = __testGames;', ctx);
}

// Same story for `liveScoringAttempted` — also a top-level `let`, and
// renderNowPlayingCard checks it before anything else, so (unlike
// test-scoring-details.mjs's own leagues, which always carry non-empty
// teams[] and never actually exercise this check) a plain
// ctx.liveScoringAttempted = true here would silently leave every card
// stuck on "Loading live scores…" while looking like it worked.
function setLiveScoringAttempted(ctx, value) {
	ctx.__testAttempted = value;
	vm.runInContext('liveScoringAttempted = __testAttempted;', ctx);
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

// A league with one starter of mine and, optionally, one of an opponent's —
// shaped exactly like the live-scoring response's teams[] (see
// scripts/lib/providers.mjs' fetchScoring/fetchEspnScoring/
// fetchSleeperScoring, all of which return this same { franchiseId,
// teamName, isMe, players } shape per team, mine included with everyone
// else's).
function league(id, franchiseId, myPlayers, opponentPlayers = [], type = 'dynasty', nickname, provider) {
	return {
		id, type, url: `https://example.com/${id}`, displayName: `League ${id}`, nickname, provider,
		scoring: {
			teams: [
				{ franchiseId, teamName: 'Mine', isMe: true, players: myPlayers },
				{ franchiseId: `${franchiseId}-opp`, teamName: 'Opponent', isMe: false, players: opponentPlayers },
			],
		},
	};
}

// --- computeNowPlaying: the pure function ---

// THE assertion this suite exists for: an opponent's live starter, however
// big his score, never produces a row — only the row for MY live starter
// in the same matchup does.
{
	const ctx = makeContext();
	setLiveGames(ctx, { BUF: { state: 'in' }, KC: { state: 'in' } });
	const rows = ctx.computeNowPlaying([
		league('L1', '0001',
			[{ name: 'My Guy', position: 'QB', team: 'BUF', points: 20 }],
			[{ name: 'Their Guy', position: 'QB', team: 'KC', points: 99 }]
		),
	]);
	assert.equal(rows.length, 1, 'only my own live starter produces a row');
	assert.equal(rows[0].name, 'My Guy');
	assert.ok(!rows.some((r) => r.name === 'Their Guy'), "the opponent's live player never appears, however live or high-scoring");
}

// A league where no team is flagged isMe (a misconfiguration, or a league
// this account only watches) contributes nothing — not every team in it.
{
	const ctx = makeContext();
	setLiveGames(ctx, { BUF: { state: 'in' } });
	const rows = ctx.computeNowPlaying([{
		id: 'L2', type: 'dynasty', displayName: 'No Mine',
		scoring: {
			teams: [
				{ franchiseId: 'a', teamName: 'A', isMe: false, players: [{ name: 'X', position: 'QB', team: 'BUF', points: 10 }] },
				{ franchiseId: 'b', teamName: 'B', isMe: false, players: [{ name: 'Y', position: 'QB', team: 'BUF', points: 12 }] },
			],
		},
	}]);
	assert.equal(rows.length, 0, 'no isMe team means nothing from this league, no matter who is live');
}

// isPlayerLive still gates entry — a starter of mine whose game hasn't
// kicked off doesn't appear just because he's mine.
{
	const ctx = makeContext();
	setLiveGames(ctx, { BUF: { state: 'pre' } });
	const rows = ctx.computeNowPlaying([league('L3', '0001', [{ name: 'Not Live Yet', position: 'QB', team: 'BUF', points: 0 }])]);
	assert.equal(rows.length, 0, "mine but not live yet doesn't count");
}

// Kickers and defenses appear here like any other live starter of mine.
{
	const ctx = makeContext();
	setLiveGames(ctx, { BAL: { state: 'in' } });
	const rows = ctx.computeNowPlaying([league('L4', '0001', [
		{ name: 'Kicker Guy', position: 'PK', team: 'BAL', points: 8 },
		{ name: 'Some Defense', position: 'Def', team: 'BAL', points: 5 },
	])]);
	assert.equal(rows.length, 2, 'kickers and defenses appear here now');
	assert.ok(rows.some((r) => r.name === 'Kicker Guy' && r.position === 'PK'));
	assert.ok(rows.some((r) => r.name === 'Some Defense' && r.position === 'Def'));
}

// draftonly leagues never produce live scoring at all (see
// api/live-scoring.js's own hasLiveScoring) — excluded the same way the
// per-league Scoring cards already are.
{
	const ctx = makeContext();
	setLiveGames(ctx, { BUF: { state: 'in' } });
	const rows = ctx.computeNowPlaying([league('L5', '0001', [{ name: 'Draftonly Guy', position: 'QB', team: 'BUF', points: 10 }], [], 'draftonly')]);
	assert.equal(rows.length, 0);
}

// The cross-league merge by normalizeName is scoped to MY OWN entries only.
// A same-named player an opponent owns in a different league — a real
// scenario, since the same NFL player is frequently rostered by someone in
// every league — must not be folded in as a third league I hold him in.
{
	const ctx = makeContext();
	setLiveGames(ctx, { BUF: { state: 'in' } });
	const rows = ctx.computeNowPlaying([
		league('L6', '0001', [{ name: 'Josh Allen', position: 'QB', team: 'BUF', points: 20 }]),
		league('L7', '0002',
			[{ name: 'Josh Allen', position: 'QB', team: 'BUF', points: 24 }],
			[{ name: 'Josh Allen', position: 'QB', team: 'BUF', points: 999 }]
		),
	]);
	assert.equal(rows.length, 1, 'one merged row for the one player');
	assert.equal(rows[0].entries.length, 2, 'the two leagues I actually hold him in — not a third for the opponent who also has him');
	assert.ok(!rows[0].entries.some((e) => e.score === 999), "the opponent's 999 in L7 must never enter the merge");
	assert.equal(rows[0].score, 24, 'the best of MY OWN two scores, not the opponent\'s inflated one');
}

// Cross-provider merge: MFL wins over a higher-scoring Sleeper entry, and
// ESPN wins over a higher-scoring Sleeper entry — provider order decides,
// not magnitude. The Sleeper score here is deliberately the largest of the
// three to prove score is not the tiebreaker when providers differ.
{
	const ctx = makeContext();
	setLiveGames(ctx, { MIN: { state: 'in' } });
	const rows = ctx.computeNowPlaying([
		league('L20', '0001', [{ name: 'Justin Jefferson', position: 'WR', team: 'MIN', points: 6 }], [], 'dynasty', 'MFLLeague', 'mfl'),
		league('L21', '0002', [{ name: 'Justin Jefferson', position: 'WR', team: 'MIN', points: 9 }], [], 'redraft', 'ESPNLeague', 'espn'),
		league('L22', '0003', [{ name: 'Justin Jefferson', position: 'WR', team: 'MIN', points: 14 }], [], 'redraft', 'SleeperLeague', 'sleeper'),
	]);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].score, 6, 'MFL leads even though Sleeper (14) and ESPN (9) score him higher');
}

// Same rule with no MFL entry present: ESPN wins over the higher-scoring
// Sleeper entry.
{
	const ctx = makeContext();
	setLiveGames(ctx, { MIN: { state: 'in' } });
	const rows = ctx.computeNowPlaying([
		league('L23', '0002', [{ name: 'Justin Jefferson', position: 'WR', team: 'MIN', points: 9 }], [], 'redraft', 'ESPNLeague', 'espn'),
		league('L24', '0003', [{ name: 'Justin Jefferson', position: 'WR', team: 'MIN', points: 14 }], [], 'redraft', 'SleeperLeague', 'sleeper'),
	]);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].score, 9, 'ESPN leads over the higher-scoring Sleeper entry when no MFL entry exists');
}

// --- Owning league(s) print as Toolbar Label text, not the old "(N)" popover ---
//
// Replaces a click-through popover that was almost always just "(1)": the
// row now names the league(s) directly, using the same Toolbar Label ->
// Display Name fallback chain quickLinkLabelForLeague already uses for the
// quick-link bar, so a league with no nickname set still prints something.
{
	const ctx = makeContext(LOGGED_IN);
	setLiveScoringAttempted(ctx, true);
	setLiveGames(ctx, { BUF: { state: 'in' } });
	const card = ctx.renderNowPlayingCard([
		league('L12', '0001', [{ name: 'Josh Allen', position: 'QB', team: 'BUF', points: 20 }], [], 'dynasty', 'MNMx'),
		league('L13', '0002', [{ name: 'Josh Allen', position: 'QB', team: 'BUF', points: 24 }]),
	]);

	assert.equal(findAll(card, hasClass('now-playing-count-link')).length, 0, 'the old "(N)" popover button is gone');

	const teamsLine = findAll(card, hasClass('now-playing-teams'))[0];
	assert.ok(teamsLine, 'the owning league(s) print in their own line');
	assert.equal(fullText(teamsLine), 'MNMx, League L13', 'a set nickname and a displayName fallback, comma-joined');
}

// --- renderNowPlayingCard: the same rule, as actually rendered ---

// An opponent's live player must never appear on screen, even sharing a
// matchup — and a live-but-not-mine name must not even show up as a
// substring elsewhere (e.g. inside a league name).
{
	const ctx = makeContext(LOGGED_IN);
	setLiveScoringAttempted(ctx, true);
	setLiveGames(ctx, { BUF: { state: 'in' }, KC: { state: 'in' } });
	const card = ctx.renderNowPlayingCard([
		league('L8', '0001',
			[{ name: 'My Guy', position: 'QB', team: 'BUF', points: 20 }],
			[{ name: 'Their Guy', position: 'QB', team: 'KC', points: 50 }]
		),
	]);
	const text = fullText(card);
	assert.ok(text.includes('My Guy'), 'my own live starter is on the card');
	assert.ok(!text.includes('Their Guy'), "the opponent's live starter is never on the card");

	const rows = findAll(card, hasClass('now-playing-row'));
	assert.equal(rows.length, 1, 'exactly one row — mine, not the opponent\'s');
}

// --- The score as a Stat Breakdown link ---
//
// Same idiom, same gate as appendDetailSide's own score cell in the matchup
// drawer (test-scoring-details.mjs pins that one): a player carrying
// providers.mjs' `stats` array gets a clickable score that opens the same
// Stat Breakdown popover; a player with none — including PK/Def, since
// providers.mjs only ever populates `stats` for skill-position offense —
// keeps a plain-text score exactly as before this feature existed. No
// exclusion list needed here to match that; it falls out of the same field.
{
	const ctx = makeContext(LOGGED_IN);
	setLiveScoringAttempted(ctx, true);
	setLiveGames(ctx, { BAL: { state: 'in' } });
	const withStats = league('L10', '0001', [
		{
			name: 'Stat Guy', position: 'QB', team: 'BAL', points: 18.4,
			stats: [
				{ label: 'Passing Yards', raw: 300, points: 12 },
				{ label: 'Passing Touchdowns', raw: 2, points: 12 },
			],
		},
		{ name: 'Kicker Guy', position: 'PK', team: 'BAL', points: 8 },
	]);
	const card = ctx.renderNowPlayingCard([withStats]);

	const links = findAll(card, hasClass('scoring-detail-pts-link'));
	assert.equal(links.length, 1, 'only the starter carrying a stats array gets a clickable score');
	assert.equal(fullText(links[0]), '18.40', 'the button still shows the same formatted score plain text would');

	const rows = findAll(card, hasClass('now-playing-row'));
	const kickerRow = rows.find((r) => fullText(r).includes('Kicker Guy'));
	assert.equal(findAll(kickerRow, hasClass('scoring-detail-pts-link')).length, 0, 'PK keeps a plain-text score');
	assert.ok(fullText(kickerRow).includes('8.00'), 'the plain-text score still shows');

	links[0].listeners.click[0]({ stopPropagation() {} });
	const popover = findAll(ctx.document.body, hasClass('scoringDetail-popover'))[0];
	assert.ok(popover, 'clicking the score opens the Stat Breakdown popover');
	assert.match(fullText(findAll(popover, hasClass('popover-title'))[0]), /Stat Guy — Stat Breakdown/);
	const popoverRows = findAll(popover, hasClass('popover-row'));
	assert.equal(popoverRows.length, 2);
	assert.equal(fullText(popoverRows[0].children[0]), '300 Passing Yards');
	assert.equal(fullText(popoverRows[0].children[1]), '12.0');
	assert.equal(fullText(popoverRows[1].children[0]), '2 Passing Touchdowns');
	assert.equal(fullText(popoverRows[1].children[1]), '12.0');
}

// --- Always sorted best-first within each position group ---
//
// There used to be a Sort by score toggle on this card; it's gone, and each
// position's own mini-card must always read highest score to lowest with no
// user action needed. computeNowPlaying already sorts its rows globally by
// score (nulls last) before renderNowPlayingCard groups them by position —
// grouping preserves that order (Array#sort is stable), so this pins the
// visible result rather than the sort call itself.
{
	const ctx = makeContext(LOGGED_IN);
	setLiveScoringAttempted(ctx, true);
	setLiveGames(ctx, { BUF: { state: 'in' } });
	const card = ctx.renderNowPlayingCard([
		league('L11', '0001', [
			{ name: 'Low WR', position: 'WR', team: 'BUF', points: 4 },
			{ name: 'High WR', position: 'WR', team: 'BUF', points: 22 },
			{ name: 'Mid WR', position: 'WR', team: 'BUF', points: 11 },
			{ name: 'No Score Yet WR', position: 'WR', team: 'BUF', points: null },
		]),
	]);

	assert.equal(findAll(card, hasClass('now-playing-sort-btn')).length, 0, 'the sort toggle is gone');

	const order = findAll(card, hasClass('now-playing-row')).map((r) => fullText(r));
	assert.ok(order[0].includes('High WR'), 'highest score leads');
	assert.ok(order[1].includes('Mid WR'), 'then the middle score');
	assert.ok(order[2].includes('Low WR'), 'then the lowest score');
	assert.ok(order[3].includes('No Score Yet WR'), 'a score not in yet sinks to the bottom, not sorted as a 0');
}

// Logged out: the card doesn't render at all, same gate as the matchup
// drawer — this is lineup data, not just team-level scores.
{
	const ctx = makeContext();
	setLiveScoringAttempted(ctx, true);
	setLiveGames(ctx, { BUF: { state: 'in' } });
	const card = ctx.renderNowPlayingCard([league('L9', '0001', [{ name: 'My Guy', position: 'QB', team: 'BUF', points: 20 }])]);
	assert.equal(card, null, 'no card at all when logged out');
}

console.log('test-now-playing.mjs OK');
