// Unit test for the Admin tab's unsaved-changes detection — adminComparable and
// adminPendingChanges in myffl.html.
//
// These decide three things at once: the dot on an edited league's head, the
// count on both Save buttons, and whether closing the tab warns you. All three
// fail silently and in opposite directions, which is why they're pinned here:
//
//   - a FALSE POSITIVE marks every league dirty the moment the card renders,
//     which trains the eye to ignore the dot and leaves the Save button
//     permanently claiming eighteen outstanding changes. The two ways to get
//     one are baked into the shape of the data: the tab's text inputs hand back
//     strings where config/leagues.json stores real numbers (every payout, and
//     cutdownRosterSize), and a key the draft adds lands in a different position
//     from the same key in the served entry. Both would report an edit that
//     saves to a byte-identical file.
//   - a FALSE NEGATIVE is worse and quieter: the page says nothing is
//     outstanding while an edit sits unsaved in memory, and the beforeunload
//     guard — the only thing between that edit and a refresh — stays disarmed.
//
// The at-rest case against the real committed config is the load-bearing one:
// eighteen leagues, freshly cloned, must come back with a count of zero.
//
// The page's own script block is evaluated in a vm, so this drives the real
// implementation rather than a copy of it. Page state (leagueConfig, adminDraft,
// adminLinksDraft) is declared with `let`, so it isn't reachable through the
// context object the way a function declaration is — it's set by running a
// snippet inside the same context, which shares that lexical scope.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(root, 'myffl.html'), 'utf8');
const scriptSource = html.match(/<script>([\s\S]*)<\/script>/)[1];
const realConfig = JSON.parse(fs.readFileSync(path.join(root, 'config/leagues.json'), 'utf8'));

function node(tag = 'div') {
	const n = {
		tag, children: [], attrs: {}, cls: '', _text: '', dataset: {}, style: {}, listeners: {},
		classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
		addEventListener() {}, removeEventListener() {}, setAttribute() {},
		focus() {}, remove() {},
		appendChild(c) { n.children.push(c); return c; },
		insertBefore(c) { n.children.push(c); return c; },
		querySelector: () => null, querySelectorAll: () => [], closest: () => null,
		get className() { return n.cls; }, set className(v) { n.cls = v; },
		get innerHTML() { return ''; }, set innerHTML(v) { if (v === '') n.children.length = 0; },
		get textContent() { return n._text; }, set textContent(v) { n._text = v; },
	};
	return n;
}

const context = {
	console,
	localStorage: { getItem: (k) => (k === 'mflAuthToken' ? 'test-token' : null), setItem() {}, removeItem() {} },
	setTimeout, clearTimeout, setInterval, clearInterval,
	document: {
		addEventListener() {}, getElementById: () => node(), createElement: (t) => node(t),
		createTextNode: (t) => { const n = node('#text'); n.textContent = t; return n; },
		querySelector: () => null, querySelectorAll: () => [], visibilityState: 'visible', body: node(),
	},
	window: { addEventListener() {} },
	fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
};
vm.createContext(context);
vm.runInContext(scriptSource, context);

const clone = (v) => JSON.parse(JSON.stringify(v));

// Sets the page's own draft state and returns what adminPendingChanges makes of
// it. Runs inside the vm context rather than through the context object because
// these are `let` bindings — see the header.
function pending({ served = [], draft = null, links = null, servedLinks = [] }) {
	context.__fixture = clone({ served, draft, links, servedLinks });
	// Stringified on the way out: an array built inside the vm carries that
	// realm's Array prototype, which assert/strict's deepEqual counts as a
	// difference even when the contents match.
	return JSON.parse(vm.runInContext(`
		leagueConfig = { leagues: __fixture.served, quickLinks: __fixture.servedLinks };
		adminDraft = __fixture.draft;
		adminLinksDraft = __fixture.links;
		(() => {
			const p = adminPendingChanges();
			return JSON.stringify({ count: p.count, order: p.order, links: p.links, dirtyIds: [...p.leagues].map((l) => l.id ?? null) });
		})();
	`, context));
}

const league = (over = {}) => ({ id: '100', franchiseId: '0001', type: 'dynasty', dues: 50, ...over });

// ---- adminComparable: what counts as the same saved value --------------------
const { adminComparable } = context;

// The false positive the Admin tab would otherwise hit on every league that has
// dues entered: the config holds a JSON number, the text input hands back the
// string the user sees in the box, and api/save-leagues.js writes the same byte
// either way (mergeLeague's putMoney/putNumber).
assert.equal(adminComparable({ dues: 50 }), adminComparable({ dues: '50' }),
	'a number and the string a text input produces are the same saved value');
assert.equal(adminComparable({ cutdownRosterSize: 23 }), adminComparable({ cutdownRosterSize: '23' }),
	'cutdownRosterSize compares the same way the payouts do');

// The other one: a draft that adds a key puts it at the end, while the served
// entry carries it in KEY_ORDER position. Raw JSON.stringify would call these
// different.
assert.equal(adminComparable({ id: '1', type: 'dynasty' }), adminComparable({ type: 'dynasty', id: '1' }),
	'key order is not a change');

