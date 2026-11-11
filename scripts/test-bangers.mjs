// Unit tests for api/bangers.js's pure parts: the validation that is the only
// guard on what reaches the store (and, through the public GET, every
// visitor), the normalisation that decides what is kept, and the stale-copy
// check that stops a second device from erasing the first one's edits.
//
// Run: node scripts/test-bangers.mjs

import assert from 'node:assert/strict';
import { validateBangers, normalizeBangers, isStale } from '../api/bangers.js';

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failures++; console.log(`  FAIL ${name} — ${e.message}`); }
}

const nominee = (over = {}) => ({ id: 'n1', title: 'Cruise', artist: 'Florida Georgia Line', by: 'Kevin', winner: true, ...over });
const year = (over = {}) => ({ id: 'y1', label: '2023', nominees: [nominee()], ...over });
const ok = (years) => validateBangers({ years }).errors.length === 0;

check('accepts a normal list', () => assert.ok(ok([year(), year({ id: 'y2', label: 'Grandfathered', nominees: [nominee({ id: 'n2' })] })])));
check('accepts an empty list and a year with no nominees', () => {
  assert.ok(ok([]));
  assert.ok(ok([year({ nominees: [] })]));
});
check('accepts several winners in one year', () => {
  assert.ok(ok([year({ nominees: [nominee(), nominee({ id: 'n2', title: 'Out Last Night' })] })]));
});
check('artist, by and winner may be left out', () => {
  assert.ok(ok([year({ nominees: [{ id: 'n1', title: 'Cruise' }] })]));
});
check('rejects a body that is not { years: [] }', () => {
  assert.ok(validateBangers(null).errors.length);
  assert.ok(validateBangers([]).errors.length);
  assert.ok(validateBangers({}).errors.length);
  assert.ok(validateBangers({ years: {} }).errors.length);
});
check('rejects a year with no name, or one that is too long', () => {
  assert.ok(!ok([year({ label: '   ' })]));
  assert.ok(!ok([year({ label: 'x'.repeat(41) })]));
});
check('rejects a nominee with no title', () => {
  assert.ok(!ok([year({ nominees: [nominee({ title: ' ' })] })]));
});
check('rejects over-long or mistyped fields', () => {
  assert.ok(!ok([year({ nominees: [nominee({ title: 'x'.repeat(121) })] })]));
  assert.ok(!ok([year({ nominees: [nominee({ artist: 'x'.repeat(121) })] })]));
  assert.ok(!ok([year({ nominees: [nominee({ by: 'x'.repeat(61) })] })]));
  assert.ok(!ok([year({ nominees: [nominee({ artist: 5 })] })]));
  assert.ok(!ok([year({ nominees: [nominee({ winner: 'yes' })] })]));
});
check('rejects bad or duplicate ids', () => {
  assert.ok(!ok([year({ id: 'a b' })]));
  assert.ok(!ok([year({ id: '' })]));
  assert.ok(!ok([year(), year()]), 'two years with one id');
  assert.ok(!ok([year({ nominees: [nominee(), nominee()] })]), 'two nominees with one id');
  assert.ok(!ok([year(), year({ id: 'y2' })]), 'a nominee id reused across years');
});
check('rejects non-objects and non-lists inside the list', () => {
  assert.ok(!ok([null]));
  assert.ok(!ok([year({ nominees: 'x' })]));
  assert.ok(!ok([year({ nominees: [null] })]));
});
check('caps the sizes', () => {
  assert.ok(!ok(Array.from({ length: 101 }, (_, i) => year({ id: `y${i}`, nominees: [] }))));
  assert.ok(!ok([year({ nominees: Array.from({ length: 41 }, (_, i) => nominee({ id: `n${i}` })) })]));
});
check('errors name the year, so the Admin tab can show them as written', () => {
  const { errors } = validateBangers({ years: [year({ nominees: [nominee({ title: '' })] })] });
  assert.match(errors[0], /"2023"/);
});

check('normalizeBangers trims, fills gaps and drops unknown fields', () => {
  const out = normalizeBangers([{ id: 'y1', label: ' 2023 ', extra: 1, nominees: [{ id: 'n1', title: ' Cruise ', winner: true, extra: 1 }] }]);
  assert.deepEqual(out, [{ id: 'y1', label: '2023', nominees: [{ id: 'n1', title: 'Cruise', artist: '', by: '', winner: true }] }]);
});
check('normalizeBangers keeps order and treats anything but true as not a winner', () => {
  const out = normalizeBangers([year({ id: 'b' }), year({ id: 'a', nominees: [nominee({ winner: undefined })] })]);
  assert.deepEqual(out.map((y) => y.id), ['b', 'a']);
  assert.equal(out[1].nominees[0].winner, false);
});

check('isStale: nothing stored is never stale', () => {
  assert.equal(isStale(null, null), false);
  assert.equal(isStale(null, 123), false);
});
check('isStale: base must match what is stored', () => {
  assert.equal(isStale({ updatedAt: 5 }, 5), false);
  assert.equal(isStale({ updatedAt: 5 }, 4), true);
  assert.equal(isStale({ updatedAt: 5 }, null), true, 'a page that saw nothing, when something is stored now');
  assert.equal(isStale({ updatedAt: 5 }, undefined), true);
});

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nall passed');
