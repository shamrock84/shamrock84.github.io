// Unit test for the quick-link toolbar's task-count footnote — see
// quickLinkTaskCounts/appendQuickLink in myffl.html.
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
// The page's own script block is evaluated in a vm, so this drives the real
// quickLinkTaskCounts/appendQuickLink rather than a copy of them.

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

const { quickLinkTaskCounts, appendQuickLink } = context;

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
	const note = link.children.find((c) => c.cls === 'quicklink-tasknote');
	assert.ok(note, 'a positive task count renders the footnote element');
	assert.equal(note.textContent, '3', 'the footnote text is the count itself');
}

{
	const link = renderedLink({ url: 'https://example.com', label: 'MNMx', taskCount: 0 });
	assert.equal(link.children.find((c) => c.cls === 'quicklink-tasknote'), undefined,
		'a zero count omits the footnote entirely rather than printing 0');
}

{
	const link = renderedLink({ url: 'https://example.com', label: 'MNMx' });
	assert.equal(link.children.find((c) => c.cls === 'quicklink-tasknote'), undefined,
		'no taskCount at all (an unmatched label) omits the footnote the same way');
}

{
	// Gold/purple entries wrap the label in its own inner span (see
	// appendQuickLink's own comment); the footnote must sit outside that
	// span so it never inherits the pill's background.
	const link = renderedLink({ url: 'https://example.com', label: 'Sleeper App', style: 'gold', taskCount: 1 });
	const note = link.children.find((c) => c.cls === 'quicklink-tasknote');
	const pill = link.children.find((c) => c.tag === 'span');
	assert.ok(note && pill, 'both the pill span and the footnote are present');
	assert.ok(!pill.children.includes(note), 'the footnote is a sibling of the pill span, not nested inside it');
}

console.log('All quick-link task-footnote checks passed.');
