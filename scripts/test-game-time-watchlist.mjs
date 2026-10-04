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
//   * nothing at all is listed from Tuesday until the weekly rollover
//     cutoff (Wednesday 7 PM Central), same hold as the Problems Digest,
//     and the card says the week isn't open yet rather than "no injured
//     players".
//   * each league a player STARTS in gets a replacement picker, listing
//     that league's non-starting Active Roster players (same position
//     first, healthy before designated, best ECR first); a benched copy
//     gets none. Until chosen, the picker defaults to the best healthy
//     same-position bench player by ECR (never a designated or
//     off-position one); "None" switches that off. A choice is stored per
//     league + starter id (backupPlans, which syncs) — a suggestion never
//     is — and a saved pick who left the roster falls back to the
//     suggestion.
//   * the card is login-gated, shows a loading state until game states
//     have been asked (never a false "nothing to check"), and collapses
//     itself when empty.

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
	assert.equal(lead, 45);
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

// Held before the weekly rollover cutoff: nothing listed, and the card says
// the week isn't open rather than claiming nobody is injured.
{
	const ctx = makeContext(LOGGED_IN);
	const games = { PHI: game('LAR', true, EARLY) };
	const l = league('1', [player('a', 'Saquon Barkley', 'PHI', 'D')], ['a']);
	assert.equal(ctx.computeGameTimeWatchlist([l], YEAR, games, true).length, 1, 'past the cutoff: listed');
	assert.deepEqual(plain(ctx.computeGameTimeWatchlist([l], YEAR, games, false)), [], 'before the cutoff: held');

	ctx.pastWeeklyRolloverCutoff = () => false;
	setGames(ctx, games);
	vm.runInContext("pageData = { weeklyRolloverCutoff: { weekday: 'Wed', hourCT: 19 } };", ctx);
	const held = ctx.renderGameTimeWatchlistCard([l], YEAR);
	assert.ok(held.classList.contains('card-collapsed'));
	assert.match(fullText(held), /Next week opens Wednesday at 7 PM Central/);

	// The message names whatever time the snapshot carries, not a fixed one.
	vm.runInContext("pageData = { weeklyRolloverCutoff: { weekday: 'Thu', hourCT: 12 } };", ctx);
	assert.match(fullText(ctx.renderGameTimeWatchlistCard([l], YEAR)), /Next week opens Thursday at noon Central/);
	vm.runInContext("pageData = { weeklyRolloverCutoff: { weekday: 'Wed', hourCT: 9 } };", ctx);
	assert.match(fullText(ctx.renderGameTimeWatchlistCard([l], YEAR)), /Next week opens Wednesday at 9 AM Central/);
	assert.doesNotMatch(fullText(held), /No injured players/);
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
	// By label: a starter's backup picker lists the bench player's name too.
	const benchGroup = subGroups.find((g) => fullText(g).startsWith('Bench ('));
	const starterGroup = subGroups.find((g) => fullText(g).startsWith('Starters ('));
	assert.ok(hasClass('roster-group-collapsed')(benchGroup), 'Bench starts collapsed by default, untouched');
	assert.ok(!hasClass('roster-group-collapsed')(starterGroup), 'Starters starts expanded, same as ever');

	const benchLabel = benchGroup.children.find((c) => hasClass('group-label')(c));
	benchLabel.listeners.click[0]();
	assert.ok(!hasClass('roster-group-collapsed')(benchGroup), 'clicking Bench expands it');
	assert.ok(!hasClass('roster-group-collapsed')(starterGroup), 'Starters is unaffected by expanding Bench');
	assert.equal(ctx.__store.get(`myfflGroupCollapsed:desktop:watchlist:${EARLY}:bench`), '0', 'expanding away from the default is what actually gets persisted');
}

