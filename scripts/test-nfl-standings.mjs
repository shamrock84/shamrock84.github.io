// Unit test for the NFL tab's Standings card: extractStandings
// (scripts/lib/espn-standings.mjs) and the page's grouping/sorting/render
// (buildNflStandingsByDivision, renderNflStandingsCard in myffl.html).
//
// Pinned:
//   * extractStandings finds entries wherever they sit in ESPN's tree —
//     conference-level or nested one level deeper by division — since
//     which one the endpoint returns is not something this project trusts.
//   * a missing stat is null, never 0 (the card renders a dash).
//   * division record is accepted only as a real "W-L"/"W-L-T" string.
//   * the page groups by its own DEPTH_CHART_DIVISIONS, drops an unknown
//     abbreviation rather than guessing, and sorts by win pct (a tie counts
//     half), then conference seed, then ESPN's own response order.
//   * no `nflStandings` on the snapshot means no card at all.
//   * rerenderNflCards' removal query excludes the card — a poll must not
//     delete it, since nothing on the poll path rebuilds it (the same bug
//     the Depth Charts wrapper shipped once).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { extractStandings } from './lib/espn-standings.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(root, 'myffl.html'), 'utf8');
const scriptSource = html.match(/<script>([\s\S]*)<\/script>/)[1];

const stat = (name, value, displayValue, type) => ({ name, value, displayValue: displayValue ?? String(value), ...(type ? { type } : {}) });
const entry = (abbr, w, l, t, extra = []) => ({
	team: { abbreviation: abbr, displayName: `${abbr} Team` },
	stats: [stat('wins', w), stat('losses', l), stat('ties', t), stat('pointsFor', 100 + w), stat('pointsAgainst', 90 + l), ...extra],
});

// --- extractStandings ----------------------------------------------------

{
	// Conference-level shape.
	const flat = { children: [{ name: 'AFC', standings: { entries: [entry('BUF', 3, 1, 0, [stat('streak', 2, 'W2'), stat('playoffSeed', 1)])] } }] };
	const teams = extractStandings(flat);
	assert.equal(teams.BUF.w, 3);
	assert.equal(teams.BUF.streak, 'W2');
	assert.equal(teams.BUF.seed, 1);
	assert.equal(teams.BUF.name, 'BUF Team');

	// Division-level shape, nested one deeper — same result.
	const nested = { children: [{ name: 'AFC', children: [{ name: 'AFC East', standings: { entries: [entry('BUF', 3, 1, 0)] } }] }] };
	assert.equal(extractStandings(nested).BUF.w, 3, 'entries nested under division children are still found');
}

{
	// Missing stats are null, not 0.
	const teams = extractStandings({ children: [{ standings: { entries: [{ team: { abbreviation: 'KC' }, stats: [stat('wins', 2)] }] } }] });
	assert.equal(teams.KC.w, 2);
	assert.equal(teams.KC.l, null);
	assert.equal(teams.KC.pf, null);
	assert.equal(teams.KC.streak, null);
	assert.equal(teams.KC.seed, null);
}

{
	// Division record: accepted by type 'vsdiv' only when shaped like a record.
	const good = extractStandings({ standings: { entries: [entry('NE', 1, 3, 0, [stat('vs. Div.', 0, '1-1', 'vsdiv')])] } });
	assert.equal(good.NE.div, '1-1');
	const bad = extractStandings({ standings: { entries: [entry('NE', 1, 3, 0, [stat('vs. Div.', 0.5, '.500', 'vsdiv')])] } });
	assert.equal(bad.NE.div, null, 'a non-record displayValue is not passed off as a division record');
}

{
	assert.deepEqual(Object.keys(extractStandings({})), [], 'an unrecognised body yields no teams (fetchNflStandings then throws)');
}

// --- page ------------------------------------------------------------------

function domNode(tag = 'div') {
	const n = {
		tag, children: [], attrs: {}, cls: '', _text: '', dataset: {}, style: {},
		classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
		addEventListener() {}, removeEventListener() {},
		setAttribute(k, v) { n.attrs[k] = v; }, getAttribute(k) { return n.attrs[k]; },
		appendChild(c) { n.children.push(c); return c; },
		insertBefore(c) { n.children.push(c); return c; },
		querySelector: () => null, querySelectorAll: () => [], closest: () => null, remove() {},
		get className() { return n.cls; }, set className(v) { n.cls = v; },
		get innerHTML() { return ''; }, set innerHTML(v) { if (v === '') n.children.length = 0; },
		get textContent() { return n._text; }, set textContent(v) { n._text = v; },
		getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
	};
	return n;
}
const ctx = {
	console,
	localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
	setTimeout, clearTimeout, setInterval, clearInterval,
	document: {
		addEventListener() {}, getElementById: () => domNode(), createElement: (t) => domNode(t),
		createTextNode: (t) => { const n = domNode('#text'); n.textContent = t; return n; },
		querySelector: () => null, querySelectorAll: () => [], visibilityState: 'visible', body: domNode(),
	},
	window: { addEventListener() {} },
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
	const standings = {
		generatedAt: '2026-09-29T12:00:00Z',
		teams: {
			// AFC East: MIA and NYJ tie on pct; NYJ has the better seed.
			BUF: { name: 'Buffalo Bills', w: 4, l: 0, t: 0, order: 3 },
			MIA: { name: 'Miami Dolphins', w: 2, l: 2, t: 0, seed: 7, order: 0 },
			NYJ: { name: 'New York Jets', w: 2, l: 2, t: 0, seed: 6, order: 1 },
			// A tie counts half: 2-1-1 (.625) beats 2-2 (.500), loses to 3-1 (.750).
			NE: { name: 'New England Patriots', w: 2, l: 1, t: 1, order: 2 },
			// Unknown abbreviation — dropped, not guessed into a division.
			XYZ: { name: 'Nobody', w: 9, l: 0, t: 0, order: 4 },
		},
	};
	const byDivision = ctx.buildNflStandingsByDivision(standings);
	assert.deepEqual([...byDivision.get('afc-east')].map((t) => t.abbr), ['BUF', 'NE', 'NYJ', 'MIA']);
	const all = [...byDivision.values()].flat();
	assert.ok(!all.some((t) => t.abbr === 'XYZ'), 'an abbreviation outside DEPTH_CHART_DIVISIONS is dropped');

	const card = ctx.renderNflStandingsCard(standings);
	assert.equal(card.dataset.nflStandings, 'true');
	assert.equal(card.attrs['data-view'], 'nfl');
	const boxes = findAll(card, (n) => n.cls.split(/\s+/).includes('nfl-standings-division'));
	assert.equal(boxes.length, 1, 'a division with no teams renders no box');
	assert.ok(!boxes[0].cls.includes('depth-chart-position'), 'must not carry the Depth Charts search hook class');
	assert.ok(text(boxes[0]).includes('AFC East'));
	assert.ok(text(boxes[0]).includes('2-1-1'), 'a tie shows as W-L-T');
	assert.ok(!text(boxes[0]).includes('Div'), 'no Div column when ESPN sent no division record for anyone');
	// PF/PA/Strk absent on these fixtures render as dashes.
	assert.ok(text(boxes[0]).includes('—'));
}

assert.equal(ctx.renderNflStandingsCard(undefined), null, 'no nflStandings on the snapshot means no card');

assert.match(
	scriptSource,
	/querySelectorAll\(':scope > \.card\[data-view="nfl"\]:not\(\[data-depth-charts-wrap\]\):not\(\[data-nfl-standings\]\)'\)/,
	'rerenderNflCards must not remove the Standings card on a poll',
);

console.log('test-nfl-standings: all assertions passed');
