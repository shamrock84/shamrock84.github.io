// Unit test for the Scoring tab's per-player stat-breakdown popover
// ("7.4 points for 74 Receiving Yards") — espnStatBreakdown and
// sleeperStatBreakdown in scripts/lib/providers.mjs, exercised through the
// public fetchEspnScoring/fetchSleeperScoring functions the same way
// test-espn-sleeper-live-time.mjs does, rather than exporting the two
// helpers just for a test to reach them directly.
//
// Real shapes confirmed by probe-live-scoring-players.yml RUN 2 (week 1,
// 2026): a real Puka Nacua entry read appliedStats {42: 7.4, 53: 5} against
// raw stats {42: 74, 53: 5}; a real Brock Purdy /stats/nfl/regular/<season>/
// <week> entry carried pass_yd/pass_td/pass_int/rush_yd verbatim. See
// ESPN_STAT_LABELS/SLEEPER_STAT_LABELS' own comments for exactly what is
// confirmed vs community-documented.
process.env.ESPN_S2 = 'test-s2';
process.env.ESPN_SWID = 'test-swid';
const { fetchEspnScoring, fetchSleeperScoring } = await import('./lib/providers.mjs');

import assert from 'node:assert/strict';

function stubFetch(router) {
  globalThis.fetch = async (url) => router(String(url));
}

const okJson = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const clockMap = new Map();

// --- ESPN: a real (statSourceId 0) entry for the CURRENT scoringPeriodId
// breaks down into labeled rows, largest contribution first; a PROJECTED
// (statSourceId 1) entry or a different week's entry is ignored; an
// unlabeled stat id (999, made up) is dropped rather than shown as "Stat
// #999". ---
{
  const espnData = {
    status: { currentMatchupPeriod: 1 },
    teams: [{ id: 1, name: 'Home Team' }],
    schedule: [{
      matchupPeriodId: 1,
      home: {
        teamId: 1,
        totalPoints: 12.4,
        rosterForCurrentScoringPeriod: {
          entries: [{
            lineupSlotId: 3,
            playerPoolEntry: {
              appliedStatTotal: 12.4,
              player: {
                proTeamId: 14,
                fullName: 'Test Receiver',
                defaultPositionId: 3,
                stats: [
                  // A projected entry for the same week — must be ignored;
                  // its appliedStats would otherwise dwarf the real one.
                  { statSourceId: 1, scoringPeriodId: 1, stats: { 42: 999 }, appliedStats: { 42: 99.9 } },
                  // A different week's real entry — must also be ignored.
                  { statSourceId: 0, scoringPeriodId: 2, stats: { 42: 10 }, appliedStats: { 42: 1 } },
                  // THIS week's real entry: 74 receiving yards (id 42, 7.4
                  // pts), 5 receptions (id 53, 5 pts), and an unlabeled made-
                  // up id 999 that must not appear in the result at all.
                  {
                    statSourceId: 0,
                    scoringPeriodId: 1,
                    stats: { 42: 74, 53: 5, 999: 3 },
                    appliedStats: { 42: 7.4, 53: 5, 999: 30 },
                  },
                ],
              },
            },
          }],
        },
      },
    }],
  };
  stubFetch(() => okJson(espnData));
  const league = { id: 'e1', franchiseId: '1' };
  const result = await fetchEspnScoring(league, clockMap);
  const player = result.teams[0].players[0];
  assert.deepEqual(
    player.stats,
    [
      { label: 'Receiving Yards', raw: 74, points: 7.4 },
      { label: 'Receptions', raw: 5, points: 5 },
    ],
    'largest contribution first; the unlabeled id 999 and the projected/other-week entries are all excluded'
  );
}

