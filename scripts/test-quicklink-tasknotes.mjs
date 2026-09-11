// Unit test for the quick-link toolbar's task-count footnote and its
// per-card counterpart — quickLinkTaskCounts/appendQuickLink/
// quickLinkLabelForLeague/taskBadgeLabel/buildCardHead in myffl.html.
//
// The footnote's whole job is to tell a manager "there's filed work about
// this link" without a click, so its two failure modes are both silent: a
// done task still counting would never let the number reach zero and
// disappear, training the eye to ignore it forever; a category matched
// loosely (substring, case-insensitive) would put someone else's task count
// on this link, or this link's count on a differently-cased category that
// only looks the same. "Sum" is exact-string, open-tasks-only by design —
// this pins both.
//
// The Rosters/Standings/Scoring card badge (buildCardHead) reads the exact
// same counts under the exact same key (quickLinkLabelForLeague) as the
// toolbar footnote, so the two must never disagree about a given league —
// that shared key, not two independently-written label fallbacks, is what
// this file pins for the card side.
//
// The page's own script block is evaluated in a vm, so this drives the real
// implementations rather than a copy of them.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(root, 'myffl.html'), 'utf8');
const scriptSource = html.match(/<script>([\s\S]*)<\/script>/)[1];

function node(tag = 'div') {
	const n = {
		tag, children: [], attrs: {}, cls: '', _text: '', dataset: {}, style: {}, listeners: {},
		classList: {
			add(c) { n.cls = `${n.cls} ${c}`.trim(); },
			remove(c) { n.cls = n.cls.split(' ').filter((x) => x !== c).join(' '); },
			toggle() {},
			contains: (c) => n.cls.split(' ').includes(c),
		},
		addEventListener(type, fn) { (n.listeners[type] = n.listeners[type] || []).push(fn); },
		removeEventListener() {},
		setAttribute(k, v) { n.attrs[k] = v; },
		focus() {}, remove() {}, scrollIntoView() {},
		appendChild(c) { n.children.push(c); return c; },
		insertBefore(c) { n.children.push(c); return c; },
		querySelector: () => null, querySelectorAll: () => [], closest: () => null,
		get className() { return n.cls; }, set className(v) { n.cls = v; },
		get innerHTML() { return ''; }, set innerHTML(v) { if (v === '') n.children.length = 0; },
		get textContent() { return n._text; }, set textContent(v) { n._text = v; },
	};
	return n;
}

