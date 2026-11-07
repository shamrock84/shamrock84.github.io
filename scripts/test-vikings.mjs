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
import { validatePatch, applyPatch, emptyDocument } from '../api/vikings.js';

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failures++; console.log(`  FAIL ${name} — ${e.message}`); }
}
const ok = (p) => validatePatch(p).errors.length === 0;

check('accepts a seat patch', () => assert.ok(ok({ game: '2026-9', seats: { 1: 'Jeff', 12: 'Oly' } })));
check('accepts a face-only patch', () => assert.ok(ok({ game: '2026-9', face: '219' })));
check('accepts clearing with empty strings', () => assert.ok(ok({ game: '2026-9', face: '', seats: { 1: '' } })));
check('accepts a preseason game key', () => assert.ok(ok({ game: '2026-p3', seats: { 1: 'Nate' } })));
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

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nall passed');
