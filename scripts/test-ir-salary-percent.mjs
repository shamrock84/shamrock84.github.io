#!/usr/bin/env node
// Pins how the IR share of a salary reaches the cap math: MFL's own
// `includeIRWithSalary` (TYPE=league, confirmed by probe-mfl-cap-totals RUN 1,
// "50" in all four salary-cap leagues) read by mflIrSalaryPercent, echoed per
// league as irSalaryPercentMfl, and layered under config's irSalaryPercent
// override in the page's capSummaryNumbers (the page side is in
// test-waivers.mjs, which lifts that function out of myffl.html).
//
// The cases that matter: a real "0" is IR-is-free and must not collapse to
// null the way an empty string does, and anything that is not a 0-100 number
// reads as "unknown" so the page falls through to the default instead of
// zeroing or inflating the charge.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mflIrSalaryPercent } from './lib/providers.mjs';

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok    ${name}`); } catch (err) { console.log(`  FAIL  ${name} — ${err.message}`); failures++; }
}
const lg = (v) => ({ league: { includeIRWithSalary: v } });

test('reads the string MFL sends', () => assert.equal(mflIrSalaryPercent(lg('50')), 50));
test('keeps a real 0 (IR is free)', () => assert.equal(mflIrSalaryPercent(lg('0')), 0));
test('keeps a real 100', () => assert.equal(mflIrSalaryPercent(lg('100')), 100));
test('keeps a fractional share', () => assert.equal(mflIrSalaryPercent(lg('37.5')), 37.5));
test('absent key is null', () => assert.equal(mflIrSalaryPercent({ league: {} }), null));
test('empty string is null, not 0', () => assert.equal(mflIrSalaryPercent(lg('')), null));
test('blank string is null', () => assert.equal(mflIrSalaryPercent(lg('  ')), null));
test('non-numeric is null', () => assert.equal(mflIrSalaryPercent(lg('half')), null));
test('out of range is null', () => {
  assert.equal(mflIrSalaryPercent(lg('-1')), null);
  assert.equal(mflIrSalaryPercent(lg('101')), null);
});
test('no league object is null', () => {
  assert.equal(mflIrSalaryPercent(null), null);
  assert.equal(mflIrSalaryPercent({}), null);
});
test('the slot-limit keys are never mistaken for it', () => {
  assert.equal(mflIrSalaryPercent({ league: { injuredReserve: '50', taxiSquad: '50' } }), null);
});

// The sync must echo it: dropping the field from the return object would leave
// the page on the default with every test above still green.
test('fetchMflLeagueRoster returns irSalaryPercentMfl', () => {
  const src = readFileSync(new URL('./lib/providers.mjs', import.meta.url), 'utf8');
  assert.match(src, /irSalaryPercentMfl = mflIrSalaryPercent\(leagueData\)/);
  assert.match(src, /\n    irSalaryPercentMfl,\n/);
});

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\ntest-ir-salary-percent: all assertions passed');
