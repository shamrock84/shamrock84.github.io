// Unit test for the Scoring tab's Now Playing card in myffl.html.
//
// The one rule this card exists to enforce, stated explicitly by the
// manager who asked for it: it shows players who are BOTH playing AND on one
// of MY OWN teams — never every playing player league-wide. That distinction
// is easy to get quietly wrong, since a league's live-scoring response
// carries every franchise's starters, not just mine, and every failure mode
// here renders as a perfectly plausible row: an opponent's star quarterback
// having a big game looks exactly like one of mine would. So this pins:
//
//   * computeNowPlaying only ever reads the ONE team per league flagged
//     isMe — an opponent's starter, however live or however big his score,
//     never produces a row.
//   * a league with no isMe team at all (misconfigured, or one you're only
//     watching) contributes nothing, not every team in it.
//   * on every day but Sunday, isPlayerGameToday gates entry — a starter
//     appears once his game is on today's calendar date, ANY state
//     (pre-kickoff, live, or already final), not just live right now. A
//     starter whose game isn't today at all still doesn't appear just
//     because he's mine.
//   * Sunday narrows back to isPlayerLive (state === 'in' only), same as the
//     NFL tab's own Now Playing card and for the same reason — a full Sunday
//     slate would otherwise put most of a manager's own starters on the card
//     regardless of whether they've played yet.
//   * kickers and defenses appear the same as any other starter this card
//     includes — no position is excluded from this card.
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
//   * a player's name links to FantasyPros the same standard every other
//     card follows (playerNameNode) — the url comes off THIS league's own
//     roster entry (league.players[].ecr.url, attached at sync time), never
//     built from the name, since the live-scoring player itself carries no
//     such field. No roster match degrades to a plain name, never a guess.
//   * the card auto-collapses itself when nobody of mine is playing — but
//     the loading state (before the first poll answers) is never mistaken
//     for that, and a manager's own stored toggle preference is never
//     overwritten, only overridden for the render where the card is empty.

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

// Fixed Sunday/non-Sunday clocks, same literal dates test-nfl-tab.mjs's own
// renderNflCards tests use, for the same reason: the `now` passed to
// computeNowPlaying/renderNowPlayingCard only picks which branch applies
// (Sunday-live-only vs. every-other-day-today) — it has NO bearing on
// isPlayerGameToday's own "is this today" check, which always reads the
// real clock (see that function's own comment in myffl.html). So a fixture
// exercising the today-gate must build its kickoff off the REAL `new Date()`
// (as SUNDAY_NOW/WEEKDAY_NOW below already do via TODAY_KICKOFF), never off
// these fixed constants, or it would only land on "today" on the one day
// this suite happens to run.
const SUNDAY_NOW = new Date('2026-09-20T18:00:00Z');
const WEEKDAY_NOW = new Date('2026-09-16T12:00:00Z');
const TODAY_KICKOFF = new Date().toISOString();
const FAR_OFF_KICKOFF = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

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
	// Pinned to a Sunday so this exercises the live-only gate regardless of
	// what day this suite actually runs on — neither fixture sets a
	// kickoff, so the every-other-day today-gate would exclude both
	// (see SUNDAY_NOW/WEEKDAY_NOW's own comment).
	const rows = ctx.computeNowPlaying([
		league('L1', '0001',
			[{ name: 'My Guy', position: 'QB', team: 'BUF', points: 20 }],
			[{ name: 'Their Guy', position: 'QB', team: 'KC', points: 99 }]
		),
	], SUNDAY_NOW);
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
	}], SUNDAY_NOW);
	assert.equal(rows.length, 0, 'no isMe team means nothing from this league, no matter who is live');
}

// Sunday: isPlayerLive gates entry — a starter of mine whose game hasn't
// kicked off doesn't appear just because he's mine. No kickoff is set at
// all here, so this passes on the every-other-day gate too (no data to say
// it's even today) — see the weekday block further down for the real
// distinguishing case, where a pre-kickoff starter WITH a today kickoff
// appears on a weekday but is excluded on Sunday.
{
	const ctx = makeContext();
	setLiveGames(ctx, { BUF: { state: 'pre' } });
	const rows = ctx.computeNowPlaying([league('L3', '0001', [{ name: 'Not Live Yet', position: 'QB', team: 'BUF', points: 0 }])], SUNDAY_NOW);
	assert.equal(rows.length, 0, "mine but not live yet doesn't count on Sunday");
}

