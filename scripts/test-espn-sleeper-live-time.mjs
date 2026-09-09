// Unit test for fetchNflGameClocks, and the ESPN/Sleeper join it feeds, in
// scripts/lib/providers.mjs.
//
// Neither ESPN's own fantasy API nor Sleeper's exposes anything like MFL's
// franchise-level gameSecondsRemaining — probe-espn-sleeper-live-time.yml
// checked ESPN's mScoreboard/mRoster/mBoxscore/mLiveScoring views and
// Sleeper's matchups/state endpoints and found nothing live-clock-shaped.
// The public, unauthenticated ESPN NFL scoreboard does carry it though
// (real events, real fields — see the probe's captured shapes below), so
// fetchNflGameClocks reads it once and both fetchEspnScoring and
// fetchSleeperScoring join their own rostered starters against it by team
// abbreviation.
//
// espnGet throws unless ESPN_S2/ESPN_SWID are set, and those are read at
// module load time (`const ESPN_S2 = process.env.ESPN_S2`), so this sets
// them before a dynamic import rather than a static one — a static import
// would already have captured undefined by the time this file's body runs.
process.env.ESPN_S2 = 'test-s2';
process.env.ESPN_SWID = 'test-swid';
const { fetchNflGameClocks, fetchEspnScoring, fetchSleeperScoring } = await import('./lib/providers.mjs');

import assert from 'node:assert/strict';

function stubFetch(router) {
  globalThis.fetch = async (url) => router(String(url));
}

const okJson = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

// --- fetchNflGameClocks ---
{
  const scoreboard = {
    events: [
      {
        competitions: [{
          status: { type: { state: 'pre' }, period: 0, clock: 0 },
          competitors: [{ team: { abbreviation: 'SEA' }, homeAway: 'home' }, { team: { abbreviation: 'NE' }, homeAway: 'away' }],
        }],
      },
      {
        // In progress: Q2, 5:00 left in the quarter -> 2 quarters left after
        // this one (Q3, Q4) x 900 + 300 = 2100.
        competitions: [{
          status: { type: { state: 'in' }, period: 2, clock: 300 },
          competitors: [{ team: { abbreviation: 'KC' }, homeAway: 'home' }, { team: { abbreviation: 'BUF' }, homeAway: 'away' }],
        }],
      },
      {
        competitions: [{
          status: { type: { state: 'post' }, period: 4, clock: 0 },
          competitors: [{ team: { abbreviation: 'DAL' }, homeAway: 'home' }, { team: { abbreviation: 'NYG' }, homeAway: 'away' }],
        }],
      },
    ],
  };
  stubFetch((url) => {
    assert.match(url, /site\.api\.espn\.com/);
    return okJson(scoreboard);
  });

  const clocks = await fetchNflGameClocks();
  assert.equal(clocks.get('SEA'), 3600, 'a scheduled-but-not-started game reads as a full 60 minutes');
  assert.equal(clocks.get('NE'), 3600);
  assert.equal(clocks.get('KC'), 2100, 'Q2 with 5:00 left is 2 full quarters plus the 5:00 remaining');
  assert.equal(clocks.get('BUF'), 2100);
  assert.equal(clocks.get('DAL'), 0, 'a finished game has no remaining time');
  assert.equal(clocks.get('NYG'), 0);
  assert.equal(clocks.has('MIA'), false, 'a team with no event this week is simply absent from the map');
}

