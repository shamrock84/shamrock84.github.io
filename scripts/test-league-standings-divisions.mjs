// Unit test for the Standings tab's League | Division toggle: the sync-side
// division fields (withDivisions/mflFranchiseDivisions and each provider's
// standings fetch in scripts/lib/providers.mjs) and the page's grouping and
// toggle (buildLeagueStandingsDivisions/renderStandingsCard in myffl.html).
//
// Pinned:
//   * each provider's division membership is read off the response its
//     standings fetch already makes, and lands as { divisionId, division }
//     on every row.
//   * fewer than two divisions, or any row without one, strips the fields
//     entirely — no Division view that only repeats the League view or
//     leaves a team out.
//   * the page groups in division-id order (numeric-aware), keeps the
//     league table's own order within a division, ranks 1..n per division.
//   * no divisions means no toggle; Division is the default and listed
//     first; the toggle stays visible on a collapsed card; the choice is
//     stored per league, so switching one card leaves every other card
//     alone.
//   * collapsing the card keeps only the manager's own division box.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { withDivisions, mflFranchiseDivisions, fetchStandings, fetchSleeperStandings } from './lib/providers.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(root, 'myffl.html'), 'utf8');
const scriptSource = html.match(/<script>([\s\S]*)<\/script>/)[1];

// --- sync side ---------------------------------------------------------------

{
	const row = (id, divisionId) => ({ franchiseId: id, ...(divisionId ? { divisionId, division: `D${divisionId}` } : {}) });
	assert.deepEqual(withDivisions([row('1', '1'), row('2', '2')]).map((r) => r.divisionId), ['1', '2']);
	assert.ok(withDivisions([row('1', '1'), row('2', '1')]).every((r) => !('divisionId' in r) && !('division' in r)), 'one division: fields stripped');
	assert.ok(withDivisions([row('1', '1'), row('2', '2'), row('3')]).every((r) => !('divisionId' in r)), 'a partial answer: fields stripped');
}

{
	// MFL: a lone division object and a missing name both handled.
	const leagueData = {
		league: {
			divisions: { division: [{ id: '00', name: 'North' }, { id: '01', name: 'South' }] },
			franchises: { franchise: [{ id: '0001', division: '00' }, { id: '0002', division: '01' }, { id: '0003' }] },
		},
	};
	const byId = mflFranchiseDivisions(leagueData);
	assert.deepEqual(byId.get('0001'), { id: '00', name: 'North' });
	assert.deepEqual(byId.get('0002'), { id: '01', name: 'South' });
	assert.ok(!byId.has('0003'), 'a franchise with no division attribute is left out');
	const lone = mflFranchiseDivisions({ league: { divisions: { division: { id: '00', name: 'Only' } }, franchises: { franchise: { id: '0001', division: '00' } } } });
	assert.deepEqual(lone.get('0001'), { id: '00', name: 'Only' });
	assert.equal(mflFranchiseDivisions({}).size, 0);
}

const realFetch = globalThis.fetch;
function mockFetch(routes) {
	globalThis.fetch = async (url) => {
		const hit = Object.entries(routes).find(([frag]) => String(url).includes(frag));
		if (!hit) return { ok: false, status: 404, json: async () => ({}) };
		return { ok: true, status: 200, json: async () => hit[1] };
	};
}

{
	// MFL standings: division rides on the cached TYPE=league info.
	mockFetch({
		'TYPE=leagueStandings': { leagueStandings: { franchise: [{ id: '0002', h2hw: '3' }, { id: '0001', h2hw: '1' }] } },
	});
	const info = {
		nameById: new Map([['0001', 'A'], ['0002', 'B']]),
		ownerById: new Map(),
		divisionById: new Map([['0001', { id: '00', name: 'North' }], ['0002', { id: '01', name: 'South' }]]),
	};
	const rows = await fetchStandings({ id: '1', franchiseId: '0001' }, 'cookie', info);
	assert.deepEqual(rows.map((r) => [r.franchiseId, r.divisionId, r.division]), [['0002', '01', 'South'], ['0001', '00', 'North']]);
	// A cached pair from before divisionById existed still works.
	const plain = await fetchStandings({ id: '1', franchiseId: '0001' }, 'cookie', { nameById: info.nameById, ownerById: new Map() });
	assert.ok(plain.every((r) => !('divisionId' in r)));
}