// --- The new "today, except Sunday" rule (isPlayerGameToday) ---
//
// This is the behavior change: on any day but Sunday, a starter appears the
// moment his game is on TODAY'S calendar date, any state — not just live
// right now. Sunday keeps the old live-only reading. Kickoffs here are
// TODAY_KICKOFF/FAR_OFF_KICKOFF, built off the REAL clock (see that
// constant's own comment on why a fixed literal would only work on the one
// day this suite happens to run); WEEKDAY_NOW/SUNDAY_NOW only decide which
// gate applies.

// Weekday, pre-kickoff: a starter whose game hasn't started yet still
// appears, since it's on today's calendar date — this is the exact case
// that used to leave the card looking empty for most of a normal slate day.
{
	const ctx = makeContext();
	setLiveGames(ctx, { BUF: { state: 'pre', kickoff: TODAY_KICKOFF } });
	const rows = ctx.computeNowPlaying([league('L50', '0001', [{ name: 'Not Kicked Off Yet', position: 'QB', team: 'BUF', points: null }])], WEEKDAY_NOW);
	assert.equal(rows.length, 1, "a pre-kickoff starter whose game is TODAY appears on a weekday");
	assert.equal(rows[0].score, null, 'no score yet, never a confident 0');
}

// Weekday, already final: a starter whose game already finished today still
// appears, with his real final score — "played today" doesn't stop mattering
// just because the game ended.
{
	const ctx = makeContext();
	setLiveGames(ctx, { BUF: { state: 'post', kickoff: TODAY_KICKOFF } });
	const rows = ctx.computeNowPlaying([league('L51', '0001', [{ name: 'Already Final', position: 'QB', team: 'BUF', points: 27 }])], WEEKDAY_NOW);
	assert.equal(rows.length, 1, 'an already-final starter from a game today still appears');
	assert.equal(rows[0].score, 27, 'with his real final score');
}

// Weekday, NOT today: a starter whose game is several days out doesn't
// appear just because he's mine — isPlayerGameToday still excludes a game
// that isn't today, on any state.
{
	const ctx = makeContext();
	setLiveGames(ctx, { BUF: { state: 'pre', kickoff: FAR_OFF_KICKOFF } });
	const rows = ctx.computeNowPlaying([league('L52', '0001', [{ name: 'Not Today', position: 'QB', team: 'BUF', points: 0 }])], WEEKDAY_NOW);
	assert.equal(rows.length, 0, "a starter whose game isn't today doesn't appear on a weekday");
}

// Sunday narrowing: the SAME pre-kickoff-today starter that appeared on a
// weekday above is excluded on Sunday — the one day the card falls back to
// isPlayerLive, same as the NFL tab's own Now Playing card and for the same
// reason (a full Sunday slate would otherwise put most of a manager's own
// starters on the card regardless of whether they've played yet).
{
	const ctx = makeContext();
	setLiveGames(ctx, { BUF: { state: 'pre', kickoff: TODAY_KICKOFF } });
	const rows = ctx.computeNowPlaying([league('L53', '0001', [{ name: 'Not Kicked Off Yet', position: 'QB', team: 'BUF', points: null }])], SUNDAY_NOW);
	assert.equal(rows.length, 0, "the same pre-kickoff-today starter is excluded on Sunday");
}

// Sunday: a starter who IS live still gets through, same as ever.
{
	const ctx = makeContext();
	setLiveGames(ctx, { BUF: { state: 'in', kickoff: TODAY_KICKOFF } });
	const rows = ctx.computeNowPlaying([league('L54', '0001', [{ name: 'Live Right Now', position: 'QB', team: 'BUF', points: 14 }])], SUNDAY_NOW);
	assert.equal(rows.length, 1, 'a starter live right now still appears on Sunday');
}

