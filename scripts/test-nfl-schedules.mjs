// Unit test for the NFL tab's Schedules card: extractWeekGames and
// buildTeamSchedules (scripts/lib/espn-schedules.mjs) and the page's
// renderNflSchedulesCard (myffl.html).
//
// Pinned:
//   * a game is read from competitors by homeAway; scores exist only for a
//     completed game, and an unplayed game carries no result (never 0-0).
//   * each game lands on BOTH teams, home/away flipped, with W/L/T from that
//     team's side.
//   * a team's bye is the week it is missing from a week that had games; a
//     week with no games at all invents no byes.
//   * the card orders favorites first then by name, repeats just the
//     favorites in a `.nfl-fav-collapsed` copy, and shows a bye as BYE.
//   * the card is built after Power Index, ahead of Depth Charts, and is
//     excluded from rerenderNflCards' removal query and appendNflCard's anchor.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { extractWeekGames, buildTeamSchedules } from './lib/espn-schedules.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(root, 'myffl.html'), 'utf8');
const scriptSource = html.match(/<script>([\s\S]*)<\/script>/)[1];

const event = (away, home, { done = false, as = '0', hs = '0', date = '2026-09-13T17:00Z' } = {}) => ({
	date,
	status: { type: { completed: done } },
	competitions: [{ competitors: [
		{ homeAway: 'home', team: { abbreviation: home }, score: hs },
		{ homeAway: 'away', team: { abbreviation: away }, score: as },
	] }],
});

// --- extractWeekGames -------------------------------------------------------
{
	const games = extractWeekGames({ events: [event('KC', 'BUF', { done: true, as: '24', hs: '17' }), event('DAL', 'NYG'), { competitions: [] }] });
	assert.equal(games.length, 2, 'an event with no competitors is skipped');
	assert.deepEqual(games[0], { away: 'KC', home: 'BUF', at: '2026-09-13T17:00Z', final: true, awayScore: 24, homeScore: 17 });
	assert.equal(games[1].final, false);
	assert.equal(games[1].awayScore, null, 'a pregame 0 is not a score');
	assert.deepEqual(extractWeekGames({}), []);
}

// --- buildTeamSchedules -----------------------------------------------------
const wk = (week, ...events) => ({ week, games: extractWeekGames({ events }) });
const teams = buildTeamSchedules([
	wk(2, event('KC', 'NYG'), event('DAL', 'BUF')),
	wk(1, event('KC', 'BUF', { done: true, as: '24', hs: '17' }), event('DAL', 'NYG', { done: true, as: '20', hs: '20' })),
	wk(3, event('KC', 'DAL')),
	{ week: 4, games: [] },
]);
{
	assert.deepEqual(teams.KC.map((e) => e.wk), [1, 2, 3], 'week order, whatever order the weeks arrived in');
	assert.deepEqual(teams.KC[0], { wk: 1, opp: 'BUF', home: false, at: '2026-09-13T17:00Z', r: 'W', pf: 24, pa: 17 });
	assert.deepEqual(teams.BUF[0], { wk: 1, opp: 'KC', home: true, at: '2026-09-13T17:00Z', r: 'L', pf: 17, pa: 24 });
	assert.equal(teams.DAL[0].r, 'T');
	assert.equal(teams.KC[1].r, undefined, 'unplayed: no result, no scores');
	assert.equal('pf' in teams.KC[1], false);
	assert.deepEqual(teams.BUF.map((e) => e.bye ? 'bye' : e.opp), ['KC', 'DAL', 'bye'], 'BUF is absent from week 3');
	assert.deepEqual(teams.NYG.map((e) => e.bye ? 'bye' : e.opp), ['DAL', 'KC', 'bye']);
	assert.equal(teams.KC.some((e) => e.wk === 4), false, 'a week with no games adds no byes');
}

