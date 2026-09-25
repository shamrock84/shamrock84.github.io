// Unit test for the Scoring tab's Game-Time Watchlist in myffl.html
// (computeGameTimeWatchlist / renderGameTimeWatchlistCard).
//
// The card replaces a phone alarm set per injured starter, so its failure
// that matters is a MISSING row: a Questionable starter that silently
// never appears reads exactly like "nothing to check". Pinned here:
//
//   * a starter with a designation whose game hasn't kicked off appears,
//     and so does a benched player with one — each carries its own
//     `starter` flag (folded true if started in ANY league, same rule
//     computeNowPlaying uses), so the card can split Starters from Bench
//     the way Now Playing splits its own position groups.
//   * a taxi-squad/practice-squad/IR player with a designation is excluded
//     — none of those can be started this week.
//   * every designation counts (an O starter is the one most needing a swap)
//     and a slot lists the worst first.
//   * a game already under way or final drops the row — the lineup is locked.
//   * a player with no game in the map (a bye) is skipped rather than
//     invented a slot.
//   * one player started in two leagues is one row naming both, and the
//     worse of two disagreeing designations wins.
//   * slots are ordered by kickoff, and "check at" is kickoff minus
//     WATCHLIST_CHECK_LEAD_MINUTES.
//   * draftonly, mid-draft and trailing-season leagues contribute nothing,
//     same gates as the Problems Digest.
//   * the card is login-gated, shows a loading state until game states
//     have been asked (never a false "nothing to check"), and collapses
//     itself when empty.

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