// The rendered card's subtitle and empty-state text track the same split:
// "playing today" on a weekday, "live right now" on Sunday.
{
	const ctx = makeContext(LOGGED_IN);
	setLiveScoringAttempted(ctx, true);
	setLiveGames(ctx, { BUF: { state: 'pre', kickoff: TODAY_KICKOFF } });
	const weekdayCard = ctx.renderNowPlayingCard([league('L55', '0001', [{ name: 'Not Kicked Off Yet', position: 'QB', team: 'BUF', points: null }])], WEEKDAY_NOW);
	assert.ok(fullText(weekdayCard).includes('1 player playing today'), 'weekday subtitle reads "playing today"');

	const sundayCard = ctx.renderNowPlayingCard([league('L56', '0001', [{ name: 'Not Kicked Off Yet', position: 'QB', team: 'BUF', points: null }])], SUNDAY_NOW);
	assert.ok(fullText(sundayCard).includes('No players currently playing.'), 'Sunday empty state keeps the old live-only wording, since the pre-kickoff starter is excluded');

	setLiveGames(ctx, { BUF: { state: 'in', kickoff: TODAY_KICKOFF } });
	const sundayLiveCard = ctx.renderNowPlayingCard([league('L57', '0001', [{ name: 'Live Guy', position: 'QB', team: 'BUF', points: 14 }])], SUNDAY_NOW);
	assert.ok(fullText(sundayLiveCard).includes('1 player live right now'), 'Sunday subtitle reads "live right now" once someone actually is');
}

// Kickers and defenses appear here like any other live starter of mine.
{
	const ctx = makeContext();
	setLiveGames(ctx, { BAL: { state: 'in' } });
	const rows = ctx.computeNowPlaying([league('L4', '0001', [
		{ name: 'Kicker Guy', position: 'PK', team: 'BAL', points: 8 },
		{ name: 'Some Defense', position: 'Def', team: 'BAL', points: 5 },
	])], SUNDAY_NOW);
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
	const rows = ctx.computeNowPlaying([league('L5', '0001', [{ name: 'Draftonly Guy', position: 'QB', team: 'BUF', points: 10 }], [], 'draftonly')], SUNDAY_NOW);
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
	], SUNDAY_NOW);
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
	], SUNDAY_NOW);
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
	], SUNDAY_NOW);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].score, 9, 'ESPN leads over the higher-scoring Sleeper entry when no MFL entry exists');
}

// --- Player names link to FantasyPros, same standard as every other card ---
//
// computeNowPlaying resolves the link from the SAME league's own roster
// entry (league.players[].ecr.url — the field fetch-rosters.mjs attaches at
// sync time by joining the FantasyPros rankings pool by name), never from
// the live-scoring player itself, which carries no such field. This is a
// second, client-side name join on top of that one, using the same
// normalizeName key the cross-league merge above already uses.
{
	const ctx = makeContext();
	setLiveGames(ctx, { BUF: { state: 'in' } });
	const withRoster = league('L30', '0001', [{ name: 'Josh Allen', position: 'QB', team: 'BUF', points: 20 }]);
	withRoster.players = [{ name: 'Josh Allen', ecr: { url: 'https://www.fantasypros.com/nfl/players/josh-allen.php' } }];
	const rows = ctx.computeNowPlaying([withRoster], SUNDAY_NOW);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].url, 'https://www.fantasypros.com/nfl/players/josh-allen.php', "the row's url comes off this league's own roster entry");
}

// No matching roster entry (never synced, or the name didn't resolve at
// sync time) — the row simply carries no url, same as any other card's
// fallback.
{
	const ctx = makeContext();
	setLiveGames(ctx, { BUF: { state: 'in' } });
	const noRosterMatch = league('L31', '0001', [{ name: 'Obscure Guy', position: 'QB', team: 'BUF', points: 20 }]);
	noRosterMatch.players = [{ name: 'Someone Else' }];
	const rows = ctx.computeNowPlaying([noRosterMatch], SUNDAY_NOW);
	assert.equal(rows.length, 1);
	assert.ok(!rows[0].url, 'no roster match means no url, not a guessed or broken one');
}

