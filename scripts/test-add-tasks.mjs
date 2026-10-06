// Pins planNewTasks in scripts/add-tasks.mjs: the entries it sends must be
// new (so the store's merge, where the stored copy wins collisions, can only
// add), valid by api/plans.js's own validateTasks, skipped when the exact
// text already exists, and ordered as given. No network.
//
// Why CI runs it:
// The Tasks-card add script: what it sends must be new ids only, valid
// for api/plans.js, and skipped when the exact text already exists, so
// a merge can only ever add.

import assert from 'node:assert/strict';
import { planNewTasks } from './add-tasks.mjs';
import { validatePlans, mergePlans } from '../api/plans.js';

const stored = {
	tOld1: { text: 'Existing open task', category: 'Bugs', done: false, order: 1, createdAt: 1, completedAt: null },
	tOld2: { text: 'Existing done task', category: 'Site Enhancement', done: true, order: 2, createdAt: 2, completedAt: 3 },
};

const now = 1_800_000_000_000;
const { added, skipped } = planNewTasks(stored, ['First new', '  ', 'Existing done task', 'Second new', 'First new'], 'Site Enhancement', now);

const entries = Object.values(added);
assert.deepEqual(entries.map((t) => t.text), ['First new', 'Second new'], 'blank lines and repeats dropped, order kept');
assert.deepEqual(skipped, ['Existing done task', 'First new'], 'existing text (even done) and in-batch repeats are skipped');
assert.ok(entries.every((t) => t.category === 'Site Enhancement' && t.done === false && t.completedAt === null));
assert.ok(entries[0].order < entries[1].order, 'later lines sort after earlier ones');
assert.ok(Object.keys(added).every((id) => /^t[0-9a-z]+$/.test(id) && !(id in stored)), 'ids match the page\'s shape and never collide');

// The payload passes the endpoint's own validation...
assert.deepEqual(validatePlans({ tasks: added }), [], 'payload is valid for api/plans.js');

// ...and a merge with the stored document keeps every existing task intact.
const merged = mergePlans({ tasks: stored, contractPlans: { L1: { p1: '3' } } }, { tasks: added });
assert.equal(Object.keys(merged.tasks).length, 4, 'two added, two kept');
assert.equal(merged.tasks.tOld1.text, 'Existing open task');
assert.equal(merged.tasks.tOld2.done, true, 'an existing task is not touched');
assert.equal(merged.contractPlans.L1.p1, '3', 'other plan kinds survive the merge');

console.log('add-tasks: all assertions passed');
