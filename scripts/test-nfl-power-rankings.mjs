// Unit test for the NFL tab's Power Rankings card: extractPowerRankings
// (scripts/lib/espn-fpi.mjs) and the page's ordering/render
// (buildNflPowerRows, renderNflPowerCard in myffl.html).
//
// The fixture mirrors the layout probe-espn-fpi.mjs RUN 1 saw: a top-level
// `categories[].names` and per-team `categories[].values` that line up
// POSITIONALLY.
//
// Pinned:
//   * values are joined to names through the top-level layout, not by index,
//     so a reordered response still reads correctly.
//   * ESPN's rank of 0 (its "-") is null, never a rank; a real 0 (wins,
//     a 0% chance) stays 0; an absent value is null, never 0.
//   * unrounded floats are rounded to one decimal.
//   * a team with no FPI is skipped; no usable team means fetch throws
//     upstream (extract returns {}).
//   * the page ranks by ESPN's rank, unranked last, then response order,
//     and renders every missing number as a dash.
//   * no `nflPowerRankings` on the snapshot means no card at all, and the
//     card sits right after Standings in renderGrid and is excluded from
//     rerenderNflCards' removal query (a poll must not delete it).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { extractPowerRankings } from './lib/espn-fpi.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(root, 'myffl.html'), 'utf8');
const scriptSource = html.match(/<script>([\s\S]*)<\/script>/)[1];

const LAYOUT = {
	categories: [
		{ name: 'fpi', names: ['fpi', 'epaoffense', 'epadefense', 'epaspecialteams', 'fpirank', 'accomplishmentrank', 'avgsosrank', 'sosremainingrank', 'gamecontrolrank', 'avgingamewprank', 'rankchange7days', 'numwins', 'numlosses', 'numties'] },
		{ name: 'projections', names: ['projectedw', 'projectedl', 'probwinout', 'probwinconf', 'probwindiv', 'probmakeplayoffs'] },
		{ name: 'efficiencies', names: ['totefficiency', 'totefficiencyrank', 'offefficiency', 'offefficiencyrank', 'defefficiency', 'defefficiencyrank', 'stefficiency', 'stefficiencyrank'] },
	],
};
// SF as the real response had it (rank 1, 4-0).
const sfValues = {
	categories: [
		{ name: 'fpi', values: [6.871, 6.245, 0.16, 0.466, 1, 0, 28, 13, 0, 1, 0, 4, 0, 0] },
		{ name: 'projections', values: [13.292, 3.674, 1, null, 78.60000000000001, 98.6] },
		{ name: 'efficiencies', values: [82.326, 1, 88.14, 1, 54.492, 15, 77.008, 3] },
	],
};
const team = (abbr, extra = {}) => ({ team: { abbreviation: abbr, displayName: `${abbr} Team` }, ...sfValues, ...extra });

// --- extractPowerRankings ------------------------------------------------

{
	const teams = extractPowerRankings({ ...LAYOUT, teams: [team('SF')] });
	assert.deepEqual(teams.SF, {
		name: 'SF Team', rank: 1, fpi: 6.9, off: 88.1, def: 54.5, st: 77, w: 4, l: 0, t: 0,
		projW: 13.3, projL: 3.7, playoffs: 98.6, order: 0,
	});
}

{
	// Reordered layout: the join is by name, not position.
	const reordered = {
		categories: [
			{ name: 'fpi', names: ['numwins', 'fpi', 'fpirank', 'numlosses', 'numties'] },
		],
		teams: [{ team: { abbreviation: 'KC' }, categories: [{ name: 'fpi', values: [3, 2.5, 4, 1, 0] }] }],
	};
	const kc = extractPowerRankings(reordered).KC;
	assert.equal(kc.w, 3);
	assert.equal(kc.fpi, 2.5);
	assert.equal(kc.rank, 4);
	assert.equal(kc.l, 1);
	assert.equal(kc.projW, null, 'a category the response lacks leaves its fields null, not 0');
	assert.equal(kc.off, null);
}

{
	// ESPN's rank 0 is "-": null. A genuine 0 wins / 0% chance is kept.
	const zeroRank = team('DAL', { categories: [
		{ name: 'fpi', values: [-2.04, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0] },
		{ name: 'projections', values: [6, 11, 0, null, 0, 0] },
		sfValues.categories[2],
	] });
	const dal = extractPowerRankings({ ...LAYOUT, teams: [zeroRank] }).DAL;
	assert.equal(dal.rank, null, 'rank 0 is ESPN\'s placeholder, not a rank');
	assert.equal(dal.fpi, -2);
	assert.equal(dal.w, 0, 'a real 0 wins stays 0');
	assert.equal(dal.playoffs, 0, 'a real 0% stays 0');
}