// The rendered card: a resolved url becomes a real player-link anchor to
// FantasyPros; an unresolved one keeps the plain name playerNameNode always
// falls back to.
{
	const ctx = makeContext(LOGGED_IN);
	setLiveScoringAttempted(ctx, true);
	setLiveGames(ctx, { BUF: { state: 'in' }, MIN: { state: 'in' } });
	const linked = league('L32', '0001', [{ name: 'Josh Allen', position: 'QB', team: 'BUF', points: 20 }]);
	linked.players = [{ name: 'Josh Allen', ecr: { url: 'https://www.fantasypros.com/nfl/players/josh-allen.php' } }];
	const unlinked = league('L33', '0002', [{ name: 'Justin Jefferson', position: 'WR', team: 'MIN', points: 15 }]);
	// No `players` roster at all on this league — the join must degrade
	// safely rather than throwing on a missing array.
	const card = ctx.renderNowPlayingCard([linked, unlinked], SUNDAY_NOW);

	const links = findAll(card, hasClass('player-link'));
	assert.equal(links.length, 1, 'only the player with a resolved FantasyPros url gets a link');
	assert.equal(links[0].attrs.href, 'https://www.fantasypros.com/nfl/players/josh-allen.php');
	assert.equal(fullText(links[0]), 'Josh Allen');
	assert.equal(links[0].attrs.target, '_blank');
	assert.equal(links[0].attrs.rel, 'noopener');

	const rows = findAll(card, hasClass('now-playing-row'));
	const jeffersonRow = rows.find((r) => fullText(r).includes('Justin Jefferson'));
	assert.ok(jeffersonRow, 'the unlinked player still renders');
	assert.equal(findAll(jeffersonRow, hasClass('player-link')).length, 0, 'no roster match keeps a plain, unlinked name');
}

// --- Owning league(s) print as Toolbar Label text, not the old "(N)" popover ---
//
// Replaces a click-through popover that was almost always just "(1)": the
// row now names the league(s) directly, using the same Toolbar Label ->
// Display Name fallback chain quickLinkLabelForLeague already uses for the
// quick-link bar, so a league with no nickname set still prints something.
// Both leagues score him the same here on purpose, so this stays a clean
// test of just the Toolbar Label line — see the scoresDiffer block below for
// the case where the two scores disagree.
{
	const ctx = makeContext(LOGGED_IN);
	setLiveScoringAttempted(ctx, true);
	setLiveGames(ctx, { BUF: { state: 'in' } });
	const card = ctx.renderNowPlayingCard([
		league('L12', '0001', [{ name: 'Josh Allen', position: 'QB', team: 'BUF', points: 24 }], [], 'dynasty', 'MNMx'),
		league('L13', '0002', [{ name: 'Josh Allen', position: 'QB', team: 'BUF', points: 24 }]),
	], SUNDAY_NOW);

	assert.equal(findAll(card, hasClass('now-playing-scores-link')).length, 0, 'scored the same everywhere — no drill-down link');

	const teamsLine = findAll(card, hasClass('now-playing-teams'))[0];
	assert.ok(teamsLine, 'the owning league(s) print in their own line');
	assert.equal(fullText(teamsLine), 'MNMx, League L13', 'a set nickname and a displayName fallback, comma-joined');
}

// --- Leagues disagreeing on this player's score bring the popover back ---
//
// The Toolbar Label line above can't show two different scores next to one
// player, so scoresDiffer (computeNowPlaying) reintroduces a click-through
// popover, but ONLY on a row where it's actually needed — this is the one
// case the plain-text line above can't cover.
{
	const ctx = makeContext(LOGGED_IN);
	setLiveScoringAttempted(ctx, true);
	setLiveGames(ctx, { BUF: { state: 'in' } });
	const card = ctx.renderNowPlayingCard([
		league('L25', '0001', [{ name: 'Josh Allen', position: 'QB', team: 'BUF', points: 20 }], [], 'dynasty', 'PPR League'),
		league('L26', '0002', [{ name: 'Josh Allen', position: 'QB', team: 'BUF', points: 24 }], [], 'dynasty', 'Standard League'),
	], SUNDAY_NOW);

	const links = findAll(card, hasClass('now-playing-scores-link'));
	assert.equal(links.length, 1, 'a differing score gets exactly one drill-down link');
	assert.equal(fullText(links[0]), '(2)', 'labelled with the entry count, same as the retired popover');

	links[0].listeners.click[0]({ stopPropagation() {} });
	const popover = findAll(ctx.document.body, hasClass('nowPlaying-popover'))[0];
	assert.ok(popover, 'clicking it opens the Now Playing popover');
	assert.match(fullText(findAll(popover, hasClass('popover-title'))[0]), /Josh Allen — Scores by League/);
	const popoverRows = findAll(popover, hasClass('popover-row'));
	assert.equal(popoverRows.length, 2);
	// Full league names here, not the Toolbar Labels the row itself already
	// shows — this drill-down has the room to be unambiguous.
	assert.ok(popoverRows.some((r) => fullText(r.children[0]) === 'League L25' && fullText(r.children[1]) === '20.00'));
	assert.ok(popoverRows.some((r) => fullText(r.children[0]) === 'League L26' && fullText(r.children[1]) === '24.00'));
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
	], SUNDAY_NOW);
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
	const card = ctx.renderNowPlayingCard([withStats], SUNDAY_NOW);

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