let tasksStore = '{}';
const context = {
	console,
	localStorage: {
		getItem: (k) => (k === 'myfflTasks' ? tasksStore : null),
		setItem() {}, removeItem() {},
	},
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

const { quickLinkTaskCounts, appendQuickLink, quickLinkLabelForLeague, taskBadgeLabel, buildCardHead, attachTaskBadgeClick, goToTasksCard } = context;

function setTasks(tasks) {
	tasksStore = JSON.stringify(tasks);
}

// ---- quickLinkTaskCounts: exact category, open tasks only --------------------

setTasks({
	a: { text: 'Fix the widget', category: 'MNMx', done: false },
	b: { text: 'Second one', category: 'MNMx', done: false },
	c: { text: 'Done already', category: 'MNMx', done: true },
	d: { text: 'Different casing', category: 'mnmx', done: false },
	e: { text: 'No category', category: '', done: false },
	f: { text: 'Other league', category: 'Superflex', done: false },
});
{
	const counts = quickLinkTaskCounts();
	assert.equal(counts['MNMx'], 2, 'two open tasks sum for an exact category match');
	assert.equal(counts['mnmx'], 1, 'a different-case category is a separate, exact key, not folded into the other');
	assert.equal(counts['Superflex'], 1, 'an unrelated category counts on its own');
	assert.equal(counts[''], undefined, 'a blank category is never a key — nothing on the toolbar can match it');
	assert.equal(counts['Done already'] ?? counts['MNMx'], 2, 'a done task does not inflate the count');
}

// Objects built inside the vm carry that realm's own Object prototype, which
// assert/strict's deepEqual counts as a difference from a plain object here
// (see test-admin-dirty.mjs's identical note on arrays) — round-tripped
// through JSON to compare on shape alone.
const asPlain = (v) => JSON.parse(JSON.stringify(v));

setTasks({});
assert.deepEqual(asPlain(quickLinkTaskCounts()), {}, 'no tasks means no counts at all');

setTasks({ a: { text: 'x', category: 'Superflex', done: true } });
assert.deepEqual(asPlain(quickLinkTaskCounts()), {}, 'a category with only done tasks reports nothing, not zero');

// ---- appendQuickLink: the footnote itself --------------------------------------

function renderedLink(opts) {
	const bar = node();
	appendQuickLink(bar, opts);
	return bar.children[0];
}

{
	const link = renderedLink({ url: 'https://example.com', label: 'MNMx', taskCount: 3 });
	const note = link.children.find((c) => c.cls.split(' ').includes('quicklink-tasknote'));
	assert.ok(note, 'a positive task count renders the footnote element');
	assert.equal(note.textContent, '3', 'the footnote text is the count itself');
}

{
	const link = renderedLink({ url: 'https://example.com', label: 'MNMx', taskCount: 0 });
	assert.equal(link.children.find((c) => c.cls.split(' ').includes('quicklink-tasknote')), undefined,
		'a zero count omits the footnote entirely rather than printing 0');
}

{
	const link = renderedLink({ url: 'https://example.com', label: 'MNMx' });
	assert.equal(link.children.find((c) => c.cls.split(' ').includes('quicklink-tasknote')), undefined,
		'no taskCount at all (an unmatched label) omits the footnote the same way');
}

{
	// Gold/purple entries wrap the label in its own inner span (see
	// appendQuickLink's own comment); the footnote must sit outside that
	// span so it never inherits the pill's background.
	const link = renderedLink({ url: 'https://example.com', label: 'Sleeper App', style: 'gold', taskCount: 1 });
	const note = link.children.find((c) => c.cls.split(' ').includes('quicklink-tasknote'));
	const pill = link.children.find((c) => c.tag === 'span');
	assert.ok(note && pill, 'both the pill span and the footnote are present');
	assert.ok(!pill.children.includes(note), 'the footnote is a sibling of the pill span, not nested inside it');
}

// ---- quickLinkLabelForLeague: the shared key --------------------------------

assert.equal(quickLinkLabelForLeague({ nickname: 'MNMx', displayName: 'Monday Night Madness', id: '100' }), 'MNMx',
	'nickname (Toolbar Label) wins over everything else');
assert.equal(quickLinkLabelForLeague({ displayName: 'Iron Bank', leagueName: 'Iron Bank League', id: '200' }), 'Iron Bank',
	'falls back to leagueDisplayName when there is no nickname');
assert.equal(quickLinkLabelForLeague({ id: '300' }), '300',
	'falls back to the id as a last resort, same as the toolbar itself');

// ---- taskBadgeLabel: pluralization ------------------------------------------

assert.equal(taskBadgeLabel(1), '1 Task', 'singular reads naturally');
assert.equal(taskBadgeLabel(2), '2 Tasks', 'plural gets the s');
assert.equal(taskBadgeLabel(11), '11 Tasks', 'double digits still pluralize');

// ---- buildCardHead: the card badge itself -----------------------------------

function badgeTexts(cardHead) {
	const badgesEl = cardHead.children.find((c) => c.cls.split(' ').includes('badges'));
	return badgesEl.children.map((b) => ({ text: b.textContent, cls: b.cls }));
}

setTasks({
	a: { text: 'Fix scoring', category: 'MNMx', done: false },
	b: { text: 'Another one', category: 'MNMx', done: false },
	c: { text: 'Resolved', category: 'MNMx', done: true },
});

{
	const card = node();
	card.dataset.view = 'rosters';
	const head = buildCardHead(card, { id: '100', nickname: 'MNMx', type: 'dynasty' });
	const badge = badgeTexts(head).find((b) => b.cls.includes('badge-task'));
	assert.ok(badge, 'a league whose nickname matches an open-task category gets the task badge');
	assert.equal(badge.text, '2 Tasks', 'and it carries the right open-task count');
}

{
	const card = node();
	card.dataset.view = 'rosters';
	const head = buildCardHead(card, { id: '200', nickname: 'Unrelated', type: 'dynasty' });
	const badge = badgeTexts(head).find((b) => b.cls.includes('badge-task'));
	assert.equal(badge, undefined, 'a league with no matching category gets no task badge at all');
}

{
	// A league with no nickname set still falls back to leagueDisplayName —
	// the same key a task's category would have to be typed as to match it.
	const card = node();
	card.dataset.view = 'standings';
	const head = buildCardHead(card, { id: '300', displayName: 'MNMx', type: 'dynasty' });
	const badge = badgeTexts(head).find((b) => b.cls.includes('badge-task'));
	assert.ok(badge, 'the fallback display name is a valid match key too, same as the toolbar');
	assert.equal(badge.text, '2 Tasks');
}

{
	// Every task settles (done) — the badge must disappear entirely, not
	// freeze at its last count or show a bare "0 Tasks".
	setTasks({ a: { text: 'Fix scoring', category: 'MNMx', done: true } });
	const card = node();
	card.dataset.view = 'scoring';
	const head = buildCardHead(card, { id: '100', nickname: 'MNMx', type: 'dynasty' });
	const badge = badgeTexts(head).find((b) => b.cls.includes('badge-task'));
	assert.equal(badge, undefined, 'a fully-completed category leaves no task badge behind');
}

// ---- attachTaskBadgeClick: wiring shared by all three markers --------------

{
	const badge = node('span');
	attachTaskBadgeClick(badge);
	assert.equal(badge.attrs.role, 'button', 'exposed as a button to assistive tech');
	assert.equal(badge.attrs.tabindex, '0', 'keyboard-reachable');
	assert.equal(badge.title, 'Go to Tasks', 'tells a mouse user what the click does');
	assert.ok(badge.cls.split(' ').includes('task-badge-link'), 'carries the shared clickable-marker class');
}

{
	// Redirect the global goToTasksCard so this only pins that a click (and
	// Enter/Space, for keyboard parity) reaches it, and that the event's
	// default action and propagation are both swallowed — needed so the
	// toolbar footnote doesn't also follow its <a> out to the league site,
	// and the card badge doesn't also toggle the card it sits inside.
	// goToTasksCard's own behavior is pinned separately below.
	const calls = [];
	const realGoToTasksCard = context.goToTasksCard;
	context.goToTasksCard = () => calls.push('go');

	const badge = node('span');
	attachTaskBadgeClick(badge);
	let prevented = false;
	let stopped = false;
	badge.listeners.click[0]({ preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; } });
	assert.deepEqual(calls, ['go'], 'a click activates it');
	assert.ok(prevented, 'and swallows the click\'s default action');
	assert.ok(stopped, 'and its propagation');

	calls.length = 0;
	const noop = { preventDefault() {}, stopPropagation() {} };
	badge.listeners.keydown[0]({ key: 'Enter', ...noop });
	badge.listeners.keydown[0]({ key: ' ', ...noop });
	badge.listeners.keydown[0]({ key: 'Tab', ...noop });
	assert.deepEqual(calls, ['go', 'go'], 'Enter and Space activate it, same as a click; other keys do not');

	context.goToTasksCard = realGoToTasksCard;
}