// --- page -------------------------------------------------------------------
function domNode(tag = 'div') {
	const n = {
		tag, children: [], attrs: {}, cls: '', _text: '', dataset: {}, style: {},
		classList: {
			add(c) { const t = n.cls.split(/\s+/).filter(Boolean); if (!t.includes(c)) n.cls = [...t, c].join(' '); },
			remove(c) { n.cls = n.cls.split(/\s+/).filter((x) => x && x !== c).join(' '); },
			toggle(c, force) { const want = force === undefined ? !this.contains(c) : force; if (want) this.add(c); else this.remove(c); },
			contains: (c) => n.cls.split(/\s+/).includes(c),
		},
		listeners: {}, addEventListener(t, fn) { (n.listeners[t] = n.listeners[t] || []).push(fn); }, removeEventListener() {},
		setAttribute(k, v) { n.attrs[k] = v; }, getAttribute(k) { return n.attrs[k]; },
		appendChild(c) { n.children.push(c); c.parent = n; return c; },
		insertBefore(c) { n.children.push(c); return c; },
		replaceWith() {}, querySelector: () => null, querySelectorAll: () => [], closest: () => null, remove() {},
		get className() { return n.cls; }, set className(v) { n.cls = v; },
		get innerHTML() { return ''; }, set innerHTML(v) { if (v === '') n.children.length = 0; },
		get textContent() { return n._text; }, set textContent(v) { n._text = v; },
		getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
	};
	return n;
}
// Favorites are login-gated, and authToken is read when the script loads.
const store = new Map([['mflAuthToken', 'x']]);
const ctx = {
	console,
	localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
	setTimeout, clearTimeout, setInterval, clearInterval,
	document: {
		addEventListener() {}, getElementById: () => domNode(), createElement: (t) => domNode(t),
		createTextNode: (t) => { const n = domNode('#text'); n.textContent = t; return n; },
		querySelector: () => null, querySelectorAll: () => [], visibilityState: 'visible', body: domNode(),
	},
	window: { addEventListener() {}, matchMedia: () => ({ matches: false }) },
	fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
};
vm.createContext(ctx);
vm.runInContext(scriptSource, ctx);

function findAll(n, pred, out = []) {
	for (const c of n?.children || []) { if (pred(c)) out.push(c); findAll(c, pred, out); }
	return out;
}
const text = (n) => (n._text || '') + (n.children || []).map(text).join('');
const has = (n, c) => n.cls.split(/\s+/).includes(c);
const names = { KC: 'Kansas City Chiefs', BUF: 'Buffalo Bills', DAL: 'Dallas Cowboys', NYG: 'New York Giants' };
const titles = (container) => findAll(container, (n) => has(n, 'nfl-schedule-title')).map((n) => text(n.children[0]));

{
	// No favorites: name order, no collapsed copy.
	const card = ctx.renderNflSchedulesCard({ teams }, names);
	assert.equal(card.dataset.nflSchedules, 'true');
	assert.equal(card.attrs['data-view'], 'nfl');
	assert.deepEqual(titles(card), ['Buffalo Bills', 'Dallas Cowboys', 'Kansas City Chiefs', 'New York Giants']);
	assert.equal(findAll(card, (n) => has(n, 'nfl-fav-collapsed')).length, 0);
}

{
	store.set('myfflFavorites', JSON.stringify({ nflTeams: ['NYG', 'KC'] }));
	const card = ctx.renderNflSchedulesCard({ teams }, names);
	const [all, summary] = card.children.filter((c) => has(c, 'nfl-schedule-teams'));
	assert.deepEqual(titles(all), ['★ Kansas City Chiefs', '★ New York Giants', 'Buffalo Bills', 'Dallas Cowboys'], 'favorites first, then by name');
	assert.ok(has(summary, 'nfl-fav-collapsed') && has(summary, 'card-collapse-visible'), 'collapsed view keeps favorites');
	assert.deepEqual(titles(summary), ['★ Kansas City Chiefs', '★ New York Giants']);

	const kc = findAll(all, (n) => has(n, 'nfl-schedule-team'))[0];
	const rows = findAll(kc, (n) => n.tag === 'tr').slice(1);
	assert.equal(rows.length, 3);
	assert.equal(text(rows[0]), '1@ BUF' + 'W 24-17');
	assert.equal(text(findAll(kc, (n) => has(n, 'nfl-schedule-record'))[0]), '1-0');
	assert.ok(has(rows[1], 'nfl-schedule-next') && !has(rows[0], 'nfl-schedule-next'), 'the first unplayed game is marked next');
	assert.ok(text(rows[1]).startsWith('2@ ★ NYG'), 'a favorite opponent is starred; KC is away in week 2');
	const buf = findAll(all, (n) => has(n, 'nfl-schedule-team'))[2];
	assert.ok(findAll(buf, (n) => has(n, 'nfl-schedule-bye')).some((r) => text(r) === '3BYE—'), 'a bye renders as BYE');
}

assert.equal(ctx.renderNflSchedulesCard(undefined), null);
assert.equal(ctx.renderNflSchedulesCard({ teams: {} }), null);

assert.match(
	scriptSource,
	/if \(nflPowerCard\) gridEl\.appendChild\(nflPowerCard\);[\s\S]*?renderNflSchedulesCard\(data\.nflSchedules[\s\S]*?gridEl\.appendChild\(nflSchedulesCard\);\s*renderDepthChartCards/,
	'Schedules sits after Power Index, ahead of Depth Charts',
);
assert.match(scriptSource, /:not\(\[data-nfl-schedules\]\)'\)\.forEach/, 'rerenderNflCards must not remove the Schedules card on a poll');
assert.match(scriptSource, /:scope > \[data-nfl-schedules\]/, 'appendNflCard inserts poll cards ahead of Schedules');

console.log('test-nfl-schedules: all assertions passed');