function setGames(ctx, games, attempted = true) {
	ctx.__testGames = games;
	ctx.__testAttempted = attempted;
	vm.runInContext('liveGames = __testGames; gameStatesAttempted = __testAttempted;', ctx);
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

const EARLY = '2026-09-27T17:00:00Z';
const LATE = '2026-09-27T20:25:00Z';
const game = (opponent, isHome, kickoff, state = 'pre') => ({ opponent, isHome, kickoff, state, detail: null });

function player(id, name, team, injuryStatus, extra = {}) {
	return { id, name, team, position: 'RB', status: 'ROSTER', injuryStatus, injuryDetail: null, ...extra };
}
function league(id, players, starters, extra = {}) {
	return { id, type: 'dynasty', season: '2026', nickname: `L${id}`, displayName: `League ${id}`, lineupWeek: 3, players, starters, ...extra };
}

const YEAR = '2026';

// Arrays built inside the vm belong to its realm, which deepStrictEqual
// treats as different prototypes; round-trip to compare values only.
const plain = (x) => JSON.parse(JSON.stringify(x));

// A Q starter pre-kickoff appears, and so does the same designation on the
// bench — each keeps its own `starter` flag, and a taxi/practice/IR player
// with a designation is excluded even though his game hasn't kicked off.
{
	const ctx = makeContext();
	const games = { PHI: game('LAR', true, EARLY), LAR: game('PHI', false, EARLY) };
	const l = league('1', [
		player('a', 'Saquon Barkley', 'PHI', 'Q'),
		player('b', 'Bench Guy', 'LAR', 'Q'),
		player('c', 'Taxi Guy', 'LAR', 'Q', { status: 'TAXI_SQUAD' }),
	], ['a']);
	const slots = ctx.computeGameTimeWatchlist([l], YEAR, games);
	assert.equal(slots.length, 1);
	const byName = Object.fromEntries(slots[0].rows.map((r) => [r.player.name, r.starter]));
	assert.deepEqual(plain(byName), { 'Saquon Barkley': true, 'Bench Guy': false });
	assert.equal(slots[0].kickoff, EARLY);
}

// Healthy starters never appear; every designation does, worst first.
{
	const ctx = makeContext();
	const games = { PHI: game('LAR', true, EARLY) };
	const l = league('1', [
		player('a', 'Aaron Q', 'PHI', 'Q'),
		player('b', 'Bob Out', 'PHI', 'O'),
		player('c', 'Carl Healthy', 'PHI', null),
		player('d', 'Dan Doubtful', 'PHI', 'D'),
	], ['a', 'b', 'c', 'd']);
	const slots = ctx.computeGameTimeWatchlist([l], YEAR, games);
	assert.deepEqual(plain(slots[0].rows.map((r) => r.status)), ['O', 'D', 'Q']);
}

// A game under way or final drops the row; a bye (no game) is skipped.
{
	const ctx = makeContext();
	const games = { PHI: game('LAR', true, EARLY, 'in'), DAL: game('NYG', true, EARLY, 'post'), KC: game('BAL', true, LATE) };
	const l = league('1', [
		player('a', 'Live Guy', 'PHI', 'Q'),
		player('b', 'Final Guy', 'DAL', 'Q'),
		player('c', 'Bye Guy', 'SEA', 'Q'),
		player('d', 'Later Guy', 'KC', 'Q'),
	], ['a', 'b', 'c', 'd']);
	const slots = ctx.computeGameTimeWatchlist([l], YEAR, games);
	assert.deepEqual(plain(slots.flatMap((s) => s.rows.map((r) => r.player.name))), ['Later Guy']);
}

// One player started in two leagues is one row naming both; worse designation wins.
{
	const ctx = makeContext();
	const games = { PHI: game('LAR', true, EARLY) };
	const a = league('1', [player('x1', 'Saquon Barkley', 'PHI', 'Q')], ['x1']);
	const b = league('2', [player('9', 'Saquon Barkley', 'PHI', 'D')], ['9'], { provider: 'espn' });
	const slots = ctx.computeGameTimeWatchlist([a, b], YEAR, games);
	assert.equal(slots[0].rows.length, 1);
	assert.equal(slots[0].rows[0].status, 'D');
	assert.deepEqual(plain(slots[0].rows[0].entries.map((e) => e.nickname)), ['L1', 'L2']);
}

// Slots ordered by kickoff, whatever order the leagues list them in.
{
	const ctx = makeContext();
	const games = { KC: game('BAL', true, LATE), PHI: game('LAR', true, EARLY) };
	const l = league('1', [player('a', 'Late', 'KC', 'Q'), player('b', 'Early', 'PHI', 'Q')], ['a', 'b']);
	const slots = ctx.computeGameTimeWatchlist([l], YEAR, games);
	assert.deepEqual(plain(slots.map((s) => s.kickoff)), [EARLY, LATE]);
}

// "check at" is kickoff minus the lead, in the viewer's own zone.
{
	const ctx = makeContext();
	const lead = vm.runInContext('WATCHLIST_CHECK_LEAD_MINUTES', ctx);
	assert.equal(lead, 80);
	const { checkAt } = ctx.watchlistSlotLabel(EARLY);
	const expected = new Date(new Date(EARLY).getTime() - lead * 60000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
	assert.equal(checkAt, expected);
}

// Same league gates as the digest: draftonly, mid-draft, trailing season, no lineup.
{
	const ctx = makeContext();
	const games = { PHI: game('LAR', true, EARLY) };
	const p = () => [player('a', 'Saquon Barkley', 'PHI', 'Q')];
	const leagues = [
		league('1', p(), ['a'], { type: 'draftonly' }),
		league('2', p(), ['a'], { draftInProgress: true }),
		league('3', p(), ['a'], { season: '2025' }),
		league('4', p(), undefined),
		league('5', p(), ['a'], { lineupWeek: null }),
	];
	assert.deepEqual(plain(ctx.computeGameTimeWatchlist(leagues, YEAR, games)), []);
}

// The card: login-gated, loading until asked, collapsed when empty, rows when not.
{
	const loggedOut = makeContext();
	setGames(loggedOut, {});
	assert.equal(loggedOut.renderGameTimeWatchlistCard([], YEAR), null);

	const ctx = makeContext(LOGGED_IN);
	setGames(ctx, {}, false);
	const loading = ctx.renderGameTimeWatchlistCard([league('1', [player('a', 'Saquon Barkley', 'PHI', 'Q')], ['a'])], YEAR);
	assert.ok(findAll(loading, hasClass('loading-box')).length === 1, 'not-yet-asked is a loading state, not an empty one');
	assert.ok(!loading.classList.contains('card-collapsed'));

	setGames(ctx, {});
	const empty = ctx.renderGameTimeWatchlistCard([], YEAR);
	assert.ok(empty.classList.contains('card-collapsed'));
	assert.match(fullText(empty), /No injured players/);

	setGames(ctx, { PHI: game('LAR', true, EARLY) });
	const full = ctx.renderGameTimeWatchlistCard([league('1', [player('a', 'Saquon Barkley', 'PHI', 'Q')], ['a'])], YEAR);
	assert.ok(!full.classList.contains('card-collapsed'));
	assert.equal(findAll(full, hasClass('watchlist-slot')).length, 1);
	const text = fullText(full);
	assert.match(text, /Saquon Barkley/);
	assert.match(text, /\(Q\)/);
	assert.match(text, /vs LAR/);
	assert.equal(findAll(full, hasClass('watchlist-league-link')).length, 1);
	// Starters-only slate: a Starters sub-group, no Bench one (a sub-group
	// with nothing in it is omitted, same as Now Playing's own).
	//
	// startsWith, not equality — makeGroupCollapsible's chevron span lands
	// after the label text here (see this test harness's own insertBefore,
	// which just appends), same reasoning test-now-playing.mjs's own
	// equivalent check carries.
	const groupLabels = findAll(full, hasClass('group-label')).map(fullText);
	assert.ok(groupLabels.some((t) => t.startsWith('Starters (1)')), 'the Starters sub-group is labelled and counted');
	assert.ok(!groupLabels.some((t) => t.startsWith('Bench')), 'no Bench sub-group when nobody of mine is benched');
}

// Starters and Bench render as separate collapsible sub-groups per slot,
// same idiom (and same "Bench defaults collapsed" rule) Now Playing uses
// per position — see test-now-playing.mjs's own equivalent for the pattern
// this mirrors.
{
	const ctx = makeContext(LOGGED_IN);
	setGames(ctx, { PHI: game('LAR', true, EARLY) });
	const l = league('1', [
		player('a', 'Saquon Barkley', 'PHI', 'Q'),
		player('b', 'Bench Guy', 'PHI', 'D'),
	], ['a']);
	const full = ctx.renderGameTimeWatchlistCard([l], YEAR);
	const groupLabels = findAll(full, hasClass('group-label')).map(fullText);
	assert.ok(groupLabels.some((t) => t.startsWith('Starters (1)')), 'the Starters sub-group is labelled and counted');
	assert.ok(groupLabels.some((t) => t.startsWith('Bench (1)')), 'the Bench sub-group is labelled and counted');

	// Each sub-group is its own makeGroupCollapsible instance, keyed by
	// kickoff — toggling Bench must not touch Starters.
	const subGroups = findAll(full, (n) => hasClass('roster-group')(n) && !hasClass('watchlist-slot')(n));
	assert.equal(subGroups.length, 2, 'Starters and Bench are two independent collapsible groups');
	const benchGroup = subGroups.find((g) => fullText(g).includes('Bench Guy'));
	const starterGroup = subGroups.find((g) => fullText(g).includes('Saquon Barkley'));
	assert.ok(hasClass('roster-group-collapsed')(benchGroup), 'Bench starts collapsed by default, untouched');
	assert.ok(!hasClass('roster-group-collapsed')(starterGroup), 'Starters starts expanded, same as ever');

	const benchLabel = benchGroup.children.find((c) => hasClass('group-label')(c));
	benchLabel.listeners.click[0]();
	assert.ok(!hasClass('roster-group-collapsed')(benchGroup), 'clicking Bench expands it');
	assert.ok(!hasClass('roster-group-collapsed')(starterGroup), 'Starters is unaffected by expanding Bench');
	assert.equal(ctx.__store.get(`myfflGroupCollapsed:desktop:watchlist:${EARLY}:bench`), '0', 'expanding away from the default is what actually gets persisted');
}

console.log('Game-Time Watchlist tests passed');
