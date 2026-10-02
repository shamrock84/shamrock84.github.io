// Unit test for the weekly results push (api/lib/weeklyresults.mjs and the
// guards in api/weekly-results.js). The failure that matters is a summary that
// reads complete and isn't, so this pins: the finished week comes off the
// calendar and only on Tuesday/Wednesday; a bye or an unscored week is "no
// game", never a loss or a tie; an unreadable league is listed, never silently
// dropped or counted; and long reports split under Pushover's 1024-char cap.

import assert from 'node:assert/strict';
import {
  finishedWeek,
  mflWeekMatchups,
  espnWeekMatchups,
  sleeperWeekMatchups,
  myResult,
  summarize,
  buildMessages,
  PUSHOVER_BODY_LIMIT,
} from '../api/lib/weeklyresults.mjs';
import { nflKickoffUtc } from '../scripts/lib/fantasypros.mjs';
import handler from '../api/weekly-results.js';

// 2026 kickoff: Thursday Sept 10 (Labor Day is Sept 7).
const kickoff = nflKickoffUtc(2026);
assert.equal(new Date(kickoff).toISOString(), '2026-09-10T00:00:00.000Z');
assert.equal(finishedWeek(new Date('2026-09-15T14:00:00Z'), kickoff), 1, 'Tuesday after week 1');
assert.equal(finishedWeek(new Date('2026-09-16T14:00:00Z'), kickoff), 1, 'Wednesday still week 1');
assert.equal(finishedWeek(new Date('2026-10-06T14:00:00Z'), kickoff), 4, 'Tuesday after week 4');
assert.equal(finishedWeek(new Date('2026-09-20T14:00:00Z'), kickoff), null, 'Sunday: week in progress');
assert.equal(finishedWeek(new Date('2026-09-17T14:00:00Z'), kickoff), null, 'Thursday: new week');
assert.equal(finishedWeek(new Date('2026-09-01T14:00:00Z'), kickoff), null, 'before kickoff');

// MFL: starters summed; flat franchise entry = no game.
const mfl = mflWeekMatchups({
  weeklyResults: {
    matchup: [{ franchise: [
      { id: '0001', player: [{ status: 'starter', score: '100.5' }, { status: 'starter', score: '20' }, { status: 'nonstarter', score: '99' }] },
      { id: '0002', player: [{ status: 'starter', score: '90' }] },
    ] }],
    franchise: [{ id: '0003', player: [{ status: 'starter', score: '150' }] }],
  },
});
assert.deepEqual(myResult(mfl, '0001'), { result: 'W', points: 120.5, oppPoints: 90 });
assert.deepEqual(myResult(mfl, '0002'), { result: 'L', points: 90, oppPoints: 120.5 });
assert.equal(myResult(mfl, '0003'), null, 'flat entry has no opponent: no game');
assert.equal(myResult(mfl, '0009'), null);

// Single-object shapes (MFL's lone-element quirk).
const lone = mflWeekMatchups({ weeklyResults: { matchup: { franchise: [{ id: 'a', player: { status: 'starter', score: '5' } }, { id: 'b', player: { status: 'starter', score: '5' } }] } } });
assert.equal(myResult(lone, 'a').result, 'T');

// ESPN: filtered to the week; a bye has one side.
const espn = espnWeekMatchups({ schedule: [
  { matchupPeriodId: 4, home: { teamId: 1, totalPoints: 80 }, away: { teamId: 2, totalPoints: 95.2 } },
  { matchupPeriodId: 4, home: { teamId: 3, totalPoints: 60 } },
  { matchupPeriodId: 5, home: { teamId: 1, totalPoints: 0 }, away: { teamId: 2, totalPoints: 0 } },
] }, 4);
assert.equal(myResult(espn, 1).result, 'L');
assert.equal(myResult(espn, 3), null, 'bye');

// Sleeper: grouped by matchup_id.
const sl = sleeperWeekMatchups([
  { roster_id: 1, matchup_id: 1, points: 110 },
  { roster_id: 2, matchup_id: 1, points: 100 },
  { roster_id: 3, matchup_id: null, points: 70 },
]);
assert.equal(myResult(sl, 1).result, 'W');
assert.equal(myResult(sl, 3), null);

// An unscored 0-0 pairing is "not scored yet", never a tie.
assert.equal(myResult(sleeperWeekMatchups([{ roster_id: 1, matchup_id: 1, points: 0 }, { roster_id: 2, matchup_id: 1, points: 0 }]), 1), null);

// Summary: unreadable and no-game leagues stay out of the overall record.
const entries = [
  { name: 'MNMx', team: 'Rumble Fish', result: { result: 'W', points: 132.44 }, record: { wins: 3, losses: 1, ties: 0 } },
  { name: 'Dynasty B', team: 'Foo', result: { result: 'L', points: 98.05 }, record: { wins: 1, losses: 3, ties: 1 } },
  { name: 'Bye League', team: 'Baz', result: null, record: { wins: 2, losses: 2, ties: 0 } },
  { name: 'Broken', team: 'Bar', error: '429' },
  { name: 'Tied', team: 'T', result: { result: 'T', points: 100 }, record: { wins: 0, losses: 0, ties: 1 } },
];
const { overall, lines } = summarize(entries);
assert.deepEqual(overall, { wins: 1, losses: 1, ties: 1 });
assert.equal(lines[0], 'W MNMx – Rumble Fish · 132.44 · 3-1');
assert.equal(lines[1], 'L Dynasty B – Foo · 98.05 · 1-3-1');
assert.equal(lines[2], '– Bye League – Baz: no game · 2-2');
assert.match(lines[3], /^⚠ Broken – Bar: couldn't read \(429\)$/);
assert.equal(buildMessages(4, entries)[0].title, 'Week 4: 1-1-1 overall');

// Splitting: every body under the cap, every line preserved once, in order.
const many = Array.from({ length: 40 }, (_, i) => ({ name: `League number ${i}`, team: 'A Fairly Long Team Name', result: { result: 'W', points: 100 + i }, record: { wins: i, losses: 0, ties: 0 } }));
const msgs = buildMessages(7, many);
assert.ok(msgs.length > 1);
assert.ok(msgs.every((m) => m.body.length <= PUSHOVER_BODY_LIMIT));
assert.equal(msgs.map((m) => m.body).join('\n').split('\n').length, 40);
assert.equal(msgs[1].title, `Week 7: 40-0 overall (2/${msgs.length})`);

// Handler guards.
function call(query, headers = {}) {
  return new Promise((resolve) => {
    const res = { status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); } };
    handler({ query, headers }, res);
  });
}
delete process.env.GAMETIME_CHECK_SECRET;
assert.equal((await call({})).code, 500);
process.env.GAMETIME_CHECK_SECRET = 's';
process.env.PUSHOVER_APP_TOKEN = 't';
process.env.PUSHOVER_USER_KEY = 'u';
assert.equal((await call({ key: 'wrong' })).code, 401);
assert.equal((await call({ key: 's', week: '99' })).body.sent, false);

console.log('weekly results: ok');