// --- fetchEspnScoring: join against clockMap, starters only ---
{
  const clockMap = new Map([['SEA', 1800], ['NE', 0], ['KC', 3600]]);

  const rosterEntry = (proTeamId, lineupSlotId, fullName) => ({
    lineupSlotId,
    playerPoolEntry: { player: { proTeamId, fullName } },
  });

  const espnData = {
    status: { currentMatchupPeriod: 1 },
    teams: [{ id: 1, name: 'Home Team' }, { id: 2, name: 'Away Team' }],
    schedule: [{
      matchupPeriodId: 1,
      home: {
        teamId: 1,
        totalPoints: 20,
        rosterForCurrentScoringPeriod: {
          entries: [
            rosterEntry(26, 3, 'Seattle Starter'), // SEA starter (proTeamId 26 = SEA)
            rosterEntry(17, 3, 'Patriot Starter'), // NE starter, but NE's game is over (0 left)
            rosterEntry(12, 20, 'Bench Guy'), // KC on the BENCH — must not count
          ],
        },
      },
      away: {
        teamId: 2,
        totalPoints: 15,
        rosterForCurrentScoringPeriod: {
          entries: [
            rosterEntry(12, 3, 'Chief Starter'), // KC starter, full game left
          ],
        },
      },
    }],
  };

  stubFetch((url) => {
    assert.match(url, /fantasy\.espn\.com|lm-api-reads/);
    return okJson(espnData);
  });

  const league = { id: 'e1', franchiseId: '1' };
  const result = await fetchEspnScoring(league, clockMap);

  const home = result.teams.find((t) => t.franchiseId === '1');
  const away = result.teams.find((t) => t.franchiseId === '2');
  assert.equal(home.minutesRemaining, 30, 'SEA (1800s) + NE (0s) = 1800s = 30 minutes; the benched KC entry is excluded');
  assert.equal(away.minutesRemaining, 60, 'KC alone, full 3600s = 60 minutes');
  assert.equal(home.winProb + away.winProb, 100);
  assert.equal(result.matchups.length, 1);
  assert.deepEqual(
    home.players,
    [{ name: 'Seattle Starter', secondsRemaining: 1800 }, { name: 'Patriot Starter', secondsRemaining: 0 }],
    'the benched entry is excluded from the per-player breakdown too, by name since ESPN has no id FantasyPros joins against'
  );
  assert.deepEqual(away.players, [{ name: 'Chief Starter', secondsRemaining: 3600 }]);
}

// --- fetchSleeperScoring: join against clockMap via playerMap, starters only ---
{
  const clockMap = new Map([['DAL', 900], ['PHI', 3600]]);
  const playerMap = new Map([
    ['100', { team: 'DAL', name: 'Cowboy Starter' }],
    ['101', { team: 'PHI', name: 'Eagle Starter' }],
    ['102', { team: 'DAL', name: 'Cowboy Bench' }], // rostered but not a starter
  ]);

  stubFetch((url) => {
    if (url.includes('state/nfl')) return okJson({ week: 1, display_week: 1 });
    if (url.includes('/users')) return okJson([]);
    if (url.includes('/rosters')) return okJson([
      { roster_id: 1, owner_id: 'u1' },
      { roster_id: 2, owner_id: 'u2' },
    ]);
    if (url.includes('/matchups/1')) return okJson([
      { roster_id: 1, points: 10, matchup_id: 1, starters: ['100'], players: ['100', '102'] },
      { roster_id: 2, points: 8, matchup_id: 1, starters: ['101'], players: ['101'] },
    ]);
    throw new Error(`unexpected Sleeper URL: ${url}`);
  });

  const league = { id: 's1', franchiseId: '1' };
  const result = await fetchSleeperScoring(league, clockMap, playerMap);

  const home = result.teams.find((t) => t.franchiseId === '1');
  const away = result.teams.find((t) => t.franchiseId === '2');
  assert.equal(home.minutesRemaining, 15, 'DAL starter only (900s = 15 min); the non-started DAL player is excluded');
  assert.equal(away.minutesRemaining, 60, 'PHI starter, full 3600s = 60 minutes');
  assert.equal(home.winProb + away.winProb, 100);
  assert.deepEqual(
    home.players,
    [{ name: 'Cowboy Starter', secondsRemaining: 900 }],
    'only the roster\'s own `starters` list feeds the per-player breakdown, same as minutesRemaining'
  );
  assert.deepEqual(away.players, [{ name: 'Eagle Starter', secondsRemaining: 3600 }]);
}

console.log('test-espn-sleeper-live-time.mjs OK');