// --- PK and Def render as one merged sub-card, not two ---
//
// Both are typically the thinnest buckets on a slate, so they share one
// 'PK/Def' mini-card instead of each getting its own — one heading, one
// group, both players' rows inside it.
{
	const ctx = makeContext(LOGGED_IN);
	setLiveScoringAttempted(ctx, true);
	setLiveGames(ctx, { BAL: { state: 'in' } });
	const card = ctx.renderNowPlayingCard([
		league('L25', '0001', [
			{ name: 'Kicker Guy', position: 'PK', team: 'BAL', points: 8 },
			{ name: 'Some Defense', position: 'Def', team: 'BAL', points: 5 },
		]),
	], SUNDAY_NOW);

	const posCards = findAll(card, hasClass('now-playing-position'));
	assert.equal(posCards.length, 1, 'PK and Def share one mini-card, not two');

	const head = findAll(card, hasClass('now-playing-position-head'))[0];
	assert.ok(fullText(head).startsWith('PK/Def (2)'), 'the merged heading names both positions and counts both players');

	const text = fullText(card);
	assert.ok(text.includes('Kicker Guy') && text.includes('Some Defense'), 'both players render inside the merged card');
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
	], SUNDAY_NOW);

	assert.equal(findAll(card, hasClass('now-playing-sort-btn')).length, 0, 'the sort toggle is gone');

	const order = findAll(card, hasClass('now-playing-row')).map((r) => fullText(r));
	assert.ok(order[0].includes('High WR'), 'highest score leads');
	assert.ok(order[1].includes('Mid WR'), 'then the middle score');
	assert.ok(order[2].includes('Low WR'), 'then the lowest score');
	assert.ok(order[3].includes('No Score Yet WR'), 'a score not in yet sinks to the bottom, not sorted as a 0');
}

// --- Auto-collapse when nobody of mine is live ---
//
// Same forced-not-persisted mechanism as the NFL tab's own Now Playing card
// (makeCollapsible's own `forceCollapsed` argument): an empty card collapses
// itself for this render without writing to the stored toggle, so it's back
// to whatever the manager's own preference is the moment someone goes live.

// No leagues live at all: the card collapses itself rather than sitting
// expanded around one line of "nothing to see here" — and, critically,
// without writing that collapse to the stored toggle, so it's never
// mistaken for the manager's own preference.
{
	const ctx = makeContext(LOGGED_IN);
	setLiveScoringAttempted(ctx, true);
	setLiveGames(ctx, {});
	const card = ctx.renderNowPlayingCard([]);
	assert.ok(hasClass('card-collapsed')(card), 'an empty Now Playing auto-collapses');
	assert.equal(ctx.__store.get('myfflCardCollapsed:desktop:now-playing'), undefined, 'the forced collapse is never persisted to the stored toggle');
}

// The loading state (before the first live-scoring poll answers) must NOT
// be treated as empty — that would misrepresent "haven't asked yet" as
// "nobody's playing" before the card even had a chance to find out.
{
	const ctx = makeContext(LOGGED_IN);
	setLiveScoringAttempted(ctx, false);
	const card = ctx.renderNowPlayingCard([league('L40', '0001', [{ name: 'Someone', position: 'QB', team: 'BUF', points: 0 }])]);
	assert.ok(findAll(card, hasClass('loading-box')).length === 1, 'still shows the loading state');
	assert.ok(!hasClass('card-collapsed')(card), 'the loading state is never force-collapsed');
}

// At least one live player of mine: the card stays expanded.
{
	const ctx = makeContext(LOGGED_IN);
	setLiveScoringAttempted(ctx, true);
	setLiveGames(ctx, { BUF: { state: 'in' } });
	const card = ctx.renderNowPlayingCard([league('L41', '0001', [{ name: 'My Guy', position: 'QB', team: 'BUF', points: 20 }])], SUNDAY_NOW);
	assert.ok(!hasClass('card-collapsed')(card), 'a non-empty Now Playing stays expanded');
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