{
	// Sleeper: settings.division against metadata.division_N; a failed
	// league read costs the names, never the standings.
	const rosters = [
		{ roster_id: 1, owner_id: 'u1', settings: { wins: 2, division: 1 } },
		{ roster_id: 2, owner_id: 'u2', settings: { wins: 1, division: 2 } },
	];
	mockFetch({ '/users': [], '/rosters': rosters, '/league/9': { metadata: { division_1: 'Alpha' } } });
	const rows = await fetchSleeperStandings({ id: '9', franchiseId: '1' });
	assert.deepEqual(rows.map((r) => [r.divisionId, r.division]), [['1', 'Alpha'], ['2', 'Division 2']]);
	mockFetch({ '/users': [], '/rosters': rosters });
	const fallback = await fetchSleeperStandings({ id: '9', franchiseId: '1' });
	assert.deepEqual(fallback.map((r) => r.division), ['Division 1', 'Division 2']);
	mockFetch({ '/users': [], '/rosters': rosters.map((r) => ({ ...r, settings: { wins: r.settings.wins } })) });
	assert.ok((await fetchSleeperStandings({ id: '9', franchiseId: '1' })).every((r) => !('divisionId' in r)), 'no division setting: no fields');
}
globalThis.fetch = realFetch;

// --- page ----------------------------------------------------------------------

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
		append(...cs) { cs.forEach((c) => n.appendChild(c)); },
		insertBefore(c) { n.children.push(c); return c; },
		replaceWith(next) { const i = n.parent.children.indexOf(n); n.parent.children[i] = next; next.parent = n.parent; },
		querySelector: () => null, querySelectorAll: () => [], closest: () => null, remove() {},
		get childNodes() { return [...n.children]; },
		get className() { return n.cls; }, set className(v) { n.cls = v; },
		get innerHTML() { return ''; }, set innerHTML(v) { if (v === '') n.children.length = 0; },
		get textContent() { return n._text; }, set textContent(v) { n._text = v; },
		getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
	};
	return n;
}
const store = new Map();
const ctx = {
	console,
	localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
	setTimeout, clearTimeout, setInterval, clearInterval,
	document: {
		addEventListener() {}, getElementById: () => domNode(), createElement: (t) => domNode(t),
		createTextNode: (t) => { const n = domNode('#text'); n.textContent = t; return n; },
		querySelector: () => null,
		querySelectorAll: () => [],
		visibilityState: 'visible', body: domNode(),
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
const hasCls = (c) => (n) => n.cls.split(/\s+/).includes(c);

const team = (id, divisionId, division, isMe = false) => ({
	franchiseId: id, teamName: `Team ${id}`, wins: 1, losses: 1, ties: 0, pointsFor: '100.00', pointsAgainst: '90.00', isMe,
	...(divisionId ? { divisionId, division } : {}),
});

{
	// League-table order: 1 (div 10), 2 (div 2), 3 (div 10), 4 (div 2).
	const rows = [team('1', '10', 'Ten'), team('2', '2', 'Two', true), team('3', '10', 'Ten'), team('4', '2', 'Two')];
	const groups = ctx.buildLeagueStandingsDivisions(rows);
	assert.deepEqual([...groups].map((g) => g.label), ['Two', 'Ten'], 'division-id order, numeric-aware');
	assert.deepEqual([...groups[0].rows].map((r) => r.franchiseId), ['2', '4'], 'league order kept within a division');
	assert.equal(ctx.buildLeagueStandingsDivisions([team('1', '1', 'A'), team('2')]), null, 'a row without a division: no Division view');
	assert.equal(ctx.buildLeagueStandingsDivisions([team('1', '1', 'A'), team('2', '1', 'A')]), null, 'one division: no Division view');

	store.clear();
	const league = { id: 'L1', name: 'L1', type: 'dynasty', standings: rows };
	const card = ctx.renderStandingsCard(league);
	const btn = (c, key) => findAll(c, (n) => n.dataset?.standingsView === key)[0];
	assert.equal(btn(card, 'division').attrs['aria-pressed'], 'true', 'Division is the default');
	assert.equal(findAll(card, hasCls('league-standings-division')).length, 2);
	const toggle = findAll(card, hasCls('league-standings-toggle'))[0];
	assert.ok(toggle.classList.contains('card-collapse-visible'), 'toggle survives a collapsed card');
	assert.deepEqual(findAll(toggle, (n) => n.dataset?.standingsView).map((b) => b.dataset.standingsView), ['division', 'league'], 'Division left of League');

	// Each card is independent: switching L1 to League leaves L2 alone,
	// on screen and in storage, and each survives a rebuild on its own.
	const other = ctx.renderStandingsCard({ ...league, id: 'L2' });
	btn(card, 'league').listeners.click[0]();
	assert.equal(store.get('myfflLeagueStandingsView:L1'), 'league');
	assert.equal(store.get('myfflLeagueStandingsView:L2'), undefined, 'the other league stores nothing');
	assert.equal(findAll(card, hasCls('league-standings-division')).length, 0);
	assert.equal(btn(card, 'league').attrs['aria-pressed'], 'true');
	assert.equal(btn(other, 'division').attrs['aria-pressed'], 'true', 'the other card does not follow the click');
	assert.equal(findAll(other, hasCls('league-standings-division')).length, 2);
	assert.equal(findAll(ctx.renderStandingsCard(league), hasCls('league-standings-division')).length, 0, 'a stored League choice survives a rebuild');
	assert.equal(findAll(ctx.renderStandingsCard({ ...league, id: 'L2' }), hasCls('league-standings-division')).length, 2, 'and the other league still opens on Division');

	btn(card, 'division').listeners.click[0]();
	assert.equal(store.get('myfflLeagueStandingsView:L1'), 'division');
	assert.equal(findAll(card, hasCls('league-standings-division')).length, 2);
	const boxes = findAll(card, hasCls('league-standings-division'));
	assert.ok(text(findAll(boxes[0], (n) => n.tag === 'th' && n.attrs.colspan)[0]).includes('Two'), 'banner names the division');
	assert.ok(boxes[0].classList.contains('me-division') && !boxes[1].classList.contains('me-division'));
	const ranks = findAll(boxes[1], (n) => n.tag === 'tr' && !n.cls.includes('standings-head-row')).map((tr) => tr.children[0]._text);
	assert.deepEqual(ranks, ['1', '2'], 'ranked within the division');
	const bannerRow = findAll(boxes[0], (n) => n.tag === 'tr')[0];
	assert.ok(bannerRow.cls.includes('standings-head-row'), 'banner survives the collapsed-card rule beside the me-row');

	// A rebuild reads the saved preference back.
	assert.equal(findAll(ctx.renderStandingsCard(league), hasCls('league-standings-division')).length, 2);

	// No divisions: no toggle, whatever the preference says.
	const flat = ctx.renderStandingsCard({ ...league, standings: rows.map(({ divisionId, division, ...r }) => r) });
	assert.equal(btn(flat, 'division'), undefined);
	assert.equal(findAll(flat, hasCls('league-standings-division')).length, 0);
	store.clear();
}

assert.match(html, /\.card\.card-collapsed\[data-view="standings"\] \.league-standings-division:not\(\.me-division\)/, 'collapsed card keeps only the manager\'s own division box');

console.log('test-league-standings-divisions: all assertions passed');