{
	// No FPI: skipped. Duplicate abbreviation: first wins. Nothing usable: {}.
	const noFpi = team('NYJ', { categories: [{ name: 'fpi', values: [null, 0, 0, 0, 5] }] });
	const out = extractPowerRankings({ ...LAYOUT, teams: [noFpi, team('SF'), team('SF', { team: { abbreviation: 'SF', displayName: 'Dupe' } })] });
	assert.deepEqual(Object.keys(out), ['SF']);
	assert.equal(out.SF.name, 'SF Team');
	assert.deepEqual(extractPowerRankings({}), {});
	assert.deepEqual(extractPowerRankings({ ...LAYOUT, teams: [noFpi] }), {});
}

// --- page ------------------------------------------------------------------

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
		replaceWith(next) { const i = n.parent.children.indexOf(n); n.parent.children[i] = next; next.parent = n.parent; },
		querySelector: () => null, querySelectorAll: () => [], closest: () => null, remove() {},
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

{
	const power = {
		teams: {
			// Response order (FPI order) is the tiebreak; ESPN's rank leads.
			SF: { name: 'San Francisco 49ers', rank: 1, fpi: 6.9, off: 88.1, def: 54.5, st: 77, w: 4, l: 0, t: 0, projW: 13.3, projL: 3.7, playoffs: 98.6, order: 0 },
			KC: { name: 'Kansas City Chiefs', rank: 2, fpi: 0, off: 60, def: 61.2, st: 50, w: 2, l: 1, t: 1, projW: 9, projL: 8, playoffs: 0, order: 1 },
			// Unranked sorts last even though it came earlier than DAL.
			NYJ: { name: 'New York Jets', rank: null, fpi: -3.4, w: null, l: null, order: 2 },
			DAL: { name: 'Dallas Cowboys', rank: 3, fpi: -2, off: null, def: null, st: null, w: 0, l: 3, t: 0, projW: null, projL: null, playoffs: null, order: 3 },
		},
	};
	assert.deepEqual([...ctx.buildNflPowerRows(power)].map((t) => t.abbr), ['SF', 'KC', 'DAL', 'NYJ']);

	const card = ctx.renderNflPowerCard(power);
	assert.equal(card.dataset.nflPower, 'true');
	assert.equal(card.attrs['data-view'], 'nfl');
	const rows = findAll(card, (n) => n.tag === 'tr').slice(1); // minus the header
	assert.equal(rows.length, 4);
	const cells = (row) => row.children.map(text);
	assert.deepEqual(cells(rows[0]), ['1SF', '4-0', '+6.9', '88.1', '54.5', '77.0', '13.3-3.7', '98.6%']);
	assert.deepEqual(cells(rows[1]), ['2KC', '2-1-1', '0.0', '60.0', '61.2', '50.0', '9.0-8.0', '0.0%'], 'FPI 0.0 and 0% are real values, not dashes');
	assert.deepEqual(cells(rows[2]), ['3DAL', '0-3', '-2.0', '\u2014', '\u2014', '\u2014', '\u2014', '\u2014'], 'missing numbers are dashes');
	assert.deepEqual(cells(rows[3]), ['4NYJ', '\u2014', '-3.4', '\u2014', '\u2014', '\u2014', '\u2014', '\u2014'], 'an unranked team is numbered by position, record is a dash');
}

assert.equal(ctx.renderNflPowerCard(undefined), null, 'no nflPowerRankings on the snapshot means no card');
assert.equal(ctx.renderNflPowerCard({ teams: {} }), null, 'an empty set renders no card');

assert.match(
	scriptSource,
	/const nflStandingsCard = renderNflStandingsCard\(data\.nflStandings\);\s*if \(nflStandingsCard\) gridEl\.appendChild\(nflStandingsCard\);\s*const nflPowerCard = renderNflPowerCard\(data\.nflPowerRankings\);\s*if \(nflPowerCard\) gridEl\.appendChild\(nflPowerCard\);\s*renderDepthChartCards/,
	'the Power Rankings card sits right after Standings, ahead of Depth Charts',
);
assert.match(
	scriptSource,
	/querySelectorAll\(':scope > \.card\[data-view="nfl"\]:not\(\[data-depth-charts-wrap\]\):not\(\[data-nfl-standings\]\):not\(\[data-nfl-power\]\)'\)/,
	'rerenderNflCards must not remove the Power Rankings card on a poll',
);

console.log('test-nfl-power-rankings: all assertions passed');