// ---- goToTasksCard: finding, expanding and landing on the Tasks card -------

const realSwitchToView = context.switchToView;

{
	// No Tasks card in the DOM at all — the improbable logged-out-with-
	// stale-local-tasks case, or a click that outlives a logout. Must be a
	// silent no-op, never a switch to an Admin tab with nothing on it.
	const calls = [];
	context.switchToView = (v) => calls.push(v);
	context.document.querySelector = () => null;
	goToTasksCard();
	assert.deepEqual(calls, [], 'nothing to expand means no tab switch either');
	context.switchToView = realSwitchToView;
}

{
	// Collapsed: switches tabs, expands via the toggle's own click handling
	// (not a hand-rolled class flip), and scrolls to it.
	const calls = [];
	context.switchToView = (v) => calls.push(v);
	const toggle = node('button');
	toggle.className = 'card-collapse-toggle';
	let toggleClicked = 0;
	toggle.click = () => { toggleClicked++; };
	const card = node('div');
	card.className = 'planning-card card-collapsed';
	card.querySelector = (sel) => (sel === '.card-collapse-toggle' ? toggle : null);
	let scrolled = 0;
	card.scrollIntoView = () => { scrolled++; };
	context.document.querySelector = (sel) => (sel === '.planning-card' ? card : null);
	goToTasksCard();
	assert.deepEqual(calls, ['admin'], 'switches to the Admin tab');
	assert.equal(toggleClicked, 1, 'expands a collapsed card via its own toggle');
	assert.equal(scrolled, 1, 'and scrolls it into view');
	context.switchToView = realSwitchToView;
}

{
	// Already expanded: same tab switch and scroll, but the toggle must be
	// left alone — clicking it would collapse a card that wasn't collapsed.
	const calls = [];
	context.switchToView = (v) => calls.push(v);
	const toggle = node('button');
	let toggleClicked = 0;
	toggle.click = () => { toggleClicked++; };
	const card = node('div');
	card.className = 'planning-card';
	card.querySelector = () => toggle;
	let scrolled = 0;
	card.scrollIntoView = () => { scrolled++; };
	context.document.querySelector = () => card;
	goToTasksCard();
	assert.deepEqual(calls, ['admin']);
	assert.equal(toggleClicked, 0, 'an already-expanded card is left alone');
	assert.equal(scrolled, 1);
	context.switchToView = realSwitchToView;
}

console.log('All quick-link task-footnote checks passed.');