// Backup picker: candidates, the ECR-driven default, persistence, and fallbacks.
{
	const ctx = makeContext(LOGGED_IN);
	setGames(ctx, { PHI: game('LAR', true, EARLY) });
	const ecr = (rank) => ({ ecr: { rank } });
	const l = league('L', [
		player('a', 'Saquon Barkley', 'PHI', 'Q'),
		player('w1', 'Zed Receiver', 'DAL', null, { position: 'WR', ...ecr(1) }),
		player('r2', 'Zack Runner', 'DAL', 'Q', ecr(2)),
		player('r1', 'Yan Runner', 'DAL', null, ecr(30)),
		player('r3', 'Abe Runner', 'DAL', null, ecr(12)),
		player('r4', 'Unranked Runner', 'DAL', null),
		player('t', 'Taxi Guy', 'DAL', null, { status: 'TAXI_SQUAD', ...ecr(1) }),
		player('s', 'Other Starter', 'DAL', null, ecr(1)),
	], ['a', 's']);

	const names = ctx.watchlistBackupCandidates(l, l.players[0]).map((c) => c.name);
	assert.deepEqual(plain(names), ['Abe Runner', 'Yan Runner', 'Unranked Runner', 'Zack Runner', 'Zed Receiver'],
		'same position first, healthy first, best ECR first (unranked last); no starters/taxi/the starter himself');
	assert.equal(ctx.watchlistSuggestedBackup(l, l.players[0]).name, 'Abe Runner', 'best-ranked healthy same-position player');

	// No healthy same-position player: no suggestion, never a doubtful one.
	const thin = league('T', [player('a', 'Saquon Barkley', 'PHI', 'Q'), player('x', 'Zack Runner', 'DAL', 'Q', ecr(2)), player('w', 'Zed Receiver', 'DAL', null, { position: 'WR', ...ecr(1) })], ['a']);
	assert.equal(ctx.watchlistSuggestedBackup(thin, thin.players[0]), null);
	assert.ok(findAll(ctx.renderGameTimeWatchlistCard([thin], YEAR), hasClass('watchlist-backup-unset')).length === 1, 'no backup applies: gold, like an unplanned contract length');

	const selects = (card) => findAll(card, hasClass('watchlist-backup-select'));
	// The picker lives in the right-hand column with the opponent, not under the name.
	const sideOf = (card) => findAll(card, hasClass('watchlist-side'))[0];
	const card = ctx.renderGameTimeWatchlistCard([l], YEAR);
	assert.equal(selects(card).length, 1);
	assert.ok(findAll(sideOf(card), hasClass('watchlist-backup-select')).length === 1 && /vs LAR/.test(fullText(sideOf(card))), 'picker shares the right-hand column with the opponent');
	const sel = selects(card)[0];
	assert.equal(sel.children.length, 2 + 5, 'suggestion + None + five candidates');
	assert.equal(sel.value, '', 'untouched, the select sits on the suggestion');
	assert.ok(!sel.classList.contains('watchlist-backup-unset'), 'a suggestion settles it: purple chip, not gold');
	assert.match(fullText(card), /A\. Runner\* \(RB\)/, 'first initial, asterisk on the suggestion, no prefix');
	assert.doesNotMatch(fullText(card), /Suggest:/);
	assert.match(fullText(card), /\* suggested: best-ranked healthy bench player/, 'the asterisk is explained once, in a footnote');
	assert.match(fullText(card), /Z\. Runner \(RB, Q\)/, 'a designation rides inside the parentheses');
	assert.equal(ctx.getBackupPlan('L', 'a'), '', 'a suggestion is shown, not saved');

	// Choosing overrides the suggestion and survives a rebuild.
	sel.value = 'r1';
	sel.listeners.change[0]();
	assert.equal(ctx.getBackupPlan('L', 'a'), 'r1');
	assert.deepEqual(plain(JSON.parse(ctx.__store.get('myfflPlanPending')).backupPlans), { L: { a: 'r1' } });
	assert.equal(ctx.watchlistBackupFor(l, 'a', l.players[0]).source, 'chosen');
	assert.equal(selects(ctx.renderGameTimeWatchlistCard([l], YEAR))[0].value, 'r1', 'the pick survives a rebuild');

	// The pick left the roster: back to the suggestion, not a stale name.
	const gone = league('L', l.players.filter((p) => p.id !== 'r1'), ['a', 's']);
	assert.equal(selects(ctx.renderGameTimeWatchlistCard([gone], YEAR))[0].value, '');
	assert.equal(ctx.watchlistBackupFor(gone, 'a', gone.players[0]).player.name, 'Abe Runner');

	// "None" switches the default off and is not mistaken for a player.
	sel.value = 'none';
	sel.listeners.change[0]();
	assert.equal(ctx.watchlistBackupFor(l, 'a', l.players[0]).player, null);
	const none = selects(ctx.renderGameTimeWatchlistCard([l], YEAR))[0];
	assert.equal(none.value, 'none');
	assert.ok(!none.classList.contains('watchlist-backup-unset'), 'a deliberate None is settled too');

	// Choosing the suggestion row again returns to automatic.
	sel.value = '';
	sel.listeners.change[0]();
	assert.equal(ctx.getBackupPlan('L', 'a'), '');
	assert.equal(ctx.watchlistBackupFor(l, 'a', l.players[0]).source, 'suggested');

	// A benched player has no picker; two leagues starting him get one each.
	const benched = league('B', [player('b', 'Bench Guy', 'PHI', 'Q')], []);
	assert.equal(selects(ctx.renderGameTimeWatchlistCard([benched], YEAR)).length, 0);
	const two = [league('1', [player('a', 'Saquon Barkley', 'PHI', 'Q')], ['a']), league('2', [player('9', 'Saquon Barkley', 'PHI', 'Q')], ['9'])];
	assert.equal(selects(ctx.renderGameTimeWatchlistCard(two, YEAR)).length, 2);
}

