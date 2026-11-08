// Pins the import's two safety properties: it only fills empty cells, and the
// frozen data is shaped so api/vikings.js accepts every patch.
// Run: node scripts/test-vikings-import.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { planImport } from './import-vikings-history.mjs';
import { validatePatch } from '../api/vikings.js';

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failures++; console.log(`  FAIL ${name} — ${e.message}`); }
}

check('fills only empty seats and face values', () => {
  const stored = { games: { '2025-2': { face: '180', seats: { 1: 'Someone' } } } };
  const { send, skipped } = planImport(stored, [
    { game: '2025-2', seats: { 1: 'Jeff', 2: 'Nate' }, face: '178' },
    { game: '2025-3', seats: { 1: 'Jeff' }, face: '178' },
  ]);
  assert.deepEqual(send, [{ game: '2025-2', seats: { 2: 'Nate' } }, { game: '2025-3', seats: { 1: 'Jeff' }, face: '178' }]);
  assert.equal(skipped, 2);
});
check('a fully present game sends nothing, and a re-run is a no-op', () => {
  const patches = [{ game: '2019-3', seats: { 1: 'Jeff', 2: 'Kristin' } }];
  const stored = { games: { '2019-3': { seats: { 1: 'Jeff', 2: 'Kristin' } } } };
  assert.deepEqual(planImport(stored, patches).send, []);
});
check('the frozen data is valid, past-seasons only, and keys are unique', () => {
  const { patches } = JSON.parse(fs.readFileSync(new URL('./vikings-import-data.json', import.meta.url), 'utf8'));
  assert.ok(patches.length > 90);
  const seen = new Set();
  for (const p of patches) {
    assert.deepEqual(validatePatch(p).errors, [], p.game);
    assert.ok(/^20(1[6-9]|2[0-5])-/.test(p.game), `${p.game} is outside 2016-2025`);
    assert.ok(!seen.has(p.game), `duplicate ${p.game}`);
    seen.add(p.game);
  }
});

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nall passed');
