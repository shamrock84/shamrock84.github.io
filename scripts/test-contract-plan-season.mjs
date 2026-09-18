// Unit test for buildYearsCell's offseason-only planning gate in myffl.html.
//
// The Yrs cell's planning dropdown (pencil in a contract length before MFL
// sets a real one) makes sense only in the offseason, when a contract is
// actually being negotiated. A player who shows up with no contractYear
// during the season — a waiver claim, a trade — has nothing to plan yet, so
// nflInSeason must gate the dropdown itself, not just the surrounding banner
// text. A plan already made before kickoff still has to display (read-only)
// rather than silently disappearing the moment the season starts.
//
// As in test-cut-planning-window.mjs there is no real DOM here: the page's
// script block is evaluated in a vm with the handful of browser globals it
// touches stubbed, so this runs the real source rather than a copy of it.

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
		tag, children: [], value: '', title: '', textContent: '', dataset: {}, style: {},
		classList: {
			set: new Set(),
			add(c) { this.set.add(c); },
			remove(c) { this.set.delete(c); },
			toggle(c, force) {
				const want = force === undefined ? !this.set.has(c) : force;
				if (want) this.set.add(c); else this.set.delete(c);
			},
			contains(c) { return this.set.has(c); },
		},
		addEventListener() {}, removeEventListener() {},
		setAttribute(k, v) { n[`attr_${k}`] = v; },
		appendChild(c) { n.children.push(c); return c; },
		insertBefore(c) { n.children.push(c); return c; },
		removeChild(c) { n.children = n.children.filter((x) => x !== c); return c; },
		remove() {}, focus() {},
		querySelector: () => null, querySelectorAll: () => [], closest: () => null,
	};
	return n;
}

function makeContext(seed = {}) {
	const store = new Map(Object.entries(seed));
	const ctx = {
		console,
		localStorage: {
			getItem: (k) => (store.has(k) ? store.get(k) : null),
			setItem: (k, v) => store.set(k, String(v)),
			removeItem: (k) => store.delete(k),
		},
		setTimeout, clearTimeout, setInterval, clearInterval,
		document: {
			addEventListener() {},
			getElementById: () => domNode(),
			createElement: (t) => domNode(t),
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

const LOGGED_IN = { mflAuthToken: 'test-token' };
const OFFSEASON = new Date('2026-07-01T12:00:00Z');
const MID_SEASON = new Date('2026-11-15T12:00:00Z');

let failures = 0;
function check(name, cond) {
	if (cond) {
		console.log(`  ok   ${name}`);
	} else {
		failures++;
		console.log(`  FAIL ${name}`);
	}
}

const hasSelect = (td) => td.children.some((c) => c.tag === 'select');
// Non-select cells are always [warnIcon, valueSpan] — the value span is
// always the second child, so index into it directly rather than searching
// by textContent (the warnIcon itself carries a truthy ⚠/✓ glyph).
const dashText = (td) => td.children[1]?.textContent;

// A real contractYear from MFL always wins, in season or out.
{
	const ctx = makeContext(LOGGED_IN);
	const td = ctx.buildYearsCell({ id: 'p1', contractYear: '2' }, 'L1', null, MID_SEASON);
	check('a real contractYear renders plain, even mid-season', td.textContent === '2' && !hasSelect(td));
}

// Logged out: never a dropdown, in season or out — unchanged by this fix.
{
	const ctx = makeContext({});
	const td = ctx.buildYearsCell({ id: 'p1' }, 'L1', null, OFFSEASON);
	check('logged out, offseason: no dropdown, plain dash', !hasSelect(td) && dashText(td) === '—');
}

// Logged in, offseason, unset: the planning dropdown is available.
{
	const ctx = makeContext(LOGGED_IN);
	const td = ctx.buildYearsCell({ id: 'p1' }, 'L1', null, OFFSEASON);
	check('logged in, offseason, unset: dropdown is available', hasSelect(td));
}

// Logged in, mid-season, unset, no plan: the bug — a newly acquired player
// must NOT be eligible to plan a contract length until the offseason.
{
	const ctx = makeContext(LOGGED_IN);
	const td = ctx.buildYearsCell({ id: 'newly-acquired' }, 'L1', null, MID_SEASON);
	check('logged in, mid-season, no plan: no dropdown', !hasSelect(td));
	check('logged in, mid-season, no plan: reads as a plain dash', dashText(td) === '—');
}

// Logged in, mid-season, a plan already made before kickoff: it must still
// display (read-only) rather than vanishing the moment the season starts.
{
	const ctx = makeContext(LOGGED_IN);
	ctx.setContractPlan('L1', 'p1', '2');
	const td = ctx.buildYearsCell({ id: 'p1' }, 'L1', null, MID_SEASON);
	check('logged in, mid-season, pre-kickoff plan: no dropdown (not editable)', !hasSelect(td));
	check('logged in, mid-season, pre-kickoff plan: shows the planned value', dashText(td) === '2');
}

if (failures) {
	console.log(`\n${failures} contract-plan-season test(s) failed.`);
	process.exit(1);
}
console.log('\nAll contract-plan-season tests passed.');
