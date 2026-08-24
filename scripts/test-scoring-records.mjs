// Unit test for the weekly/season high-score derivation —
// scripts/lib/history.mjs's computeSeasonScoringRecords, and
// fetch-rosters.mjs's yearsNeedingScoringBackfill.

import assert from 'node:assert/strict';
import { computeSeasonScoringRecords } from './lib/history.mjs';
import { yearsNeedingScoringBackfill } from './fetch-rosters.mjs';

// ---- computeSeasonScoringRecords --------------------------------------------

{
  // Three weeks, two franchises. Franchise A's week-2 score (150) is the
  // season's highest single week; franchise B's season sum (100+140+130=370)
  // beats A's (120+150+90=360) for the season-total high.
  const weeklyScoresByWeek = new Map([
    [1, [{ franchiseId: 'A', points: 120 }, { franchiseId: 'B', points: 100 }]],
    [2, [{ franchiseId: 'A', points: 150 }, { franchiseId: 'B', points: 140 }]],
    [3, [{ franchiseId: 'A', points: 90 }, { franchiseId: 'B', points: 130 }]],
  ]);
  const nameById = new Map([['A', 'Team A'], ['B', 'Team B']]);
  const { weeklyHigh, seasonHigh } = computeSeasonScoringRecords(weeklyScoresByWeek, nameById);
  assert.deepEqual(weeklyHigh, { franchiseId: 'A', week: 2, points: 150, teamName: 'Team A' });
  assert.deepEqual(seasonHigh, { franchiseId: 'B', points: 370, teamName: 'Team B' });
}

{
  // No weeks at all — never a guess, just nothing to report.
  const { weeklyHigh, seasonHigh } = computeSeasonScoringRecords(new Map(), new Map());
  assert.equal(weeklyHigh, null);
  assert.equal(seasonHigh, null);
}

{
  // A tie keeps whichever franchise the provider listed first that week —
  // arbitrary but deterministic, same convention as pickMainBracket's tie
  // handling in history.mjs.
  const weeklyScoresByWeek = new Map([
    [1, [{ franchiseId: 'A', points: 100 }, { franchiseId: 'B', points: 100 }]],
  ]);
  const { weeklyHigh } = computeSeasonScoringRecords(weeklyScoresByWeek, new Map());
  assert.equal(weeklyHigh.franchiseId, 'A', 'strict > keeps the first franchise seen on a tie');
}

{
  // A franchise id with no name in the map falls back to the id itself,
  // same missing-value convention used throughout this codebase.
  const weeklyScoresByWeek = new Map([[1, [{ franchiseId: 'Z', points: 50 }]]]);
  const { weeklyHigh, seasonHigh } = computeSeasonScoringRecords(weeklyScoresByWeek, new Map());
  assert.equal(weeklyHigh.teamName, 'Z');
  assert.equal(seasonHigh.teamName, 'Z');
}

{
  // A weekly-high award can land on week 18; a season-total award never
  // counts it. Franchise A's week-18 score (300) is the season's highest
  // single week by far, but week 18 must not be added into any season sum —
  // B's weeks-1-17 total (100+140=240) beats A's (120+90=210) even though
  // A's raw 18-week sum (120+90+300=510) would otherwise blow B away.
  const weeklyScoresByWeek = new Map([
    [1, [{ franchiseId: 'A', points: 120 }, { franchiseId: 'B', points: 100 }]],
    [17, [{ franchiseId: 'A', points: 90 }, { franchiseId: 'B', points: 140 }]],
    [18, [{ franchiseId: 'A', points: 300 }, { franchiseId: 'B', points: 10 }]],
  ]);
  const nameById = new Map([['A', 'Team A'], ['B', 'Team B']]);
  const { weeklyHigh, seasonHigh } = computeSeasonScoringRecords(weeklyScoresByWeek, nameById, 17);
  assert.deepEqual(weeklyHigh, { franchiseId: 'A', week: 18, points: 300, teamName: 'Team A' }, 'week 18 can win weekly-high');
  assert.deepEqual(seasonHigh, { franchiseId: 'B', points: 240, teamName: 'Team B' }, 'week 18 never counts toward the season sum');
}

// ---- yearsNeedingScoringBackfill ---------------------------------------------

{
  // Only years with a results[] entry AND no `scoring` field yet are
  // candidates — unlike yearsNeedingHistoryBackfill, there is no
  // "guessed and eligible for retry" concept, since nothing here is ever a
  // guess: once `scoring` is recorded, that year is simply done.
  const results = [
    { year: '2022', rank: 3, total: 10, guessed: false, scoring: { weeklyHigh: null, seasonHigh: null } },
    { year: '2023', rank: 1, total: 10, guessed: true }, // no scoring yet, even though placement is a guess
    { year: '2021', rank: 5, total: 10, guessed: false }, // no scoring yet
  ];
  const missing = yearsNeedingScoringBackfill(results);
  assert.deepEqual(missing, ['2023', '2021'], 'most-recent-first, only years missing `scoring`');
}

{
  assert.deepEqual(yearsNeedingScoringBackfill([]), []);
  assert.deepEqual(yearsNeedingScoringBackfill(undefined), [], 'degrades like an empty array, not a crash');
}

console.log('test-scoring-records: all assertions passed');