// --- ESPN: no stats array at all (a shape this project has seen — a player
// with an appliedStatTotal but nothing else) degrades to []. ---
{
  const espnData = {
    status: { currentMatchupPeriod: 1 },
    teams: [{ id: 1, name: 'Home Team' }],
    schedule: [{
      matchupPeriodId: 1,
      home: {
        teamId: 1,
        totalPoints: 0,
        rosterForCurrentScoringPeriod: {
          entries: [{
            lineupSlotId: 3,
            playerPoolEntry: { appliedStatTotal: 0, player: { proTeamId: 14, fullName: 'No Stats Guy', defaultPositionId: 3 } },
          }],
        },
      },
    }],
  };
  stubFetch(() => okJson(espnData));
  const league = { id: 'e2', franchiseId: '1' };
  const result = await fetchEspnScoring(league, clockMap);
  assert.deepEqual(result.teams[0].players[0].stats, []);
}

// --- Sleeper: raw per-category counts x this league's own scoring_settings
// rates, largest contribution first; a category present in the raw stats
// but NOT priced by this league's scoring_settings (rush_yd, worth 0 here)
// contributes nothing; an unlabeled raw key (bonus_fd_qb) is dropped. ---
{
  const playerMap = new Map([['8183', { team: 'SF', name: 'Test QB', position: 'QB' }]]);
  stubFetch((url) => {
    if (url.includes('state/nfl')) return okJson({ week: 1, display_week: 1, season: '2026' });
    if (url.includes('/users')) return okJson([]);
    if (url.includes('/rosters')) return okJson([{ roster_id: 1, owner_id: 'u1' }]);
    if (url.includes('/matchups/1')) return okJson([
      { roster_id: 1, points: 22.1, matchup_id: 1, starters: ['8183'], players: ['8183'], players_points: { 8183: 22.1 } },
    ]);
    if (/\/league\/[^/]+$/.test(url)) {
      return okJson({ scoring_settings: { pass_yd: 0.04, pass_td: 4, pass_int: -1, rush_yd: 0, bonus_fd_qb: 0.5 } });
    }
    throw new Error(`unexpected Sleeper URL: ${url}`);
  });

  const weeklyStats = {
    8183: { pass_yd: 205, pass_td: 3, pass_int: 1, rush_yd: 29, bonus_fd_qb: 13 },
  };
  const league = { id: 's1', franchiseId: '1' };
  const result = await fetchSleeperScoring(league, clockMap, playerMap, undefined, weeklyStats);
  assert.deepEqual(
    result.teams[0].players[0].stats,
    [
      { label: 'Passing Touchdowns', raw: 3, points: 12 },
      { label: 'Passing Yards', raw: 205, points: 8.2 },
      { label: 'Interceptions Thrown', raw: 1, points: -1 },
    ],
    'rush_yd is priced at 0 by this league so it is excluded despite a real raw value; bonus_fd_qb has no label so it is excluded despite being priced'
  );
}

// --- Sleeper: no weeklyStats passed at all (the poll skipped the global
// fetch, or this is a week the endpoint has nothing for) degrades to []
// rather than throwing. ---
{
  const playerMap = new Map([['8183', { team: 'SF', name: 'Test QB', position: 'QB' }]]);
  stubFetch((url) => {
    if (url.includes('state/nfl')) return okJson({ week: 1, display_week: 1 });
    if (url.includes('/users')) return okJson([]);
    if (url.includes('/rosters')) return okJson([{ roster_id: 1, owner_id: 'u1' }]);
    if (url.includes('/matchups/1')) return okJson([
      { roster_id: 1, points: 22.1, matchup_id: 1, starters: ['8183'], players: ['8183'], players_points: { 8183: 22.1 } },
    ]);
    if (/\/league\/[^/]+$/.test(url)) return okJson({ scoring_settings: { pass_yd: 0.04 } });
    throw new Error(`unexpected Sleeper URL: ${url}`);
  });
  const league = { id: 's2', franchiseId: '1' };
  const result = await fetchSleeperScoring(league, clockMap, playerMap);
  assert.deepEqual(result.teams[0].players[0].stats, []);
}

console.log('test-stat-breakdown.mjs OK');