// Blank, null and undefined all mean "not set" — matching mergeLeague's own
// drop-the-empties rule, so clearing a field that was never set isn't an edit.
assert.equal(adminComparable({ id: '1' }), adminComparable({ id: '1', nickname: '', displayName: undefined, season: null }),
	'blank, undefined and null all read as absent');

// And the values that genuinely differ still do.
assert.notEqual(adminComparable({ dues: 50 }), adminComparable({ dues: 60 }), 'a changed amount is a change');
assert.notEqual(adminComparable({ id: '1' }), adminComparable({ id: '1', lineupPilot: true }), 'a newly set flag is a change');
assert.notEqual(adminComparable({ tags: ['A'] }), adminComparable({ tags: ['A', 'B'] }), 'an added tag is a change');
// Zero is a deliberate, saved answer everywhere money is concerned (see
// isValidMoneyField in api/save-leagues.js), so it must not collapse to absent
// the way '' does — several leagues really do pay $0 for a season high.
assert.notEqual(adminComparable({ payout3: 0 }), adminComparable({}), 'zero is a value, not a blank');

// ---- the at-rest case: the real config, freshly cloned ------------------------
// The one that would have shipped the bug. Every league in config/leagues.json,
// deep-cloned into a draft exactly the way renderAdminCard seeds it, with
// nothing edited.
{
	const p = pending({ served: realConfig.leagues, draft: clone(realConfig.leagues), links: clone(realConfig.quickLinks || []), servedLinks: realConfig.quickLinks || [] });
	assert.deepEqual(p.dirtyIds, [], 'an unedited draft of the live config marks no league dirty');
	assert.equal(p.order, false, 'and reports no reordering');
	assert.equal(p.links, false, 'and no quick-link change');
	assert.equal(p.count, 0, 'so the Save button shows no count');
}

// No draft at all (the tab hasn't been opened, or a save just cleared it) is
// nothing outstanding — this is what disarms the beforeunload guard everywhere
// else on the site.
assert.equal(pending({ served: realConfig.leagues, draft: null }).count, 0, 'no draft means nothing outstanding');

// ---- what does count ---------------------------------------------------------
{
	const served = [league({ id: '100' }), league({ id: '200' })];
	const draft = clone(served);
	draft[1].dues = 75;
	const p = pending({ served, draft });
	assert.deepEqual(p.dirtyIds, ['200'], 'only the edited league is marked');
	assert.equal(p.count, 1, 'and it counts once');
}
{
	// Array order is display order on every tab, so a reorder is a real setting
	// change — and it's the one no individual league's own values record.
	const served = [league({ id: '100' }), league({ id: '200' })];
	const draft = [clone(served[1]), clone(served[0])];
	const p = pending({ served, draft });
	assert.deepEqual(p.dirtyIds, [], 'reordering edits no league');
	assert.equal(p.order, true, 'but is reported as a change of its own');
	assert.equal(p.count, 1, 'and counts');
}
{
	// A league added from the tab has no id yet, so nothing on the site looks
	// like it — that has to read as outstanding, not as a match against nothing.
	const served = [league({ id: '100' })];
	const draft = [...clone(served), { id: '', franchiseId: '', type: 'draftonly' }];
	const p = pending({ served, draft });
	assert.deepEqual(p.dirtyIds, [''], 'a brand-new league with no ID yet is outstanding');
	assert.equal(p.order, true, 'and the list it was appended to changed too');
}
{
	const served = [league({ id: '100' }), league({ id: '200' })];
	const p = pending({ served, draft: [clone(served[0])] });
	assert.equal(p.order, true, 'a removed league changes the list');
	assert.equal(p.count, 1, 'and counts once');
}
{
	// Editing the ID is how a league is pointed at a new season's URL; there's
	// no served entry under the new id, so it reads as outstanding.
	const served = [league({ id: '100' })];
	const draft = clone(served);
	draft[0].id = '101';
	const p = pending({ served, draft });
	assert.deepEqual(p.dirtyIds, ['101'], 'a re-pointed league ID is outstanding');
}
{
	// Both Save buttons write both drafts in one request, so a quick-link edit
	// has to raise the count on the Leagues card's button too.
	const served = [league({ id: '100' })];
	const p = pending({
		served,
		draft: clone(served),
		servedLinks: [{ url: 'https://a.example', nickname: 'A' }],
		links: [{ url: 'https://a.example', nickname: 'A' }, { url: 'https://b.example', nickname: 'B' }],
	});
	assert.equal(p.links, true, 'an added quick link is a change');
	assert.equal(p.count, 1, 'and counts on both cards');
}
{
	const served = [league({ id: '100' }), league({ id: '200' })];
	const draft = clone(served);
	draft[0].dues = 60;
	draft[1].nickname = 'Two';
	const p = pending({ served, draft, servedLinks: [], links: [{ url: 'https://a.example', nickname: 'A' }] });
	assert.equal(p.count, 3, 'two edited leagues plus the quick links add up');
}

console.log('All admin dirty-state checks passed.');
