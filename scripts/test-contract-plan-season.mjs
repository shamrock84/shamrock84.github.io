// Unit test for buildYearsCell's offseason-only planning gate in myffl.html,
// and the matching gate on the card-level "N/M contracts set" banner
// (contractsMissing's call site in renderCard).
//
// The Yrs cell's planning dropdown (pencil in a contract length before MFL
// sets a real one) makes sense only in the offseason, when a contract is
// actually being negotiated. A player who shows up with no contractYear
// during the season — a waiver claim, a trade — has nothing to plan yet, so
// nflInSeason must gate the dropdown itself, not just the surrounding banner
// text. The warning icon and the card-level banner are the same nag as the
// dropdown, just at two different altitudes, so both must go quiet on the
// same schedule: mid-season neither should appear at all, whether or not a
// plan was made before kickoff (a made plan still shows as plain text — it
// isn't lost — just without the ⚠/✓ icon dressing it up as due or done).
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
const hasWarnIcon = (td) => td.children.some((c) => c.tag === 'span' && c.className === 'contract-warn-icon');
// Off-season, non-select cells are [warnIcon, valueSpan] — the value span is
// always the second child, so index into it directly rather than searching
// by textContent (the warnIcon itself carries a truthy ⚠/✓ glyph). In
// season, the cell is flat (just a td with its own textContent) since there
// is no icon at all to push the value into a second child.
const cellText = (td) => (td.children.length ? td.children[1]?.textContent : td.textContent);

// A real contractYear from MFL always wins, in season or out.
{
	const ctx = makeContext(LOGGED_IN);
	const td = ctx.buildYearsCell({ id: 'p1', contractYear: '2' }, 'L1', null, MID_SEASON);
	check('a real contractYear renders plain, even mid-season', td.textContent === '2' && !hasSelect(td) && !hasWarnIcon(td));
}

// Logged out: never a dropdown or icon, in season or out — unchanged by this fix.
{
	const ctx = makeContext({});
	const td = ctx.buildYearsCell({ id: 'p1' }, 'L1', null, OFFSEASON);
	check('logged out, offseason: no dropdown, plain dash with icon', !hasSelect(td) && hasWarnIcon(td) && cellText(td) === '—');
}

// Logged in, offseason, unset: the planning dropdown and its warning icon
// are both available — this is the one state the whole workflow is for.
{
	const ctx = makeContext(LOGGED_IN);
	const td = ctx.buildYearsCell({ id: 'p1' }, 'L1', null, OFFSEASON);
	check('logged in, offseason, unset: dropdown is available', hasSelect(td));
	check('logged in, offseason, unset: warning icon is available', hasWarnIcon(td));
}

// Logged in, mid-season, unset, no plan: the bug — a newly acquired player
// must NOT be eligible to plan a contract length until the offseason, and
// must not be nagged about it with the ⚠ icon either.
{
	const ctx = makeContext(LOGGED_IN);
	const td = ctx.buildYearsCell({ id: 'newly-acquired' }, 'L1', null, MID_SEASON);
	check('logged in, mid-season, no plan: no dropdown', !hasSelect(td));
	check('logged in, mid-season, no plan: no warning icon', !hasWarnIcon(td));
	check('logged in, mid-season, no plan: reads as a plain dash', cellText(td) === '—');
}

// Logged in, mid-season, a plan already made before kickoff: the value still
// has to display (read-only) rather than vanishing the moment the season
// starts, but without the ✓ icon dressing it up as a live to-do item.
{
	const ctx = makeContext(LOGGED_IN);
	ctx.setContractPlan('L1', 'p1', '2');
	const td = ctx.buildYearsCell({ id: 'p1' }, 'L1', null, MID_SEASON);
	check('logged in, mid-season, pre-kickoff plan: no dropdown (not editable)', !hasSelect(td));
	check('logged in, mid-season, pre-kickoff plan: no icon', !hasWarnIcon(td));
	check('logged in, mid-season, pre-kickoff plan: shows the planned value', cellText(td) === '2');
}

// ---- the card-level "N/M contracts set" banner follows the same gate -----
// contractsMissing() itself is unconditional (other math — salary escalation,
// the expiration summary — still needs it year-round); it's specifically the
// banner's *display* gate in renderCard that must add !nflInSeason(), the
// same rule as the icon above. That gate is exercised indirectly through
// nflInSeason itself here, since renderCard needs a full league/page context
// this suite doesn't build; the literal `!nflInSeason() &&` condition is
// checked by grepping the source below, the way test-mfl-bench.mjs's own
// header pins a "never resurrect this" rule against the source text.
{
	const ctx = makeContext(LOGGED_IN);
	check('nflInSeason is false in the offseason (banner would be eligible to show)', !ctx.nflInSeason(OFFSEASON));
	check('nflInSeason is true mid-season (banner must be suppressed)', ctx.nflInSeason(MID_SEASON));
}
{
	const html = fs.readFileSync(path.join(root, 'myffl.html'), 'utf8');
	check(
		'the contracts-missing banner gate includes !nflInSeason()',
		/isAuction && isLoggedIn\(\) && !nflInSeason\(\) && contractsMissing\(\)\.length > 0/.test(html),
	);
}

if (failures) {
	console.log(`\n${failures} contract-plan-season test(s) failed.`);
	process.exit(1);
}
console.log('\nAll contract-plan-season tests passed.');
