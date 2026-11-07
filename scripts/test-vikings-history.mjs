// Pins the pure parts of the Vikings schedule backfill: which years it asks
// for and how a season is cut out of the all-teams schedule.
// Run: node scripts/test-vikings-history.mjs

import assert from 'node:assert/strict';
import { buildSeasonEntry, seasonsToBackfill, FIRST_SEASON } from './lib/vikings-history.mjs';

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failures++; console.log(`  FAIL ${name} — ${e.message}`); }
}

check('backfills 2016 up to, not including, the snapshot season', () => {
  assert.equal(FIRST_SEASON, 2016);
  assert.deepEqual(seasonsToBackfill('2026'), [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025]);
  assert.deepEqual(seasonsToBackfill(2017), [2016]);
  assert.deepEqual(seasonsToBackfill(2016), []);
});
check('cuts out the team and keeps byes in the regular season', () => {
  const sched = { teams: { MIN: [{ wk: 1, opp: 'GB', home: true }, { wk: 2, bye: true }], GB: [{ wk: 1, opp: 'MIN', home: false }] } };
  const pre = { teams: { MIN: [{ wk: 2, opp: 'BAL', home: true }] } };
  assert.deepEqual(buildSeasonEntry(sched, pre, 'MIN'), { schedule: sched.teams.MIN, preseason: pre.teams.MIN });
});
check('a failed or empty preseason is an empty list, not an error', () => {
  const sched = { teams: { MIN: [{ wk: 1, opp: 'GB', home: true }] } };
  assert.deepEqual(buildSeasonEntry(sched, null, 'MIN').preseason, []);
  assert.deepEqual(buildSeasonEntry(sched, { teams: {} }, 'MIN').preseason, []);
  assert.deepEqual(buildSeasonEntry(null, null, 'MIN'), { schedule: [], preseason: [] });
});

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nall passed');
