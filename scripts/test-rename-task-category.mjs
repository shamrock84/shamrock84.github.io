// Pins scripts/rename-task-category.mjs's rename rule: exact match on
// category, open and completed alike, every other field and task untouched.
import assert from 'node:assert/strict';
import { renameCategory } from './rename-task-category.mjs';

const tasks = {
	a: { text: 'open bug', category: 'Bugs', done: false, createdAt: 1 },
	b: { text: 'done bug', category: 'Bugs', done: true, completedAt: 9 },
	c: { text: 'other', category: 'Site Enhancement', done: false },
	d: { text: 'case differs', category: 'bugs', done: false },
	e: { text: 'no category', done: false },
};
const before = JSON.stringify(tasks);
const changed = renameCategory(tasks, 'Bugs', 'Bug');
assert.deepEqual(Object.keys(changed), ['a', 'b']);
assert.deepEqual(changed.b, { text: 'done bug', category: 'Bug', done: true, completedAt: 9 });
assert.equal(JSON.stringify(tasks), before, 'input must not be mutated');
assert.deepEqual(renameCategory({}, 'Bugs', 'Bug'), {});
assert.deepEqual(renameCategory(undefined, 'Bugs', 'Bug'), {});
console.log('rename-task-category: all assertions passed');