// The push notification (api/_lib/gametime.mjs resolveBackup) duplicates the
// page's backup rules. Same fixture through both, every saved-pick state: a
// drift would tell the phone one name and the card another.
{
	const ctx = makeContext(LOGGED_IN);
	const ecr = (rank) => ({ ecr: { rank } });
	const l = league('P', [
		player('a', 'Saquon Barkley', 'PHI', 'Q'),
		player('r1', 'Yan Runner', 'DAL', null, ecr(30)),
		player('r2', 'Abe Runner', 'DAL', null, ecr(12)),
		player('r3', 'Hurt Runner', 'DAL', 'Q', ecr(1)),
		player('r4', 'Unranked Runner', 'DAL', null),
		player('w', 'Zed Receiver', 'DAL', null, { position: 'WR', ...ecr(2) }),
		player('t', 'Taxi Guy', 'DAL', null, { status: 'TAXI_SQUAD', ...ecr(1) }),
		player('s', 'Other Starter', 'DAL', null, ecr(1)),
	], ['a', 's']);
	const thin = league('T', [player('a', 'Saquon Barkley', 'PHI', 'Q'), player('x', 'Hurt Runner', 'DAL', 'Q', ecr(1)), player('w', 'Zed Receiver', 'DAL', null, { position: 'WR', ...ecr(2) })], ['a']);
	for (const lg of [l, thin]) {
		for (const saved of [undefined, 'r1', 'r4', 'none', 'gone', 'w', 't', 's']) {
			ctx.__lg = lg; ctx.__saved = saved || '';
			const page = vm.runInContext("(() => { localStorage.setItem('myfflBackupPlans', JSON.stringify(__saved ? { [__lg.id]: { a: __saved } } : {})); return watchlistBackupFor(__lg, 'a', __lg.players[0]); })()", ctx);
			const server = resolveBackup(lg, lg.players[0], saved);
			assert.equal(server.player ? String(server.player.id) : null, page.player ? String(page.player.id) : null, `${lg.id} saved=${saved}: page and push name the same backup`);
			assert.equal(server.source, page.source, `${lg.id} saved=${saved}: same source`);
		}
	}
}

console.log('Game-Time Watchlist tests passed');
