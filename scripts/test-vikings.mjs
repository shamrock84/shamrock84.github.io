// Unit tests for api/vikings.js's pure parts: the validation that is the only
// guard on what reaches the ticket store, and the per-game patch that keeps a
// stale page from overwriting anything but the cell it edited.
//
// Run: node scripts/test-vikings.mjs
//
// Why CI runs it:
// GET is public and POST is login-gated (see the header of api/vikings.js), so
// a patch that quietly dropped or kept the wrong value would show to everyone.

import assert from 'node:assert/strict';
import { validatePatch, applyPatch, emptyDocument, validateTaskPatch, applyTaskPatch, validateQuickLinks, normalizeQuickLinks } from '../api/vikings.js';

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failures++; console.log(`  FAIL ${name} — ${e.message}`); }
}
const ok = (p) => validatePatch(p).errors.length === 0;

check('accepts a seat patch', () => assert.ok(ok({ game: '2026-9', seats: { 1: 'Jeff', 12: 'Oly' } })));
check('accepts a face-only patch', () => assert.ok(ok({ game: '2026-9', face: '219' })));
check('accepts clearing with empty strings', () => assert.ok(ok({ game: '2026-9', face: '', seats: { 1: '' } })));
check('accepts a preseason game key', () => assert.ok(ok({ game: '2026-p3', seats: { 1: 'Nate' } })));
check('accepts a playoff row with info', () => assert.ok(ok({ game: '2026-po1', info: { date: '1/17', opp: 'Rams' } })));
check('rejects bad info', () => {
  assert.ok(!ok({ game: '2026-po1', info: { venue: 'x' } }));
  assert.ok(!ok({ game: '2026-po1', info: { opp: 5 } }));
  assert.ok(!ok({ game: '2026-po1', info: { opp: 'x'.repeat(41) } }));
  assert.ok(!ok({ game: '2026-po1', info: ['x'] }));
});
check('applyPatch merges info and deletes emptied fields', () => {
  const a = applyPatch(emptyDocument(), { game: '2026-po1', info: { date: ' 1/17 ', opp: 'Rams' } });
  assert.deepEqual(a.games['2026-po1'], { info: { date: '1/17', opp: 'Rams' }, seats: {} });
  const b = applyPatch(a, { game: '2026-po1', info: { opp: '' }, seats: { 1: 'Jeff' } });
  assert.deepEqual(b.games['2026-po1'], { info: { date: '1/17' }, seats: { 1: 'Jeff' } });
  const c = applyPatch(applyPatch(b, { game: '2026-po1', info: { date: '' } }), { game: '2026-po1', seats: { 1: '' } });
  assert.deepEqual(c.games, {}, 'a cleared playoff row disappears');
});
check('rejects a missing or malformed game key', () => {
  assert.ok(!ok({ seats: { 1: 'a' } }));
  assert.ok(!ok({ game: 'week9', seats: { 1: 'a' } }));
  assert.ok(!ok({ game: '2026-9; DROP', seats: { 1: 'a' } }));
  assert.ok(!ok({ game: '2026-x3', seats: { 1: 'a' } }));
});
check('rejects a patch that changes nothing', () => assert.ok(!ok({ game: '2026-9' })));
check('rejects non-string and over-long values', () => {
  assert.ok(!ok({ game: '2026-9', seats: { 1: 5 } }));
  assert.ok(!ok({ game: '2026-9', seats: { 1: 'x'.repeat(61) } }));
  assert.ok(!ok({ game: '2026-9', face: 'x'.repeat(9) }));
  assert.ok(!ok({ game: '2026-9', face: 219 }));
});
check('rejects non-numeric seat ids and non-object bodies', () => {
  assert.ok(!ok({ game: '2026-9', seats: { A: 'x' } }));
  assert.ok(!ok({ game: '2026-9', seats: ['x'] }));
  assert.ok(!ok(null));
  assert.ok(!ok([]));
});

