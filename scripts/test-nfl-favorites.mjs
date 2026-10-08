// Unit test for the NFL-team Favorites feature in myffl.html.
//
// Favorites ride the plans document (api/plans.js) and tint the NFL tab. What
// breaks silently, and is pinned here:
//   * logged out, favorites are invisible (the same gate plans get);
//   * a provider's spelling of a team (WAS, LVR) matches the stored one (WSH, LV);
//   * a favorite team's name is marked .nfl-fav on game rows;
//   * the collapsed-card summary holds ONLY games involving a favorite, and is
//     absent with no favorites (the collapsed card then shows nothing extra);
//   * an unpushed local list beats the store's answer (adoptRemotePlans), and
//     the store's list wins once nothing is pending.
//
// Run: node scripts/test-nfl-favorites.mjs

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
		getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
	};
	return n;
}

function makeContext(store = {}) {
	const ctx = {
		console,
		localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; } },
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

function walk(node, fn) { fn(node); for (const c of node.children || []) walk(c, fn); }
function hasClass(n, c) { return n.cls.trim().split(/\s+/).includes(c); }
function find(node, c) { const out = []; walk(node, (n) => { if (hasClass(n, c)) out.push(n); }); return out; }

const game = (id, away, home) => ({ id, state: 'pre', kickoff: '2026-10-11T17:00:00Z', away: { team: away, score: null }, home: { team: home, score: null } });
const games = [game('1', 'KC', 'DEN'), game('2', 'WAS', 'DAL'), game('3', 'BUF', 'MIA')];

// Aliases and the login gate.
{
	const ctx = makeContext({});
	assert.equal(ctx.favoriteTeamKey('was'), 'WSH');
	assert.equal(ctx.favoriteTeamKey('LVR'), 'LV');
	assert.equal(ctx.favoriteTeamKey('KC'), 'KC');
	assert.equal(ctx.favoriteNflTeams().size, 0, 'logged out: no favorites');
}

// Logged out with a stored list: still empty, and no collapsed summary.
{
	const ctx = makeContext({ myfflFavorites: JSON.stringify({ nflTeams: ['KC'] }) });
	const card = ctx.renderNflScoreCard('t', 'Matchups', games, 'none');
	assert.equal(find(card, 'nfl-fav-collapsed').length, 0);
	assert.equal(find(card, 'nfl-fav').length, 0);
}

// Logged in with favorites.
{
	const ctx = makeContext({ mflAuthToken: 'x', myfflFavorites: JSON.stringify({ nflTeams: ['KC', 'WSH'] }) });
	assert.deepEqual([...ctx.favoriteNflTeams()].sort(), ['KC', 'WSH']);
	const card = ctx.renderNflScoreCard('t', 'Matchups', games, 'none');
	const summary = find(card, 'nfl-fav-collapsed');
	assert.equal(summary.length, 1);
	assert.ok(hasClass(summary[0], 'card-collapse-visible'));
	assert.equal(find(summary[0], 'nfl-game-row').length, 2, 'KC and WAS (alias of WSH) games only');
	const marked = find(card, 'nfl-fav').map((n) => n.textContent).sort();
	assert.deepEqual(marked, ['KC', 'KC', 'WAS', 'WAS'], 'name marked in the full list and in the summary');
	assert.equal(find(summary[0], 'nfl-boxscore-link').length, 0, 'compact rows carry no stat drawer');
}

// Logged in, no favorites: nothing extra.
{
	const ctx = makeContext({ mflAuthToken: 'x' });
	const card = ctx.renderNflScoreCard('t', 'Matchups', games, 'none');
	assert.equal(find(card, 'nfl-fav-collapsed').length, 0);
}

// Setting favorites normalizes, sorts, dedupes and marks the list pending.
{
	const store = { mflAuthToken: 'x' };
	const ctx = makeContext(store);
	ctx.setFavoriteNflTeams(['WAS', 'KC', 'WSH']);
	assert.deepEqual(JSON.parse(store.myfflFavorites), { nflTeams: ['KC', 'WSH'] });
	assert.equal(store.myfflFavoritesPending, '1');
}

// Sync: pending local list beats the store; otherwise the store wins.
{
	const store = { mflAuthToken: 'x', myfflFavorites: JSON.stringify({ nflTeams: ['KC'] }), myfflFavoritesPending: '1' };
	const ctx = makeContext(store);
	assert.equal(ctx.adoptRemotePlans({ favorites: { nflTeams: ['DAL'] } }), true, 'store is behind: ask for a push');
	assert.deepEqual(JSON.parse(store.myfflFavorites), { nflTeams: ['KC'] });
	delete store.myfflFavoritesPending;
	assert.equal(ctx.adoptRemotePlans({ favorites: { nflTeams: ['DAL'] } }), false);
	assert.deepEqual(JSON.parse(store.myfflFavorites), { nflTeams: ['DAL'] });
	ctx.adoptRemotePlans({});
	assert.deepEqual(JSON.parse(store.myfflFavorites), { nflTeams: [] }, 'a store with no favorites clears the cache');
}

console.log('NFL favorites tests passed.');
