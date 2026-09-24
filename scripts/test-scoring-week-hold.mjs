// Unit test for the `weekStarted` hold-on-the-previous-week behavior in
// fetchEspnScoring/fetchSleeperScoring (scripts/lib/providers.mjs), added
// 2026-09-24 once probe-espn-sleeper-past-period.yml confirmed both
// providers answer cleanly for an explicit past scoring period — see
// fetchEspnScoring's own comment for the full history and why this no
// longer needs a cache (the original blocker this test's predecessor,
// test-espn-sleeper-live-time.mjs, left declined).
process.env.ESPN_S2 = 'test-s2';
process.env.ESPN_SWID = 'test-swid';
const { fetchEspnScoring, fetchSleeperScoring, nflWeekHasStarted } = await import('./lib/providers.mjs');

import assert from 'node:assert/strict';

function stubFetch(router) {
  globalThis.fetch = async (url) => router(String(url));
}

const okJson = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

// --- nflWeekHasStarted ---
{
  const pre = new Map([['SEA', { state: 'pre' }], ['NE', { state: 'pre' }]]);
  assert.equal(nflWeekHasStarted(pre), false, 'every game still pregame reads as not started');
  assert.equal(nflWeekHasStarted(new Map()), false, 'an empty map (a failed/thin scoreboard read) reads as not started, never throws');

  const oneLive = new Map([['SEA', { state: 'pre' }], ['NE', { state: 'in' }]]);
  assert.equal(nflWeekHasStarted(oneLive), true, 'one game live is enough');

  const onePost = new Map([['SEA', { state: 'post' }]]);
  assert.equal(nflWeekHasStarted(onePost), true, 'a finished game still counts as started');
}

// --- fetchEspnScoring: weekStarted=false holds the previous period ---
{
  const rosterEntry = (proTeamId, lineupSlotId, fullName, appliedStatTotal, defaultPositionId) => ({
    lineupSlotId,
    playerPoolEntry: {
      ...(appliedStatTotal === undefined ? {} : { appliedStatTotal }),
      player: { proTeamId, fullName, defaultPositionId },
    },
  });

  const currentData = {
    status: { currentMatchupPeriod: 3 },
    teams: [{ id: 1, name: 'Home Team' }, { id: 2, name: 'Away Team' }],
    schedule: [{
      matchupPeriodId: 3,
      home: { teamId: 1, totalPointsLive: 0, rosterForCurrentScoringPeriod: { entries: [] } },
      away: { teamId: 2, totalPointsLive: 0, rosterForCurrentScoringPeriod: { entries: [] } },
    }],
  };
  const pastData = {
    status: { currentMatchupPeriod: 3 },
    teams: [{ id: 1, name: 'Home Team' }, { id: 2, name: 'Away Team' }],
    schedule: [{
      matchupPeriodId: 2,
      home: {
        teamId: 1,
        // No totalPointsLive at all here — the real shape
        // probe-espn-sleeper-past-period.yml found for a past period, which
        // is exactly why the held branch must read totalPoints instead.
        totalPoints: 87.22,
        rosterForCurrentScoringPeriod: {
          entries: [
            rosterEntry(26, 3, 'Seattle Starter', 20.5, 3), // starter, WR
            rosterEntry(12, 20, 'Bench Guy', 99, 3), // benched — must not count
          ],
        },
      },
      away: {
        teamId: 2,
        totalPoints: 91.26,
        rosterForCurrentScoringPeriod: {
          entries: [rosterEntry(17, 3, 'Patriot Starter', 15.75, 4)], // starter, TE
        },
      },
    }],
  };

  stubFetch((url) => {
    assert.match(url, /fantasy\.espn\.com|lm-api-reads/);
    return url.includes('scoringPeriodId=2') ? okJson(pastData) : okJson(currentData);
  });

  // This week's real clocks — must NOT leak into the held (last week's,
  // long-over) matchup's minutesRemaining.
  const clockMap = new Map([['SEA', 1800], ['NE', 3600]]);
  const league = { id: 'e1', franchiseId: '1' };
  const result = await fetchEspnScoring(league, clockMap, undefined, false);

  assert.equal(result.week, 2, 'reports the HELD week, not the new (0-0) current one');
  const home = result.teams.find((t) => t.franchiseId === '1');
  const away = result.teams.find((t) => t.franchiseId === '2');
  assert.equal(home.score, '87.22', 'reads totalPoints (the only field a past period actually carries), not totalPointsLive');
  assert.equal(away.score, '91.26');
  assert.equal(home.minutesRemaining, 0, 'a held (finished) week never borrows this week\'s live clocks');
  assert.equal(away.minutesRemaining, 0);
  assert.equal(home.winProb + away.winProb, 100, 'a 0-minutes-remaining matchup still resolves to a decisive win prob, same as a genuinely finished current week');
  assert.deepEqual(
    home.players,
    [{ name: 'Seattle Starter', secondsRemaining: 0, position: 'WR', team: 'SEA', points: 20.5, stats: [] }],
    'the benched entry is excluded, same as the live path'
  );
  assert.deepEqual(
    home.bench,
    [{ name: 'Bench Guy', secondsRemaining: 0, position: 'WR', team: 'KC', points: 99, stats: [] }]
  );
}

