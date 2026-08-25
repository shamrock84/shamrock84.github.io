// Unit test for parseMflWeekScores in scripts/lib/providers.mjs.
//
// Real bug, caught by the user spot-checking MNMx's 2021 season against MFL
// directly: a franchise with no active head-to-head game in a given week
// (a bye, an eliminated team, anything past its own bracket's final) does
// not appear inside weeklyResults.matchup at all — MFL puts it as a flat
// entry directly under weeklyResults.franchise instead, sibling to matchup
// rather than nested in it, still carrying a completely real score. The
// original fetchMflWeekScores only ever read matchup, so that franchise's
// week vanished from computeSeasonScoringRecords entirely. Confirmed
// against real data via probe-weekly-scores.yml (league 26696, 2021, week
// 15): six of ten franchises that week were flat entries, and one of them
// (142.5) was the true weekly high — the matchup-only computation crowned a
// 90.3 score instead.

import assert from 'node:assert/strict';
import { parseMflWeekScores } from './lib/providers.mjs';

function starter(score) {
  return { status: 'starter', score: String(score) };
}

{
  // The exact shape confirmed for MNMx 2021 week 15: six franchises with no
  // active game (flat), four still playing (two matchups of two).
  const data = {
    weeklyResults: {
      week: '15',
      franchise: [
        { id: '0001', score: '139.3', player: [starter(139.3)] },
        { id: '0002', score: '110.8', player: [starter(110.8)] },
        { id: '0005', score: '142.5', player: [starter(142.5)] },
        { id: '0006', score: '126.5', player: [starter(126.5)] },
        { id: '0009', score: '128.9', player: [starter(128.9)] },
        { id: '0010', score: '75.7', player: [starter(75.7)] },
      ],
      matchup: [
        { franchise: [
          { id: '0003', score: '87', player: [starter(87)] },
          { id: '0007', score: '47', player: [starter(47)] },
        ] },
        { franchise: [
          { id: '0004', score: '80.5', player: [starter(80.5)] },
          { id: '0008', score: '90.3', player: [starter(90.3)] },
        ] },
      ],
    },
  };

  const totals = parseMflWeekScores(data);
  assert.equal(totals.length, 10, 'all ten franchises are present, flat and matchup combined');
  const byId = Object.fromEntries(totals.map((t) => [t.franchiseId, t.points]));
  assert.equal(byId['0005'], 142.5, 'the true weekly high is a FLAT entry, not a matchup one');
  assert.equal(byId['0008'], 90.3, 'the matchup entries are still read correctly');
  const highest = totals.reduce((b, t) => (!b || t.points > b.points ? t : b), null);
  assert.equal(highest.franchiseId, '0005', 'the real weekly-high winner is a bye/eliminated team, invisible to the old matchup-only read');
}

{
  // A week with no bye/elimination gaps at all — every franchise is inside
  // a real matchup, the ordinary case, unaffected by this fix.
  const data = {
    weeklyResults: {
      matchup: [
        { franchise: [
          { id: 'A', player: [starter(100)] },
          { id: 'B', player: [starter(90)] },
        ] },
      ],
    },
  };
  const totals = parseMflWeekScores(data);
  assert.deepEqual(
    totals.map((t) => [t.franchiseId, t.points]).sort(),
    [['A', 100], ['B', 90]]
  );
}

{
  // A week where every franchise is a bye/no-game entry (weeklyResults.
  // matchup absent entirely) — still read correctly, not silently empty.
  const data = {
    weeklyResults: {
      franchise: [
        { id: 'A', player: [starter(50)] },
        { id: 'B', player: [starter(60)] },
      ],
    },
  };
  const totals = parseMflWeekScores(data);
  assert.deepEqual(
    totals.map((t) => [t.franchiseId, t.points]).sort(),
    [['A', 50], ['B', 60]]
  );
}

{
  // Only nonstarters score doesn't count — same rule fetchMflWeekScores
  // always applied, unaffected by this fix, checked on a flat entry too.
  const data = {
    weeklyResults: {
      franchise: [
        { id: 'A', player: [starter(50), { status: 'nonstarter', score: '999' }] },
      ],
    },
  };
  const totals = parseMflWeekScores(data);
  assert.equal(totals[0].points, 50, 'a bench player\'s score never counts, flat entry or not');
}

{
  // Neither shape present at all — degrades to an empty list, not a crash.
  assert.deepEqual(parseMflWeekScores({}), []);
  assert.deepEqual(parseMflWeekScores({ weeklyResults: {} }), []);
}

console.log('test-weekly-scores: all assertions passed');
