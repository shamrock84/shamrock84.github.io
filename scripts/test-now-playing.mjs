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
//   * kickers and defenses are excluded outright, mine or not.
//   * draftonly leagues (no live scoring at all) contribute nothing.
//   * the cross-league merge by normalizeName only ever merges MY OWN
//     entries across leagues — a same-named player an opponent owns in a
//     different league must not be folded in as a third "team" I hold him
//     in, which would silently inflate the league count and the score.
//   * the rendered card reflects all of the above — an opponent's player
//     never appears on screen, even when live in the same matchup as mine.

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
function league(id, franchiseId, myPlayers, opponentPlayers = [], type = 'dynasty') {
	return {
		id, type, url: `https://example.com/${id}`, displayName: `League ${id}`,
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

// Kickers and defenses are excluded outright, mine or not, live or not.
{
	const ctx = makeContext();
	setLiveGames(ctx, { BAL: { state: 'in' } });
	const rows = ctx.computeNowPlaying([league('L4', '0001', [
		{ name: 'Kicker Guy', position: 'PK', team: 'BAL', points: 8 },
		{ name: 'Some Defense', position: 'Def', team: 'BAL', points: 5 },
	])]);
	assert.equal(rows.length, 0, 'kickers and defenses never appear here');
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