// --- fetchEspnScoring: weekStarted=false is a no-op on week 1 (nothing to hold) ---
{
  const data = {
    status: { currentMatchupPeriod: 1 },
    teams: [{ id: 1, name: 'Home' }],
    schedule: [{ matchupPeriodId: 1, home: { teamId: 1, totalPointsLive: 5, rosterForCurrentScoringPeriod: { entries: [] } } }],
  };
  stubFetch(() => okJson(data));
  const league = { id: 'e2', franchiseId: '1' };
  const result = await fetchEspnScoring(league, new Map(), undefined, false);
  assert.equal(result.week, 1, 'week 1 has no predecessor to hold, so it reports the current period as usual');
}

// --- fetchSleeperScoring: weekStarted=false holds the previous week ---
{
  const clockMap = new Map([['DAL', 900]]); // this week's real clock — must not leak in
  const playerMap = new Map([
    ['100', { team: 'DAL', name: 'Cowboy Starter', position: 'RB' }],
    ['101', { team: 'PHI', name: 'Eagle Starter', position: 'QB' }],
  ]);

  stubFetch((url) => {
    if (url.includes('state/nfl')) return okJson({ week: 3, display_week: 3 });
    if (url.includes('/users')) return okJson([]);
    if (url.includes('/rosters')) return okJson([{ roster_id: 1, owner_id: 'u1' }, { roster_id: 2, owner_id: 'u2' }]);
    // The CURRENT week's matchups — must never be read once held.
    if (url.includes('/matchups/3')) throw new Error('must not fetch the current week while holding the previous one');
    // The HELD (previous) week — real final numbers, same shape
    // probe-espn-sleeper-past-period.yml confirmed live.
    if (url.includes('/matchups/2')) return okJson([
      { roster_id: 1, points: 145.6, matchup_id: 1, starters: ['100'], players: ['100'], players_points: { 100: 145.6 } },
      { roster_id: 2, points: 132.1, matchup_id: 1, starters: ['101'], players: ['101'], players_points: { 101: 132.1 } },
    ]);
    if (/\/league\/[^/]+$/.test(url)) return okJson({});
    throw new Error(`unexpected Sleeper URL: ${url}`);
  });

  const league = { id: 's1', franchiseId: '1' };
  const result = await fetchSleeperScoring(league, clockMap, playerMap, undefined, undefined, false);

  assert.equal(result.week, 2, 'reports the HELD week, not the new (0-0) current one');
  const home = result.teams.find((t) => t.franchiseId === '1');
  const away = result.teams.find((t) => t.franchiseId === '2');
  assert.equal(home.score, '145.60', 'Sleeper\'s own m.points already carries the real final number for a held week — no field swap needed, unlike ESPN');
  assert.equal(away.score, '132.10');
  assert.equal(home.minutesRemaining, 0, 'a held (finished) week never borrows this week\'s live clocks');
  assert.equal(away.minutesRemaining, 0);
}

console.log('test-scoring-week-hold.mjs OK');
