// Unit test for the weekly/season high-score derivation —
// scripts/lib/history.mjs's computeSeasonScoringRecords, and
// fetch-rosters.mjs's yearsNeedingScoringBackfill.

import assert from 'node:assert/strict';
import { computeSeasonScoringRecords } from './lib/history.mjs';
import { yearsNeedingScoringBackfill } from './fetch-rosters.mjs';

// ---- computeSeasonScoringRecords --------------------------------------------

{
  // Three weeks, two franchises. weeklyHighs is one entry PER WEEK, not a
  // single season record: week 1 and week 3 are won by B, week 2 by A —
  // three separate awards, not one. Season-total is still a single record:
  // B's season sum (100+140+130=370) beats A's (120+150+90=360).
  const weeklyScoresByWeek = new Map([
    [1, [{ franchiseId: 'A', points: 120 }, { franchiseId: 'B', points: 130 }]],
    [2, [{ franchiseId: 'A', points: 150 }, { franchiseId: 'B', points: 140 }]],
    [3, [{ franchiseId: 'A', points: 90 }, { franchiseId: 'B', points: 100 }]],
  ]);
  const nameById = new Map([['A', 'Team A'], ['B', 'Team B']]);
  const { weeklyHighs, seasonHigh } = computeSeasonScoringRecords(weeklyScoresByWeek, nameById);
  assert.deepEqual(weeklyHighs, [
    { franchiseId: 'B', week: 1, points: 130, teamName: 'Team B' },
    { franchiseId: 'A', week: 2, points: 150, teamName: 'Team A' },
    { franchiseId: 'B', week: 3, points: 100, teamName: 'Team B' },
  ], 'one weekly-high winner per week, in week order, not a single season-best record');
  assert.deepEqual(seasonHigh, { franchiseId: 'B', points: 370, teamName: 'Team B' });
}

{
  // No weeks at all — never a guess, just nothing to report.
  const { weeklyHighs, seasonHigh } = computeSeasonScoringRecords(new Map(), new Map());
  assert.deepEqual(weeklyHighs, []);
  assert.equal(seasonHigh, null);
}

{
  // A tie keeps whichever franchise the provider listed first that week —
  // arbitrary but deterministic, same convention as pickMainBracket's tie
  // handling in history.mjs.
  const weeklyScoresByWeek = new Map([
    [1, [{ franchiseId: 'A', points: 100 }, { franchiseId: 'B', points: 100 }]],
  ]);
  const { weeklyHighs } = computeSeasonScoringRecords(weeklyScoresByWeek, new Map());
  assert.equal(weeklyHighs[0].franchiseId, 'A', 'strict > keeps the first franchise seen on a tie');
}

{
  // A franchise id with no name in the map falls back to the id itself,
  // same missing-value convention used throughout this codebase.
  const weeklyScoresByWeek = new Map([[1, [{ franchiseId: 'Z', points: 50 }]]]);
  const { weeklyHighs, seasonHigh } = computeSeasonScoringRecords(weeklyScoresByWeek, new Map());
  assert.equal(weeklyHighs[0].teamName, 'Z');
  assert.equal(seasonHigh.teamName, 'Z');
}

{
  // The SAME franchise can win multiple weekly-highs in one season — this is
  // the normal case, not an edge case, since the award is per-week.
  const weeklyScoresByWeek = new Map([
    [1, [{ franchiseId: 'A', points: 150 }, { franchiseId: 'B', points: 100 }]],
    [2, [{ franchiseId: 'A', points: 160 }, { franchiseId: 'B', points: 110 }]],
  ]);
  const nameById = new Map([['A', 'Team A']]);
  const { weeklyHighs } = computeSeasonScoringRecords(weeklyScoresByWeek, nameById);
  assert.equal(weeklyHighs.length, 2);
  assert.ok(weeklyHighs.every((w) => w.franchiseId === 'A'), 'the same franchise can appear more than once');
}

{
  // A weekly-high award can land on week 18; a season-total award never
  // counts it. Franchise A's week-18 score (300) wins that week's award
  // outright, but week 18 must not be added into any season sum — B's
  // weeks-1-17 total (100+140=240) beats A's (120+90=210) even though A's
  // raw 18-week sum (120+90+300=510) would otherwise blow B away.
  const weeklyScoresByWeek = new Map([
    [1, [{ franchiseId: 'A', points: 120 }, { franchiseId: 'B', points: 100 }]],
    [17, [{ franchiseId: 'A', points: 90 }, { franchiseId: 'B', points: 140 }]],
    [18, [{ franchiseId: 'A', points: 300 }, { franchiseId: 'B', points: 10 }]],
  ]);
  const nameById = new Map([['A', 'Team A'], ['B', 'Team B']]);
  const { weeklyHighs, seasonHigh } = computeSeasonScoringRecords(weeklyScoresByWeek, nameById, 17);
  const week18 = weeklyHighs.find((w) => w.week === 18);
  assert.deepEqual(week18, { franchiseId: 'A', week: 18, points: 300, teamName: 'Team A' }, 'week 18 has its own weekly-high winner');
  assert.deepEqual(seasonHigh, { franchiseId: 'B', points: 240, teamName: 'Team B' }, 'week 18 never counts toward the season sum');
}

// ---- yearsNeedingScoringBackfill ---------------------------------------------

{
  // Only years with a results[] entry AND no `scoring` field yet are
  // candidates — unlike yearsNeedingHistoryBackfill, there is no
  // "guessed and eligible for retry" concept, since nothing here is ever a
  // guess: once `scoring` is recorded, that year is simply done.
  const results = [
    { year: '2022', rank: 3, total: 10, guessed: false, scoring: { weeklyHighs: [], seasonHigh: null } },
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