check('applyPatch sets and trims values', () => {
  const d = applyPatch(emptyDocument(), { game: '2026-9', face: ' 219 ', seats: { 1: ' Jeff ' } });
  assert.deepEqual(d.games, { '2026-9': { face: '219', seats: { 1: 'Jeff' } } });
});
check('applyPatch leaves other games and seats alone', () => {
  const base = { games: { '2026-9': { face: '219', seats: { 1: 'Jeff', 2: 'Nate' } }, '2026-12': { seats: { 11: 'Kevin' } } } };
  const d = applyPatch(base, { game: '2026-9', seats: { 2: 'Kris' } });
  assert.deepEqual(d.games['2026-9'], { face: '219', seats: { 1: 'Jeff', 2: 'Kris' } });
  assert.deepEqual(d.games['2026-12'], { seats: { 11: 'Kevin' } });
});
check('applyPatch does not mutate its input', () => {
  const base = { games: { '2026-9': { face: '1', seats: { 1: 'a' } } } };
  const copy = JSON.stringify(base);
  applyPatch(base, { game: '2026-9', face: '', seats: { 1: '' } });
  assert.equal(JSON.stringify(base), copy);
});
check('an empty string deletes, and an emptied game disappears', () => {
  const base = { games: { '2026-9': { face: '219', seats: { 1: 'Jeff' } } } };
  const half = applyPatch(base, { game: '2026-9', seats: { 1: '' } });
  assert.deepEqual(half.games, { '2026-9': { face: '219', seats: {} } });
  const none = applyPatch(half, { game: '2026-9', face: '  ' });
  assert.deepEqual(none.games, {});
});

const task = (o = {}) => ({ text: 'Fix it', category: 'Bug', done: false, createdAt: 5, ...o });
const okTasks = (p) => validateTaskPatch(p).errors.length === 0;
check('task patch: accepts upserts and deletes', () => {
  assert.ok(okTasks({ tasks: { t1: task(), t2: null } }));
});
check('task patch: rejects empty, malformed and bad ids', () => {
  assert.ok(!okTasks({ tasks: {} }));
  assert.ok(!okTasks({}));
  assert.ok(!okTasks({ tasks: [] }));
  assert.ok(!okTasks({ tasks: { 'bad id': task() } }));
  assert.ok(!okTasks({ tasks: { t1: task({ text: '' }) } }));
  assert.ok(!okTasks({ tasks: { t1: task({ done: 'yes' }) } }));
  assert.ok(!okTasks({ tasks: { t1: 'x' } }));
});
check('task patch: replaces a stored task, adds, deletes and leaves others alone', () => {
  const stored = { a: task({ text: 'old', createdAt: 1 }), b: task({ text: 'keep', createdAt: 2 }), c: task({ createdAt: 3 }) };
  const next = applyTaskPatch(stored, { tasks: { a: task({ text: 'new', createdAt: 1, done: true, completedAt: 9 }), c: null, d: task({ text: 'added', createdAt: 4 }) } });
  assert.equal(next.a.text, 'new');
  assert.equal(next.a.done, true);
  assert.equal(next.a.completedAt, 9);
  assert.equal(next.b.text, 'keep');
  assert.ok(!('c' in next));
  assert.equal(next.d.order, 4, 'order backfills to createdAt like plans.js');
  assert.equal(stored.a.text, 'old', 'input is not mutated');
});

const qlOk = (links) => validateQuickLinks({ links }).errors.length === 0;
check('quick links: accepts plain, styled and grouped entries', () => {
  assert.ok(qlOk([]));
  assert.ok(qlOk([{ url: 'https://vikings.com', nickname: 'Vikings' }, { url: 'http://x.co/a', nickname: 'X', style: 'gold', group: 'Tools' }]));
});
check('quick links: rejects a missing nickname, a non-http link and a bad style', () => {
  assert.ok(!qlOk([{ url: 'https://a.com', nickname: ' ' }]));
  assert.ok(!qlOk([{ url: 'javascript:alert(1)', nickname: 'x' }]));
  assert.ok(!qlOk([{ url: 'https://a.com', nickname: 'x', style: 'red' }]));
  assert.ok(!qlOk([{ url: 'https://a.com', nickname: 'x', group: 5 }]));
  assert.ok(!qlOk('nope'));
});
check('quick links: normalizing trims, drops blanks and unknown keys, keeps order', () => {
  assert.deepEqual(normalizeQuickLinks([{ url: ' https://a.com ', nickname: ' A ', style: '', group: ' ', extra: 1 }, { url: 'https://b.com', nickname: 'B', style: 'purple', group: 'G' }]),
    [{ url: 'https://a.com', nickname: 'A' }, { url: 'https://b.com', nickname: 'B', style: 'purple', group: 'G' }]);
});

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nall passed');
