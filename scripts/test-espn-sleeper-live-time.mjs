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
const { fetchNflGameClocks, fetchNflGames, gameClocksFromGames, fetchEspnScoring, fetchSleeperScoring } = await import('./lib/providers.mjs');

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

  // fetchNflGameClocks is now a projection of fetchNflGames (one request,
  // two views), so the same scoreboard must produce identical clocks either
  // way — the win-probability model must not notice this refactor.
  const games = await fetchNflGames();
  assert.deepEqual(
    [...gameClocksFromGames(games).entries()].sort(),
    [...clocks.entries()].sort(),
    'the projected clocks match what fetchNflGameClocks returns'
  );
}

// --- fetchNflGames: the schedule half, for the Scoring drawer's game line ---
{
  const scoreboard = {
    events: [
      {
        competitions: [{
          date: '2026-09-13T17:00:00Z',
          status: { type: { state: 'pre', shortDetail: 'Sun 1:00 PM ET' }, period: 0, clock: 0 },
          competitors: [
            { team: { abbreviation: 'TB' }, homeAway: 'away' },
            { team: { abbreviation: 'CIN' }, homeAway: 'home' },
          ],
        }],
      },
      {
        competitions: [{
          date: '2026-09-13T20:05:00Z',
          // The real shape probe-live-scoring-players.yml captured off a live
          // game — "4:35 - 1st", not the "Q3 5:22" this was first written
          // against. Used verbatim by fetchNflGames, so the fixture matching
          // reality is the whole point.
          status: { type: { state: 'in', shortDetail: '4:35 - 1st' }, period: 3, clock: 322 },
          competitors: [
            { team: { abbreviation: 'LV' }, homeAway: 'away' },
            { team: { abbreviation: 'DEN' }, homeAway: 'home' },
          ],
        }],
      },
      {
        // No competitions[].date — the fallback to the event's own date.
        date: '2026-09-14T00:20:00Z',
        competitions: [{
          status: { type: { state: 'post', shortDetail: 'Final' }, period: 4, clock: 0 },
          competitors: [
            { team: { abbreviation: 'WSH' }, homeAway: 'home' },
            { team: { abbreviation: 'JAX' }, homeAway: 'away' },
          ],
        }],
      },
    ],
  };
  stubFetch(() => okJson(scoreboard));
  const games = await fetchNflGames();

  // Opponent and home/away, which is what the "@" in "@PIT" comes from.
  assert.equal(games.get('CIN').opponent, 'TB');
  assert.equal(games.get('CIN').isHome, true);
  assert.equal(games.get('TB').opponent, 'CIN');
  assert.equal(games.get('TB').isHome, false);

  // The kickoff crosses the wire as the raw ISO string — never formatted
  // here, since this runs in UTC on Vercel and the reader is not.
  assert.equal(games.get('CIN').kickoff, '2026-09-13T17:00:00Z');
  assert.equal(games.get('WSH').kickoff, '2026-09-14T00:20:00Z', "falls back to the event's own date");

  // State and the scoreboard's own status wording, used verbatim.
  assert.equal(games.get('CIN').state, 'pre');
  assert.equal(games.get('LV').state, 'in');
  assert.equal(games.get('LV').detail, '4:35 - 1st');
  assert.equal(games.get('WSH').detail, 'Final');
  // Clocks still ride along on the same entries.
  assert.equal(games.get('LV').secondsRemaining, 1222, 'Q3 with 5:22 left is one full quarter plus 322s');
  assert.equal(games.get('CIN').secondsRemaining, 3600);
  assert.equal(games.get('WSH').secondsRemaining, 0);

  // THE assertion this whole alias mechanism exists for. Three providers
  // spell the same team three ways; MFL pads to three letters. A map keyed
  // only as the scoreboard published it would give no game line to every
  // player on eight teams, silently.
  assert.equal(games.get('LVR')?.opponent, 'DEN', "MFL's LVR resolves the same game as LV");
  assert.equal(games.get('JAC')?.opponent, 'WSH', "MFL's JAC resolves the scoreboard's JAX");
  // ...and both directions, since which side is odd depends on the team:
  // MFL says WAS where this scoreboard said WSH.
  assert.equal(games.get('WAS')?.opponent, 'JAX', "WAS resolves the scoreboard's WSH");
  assert.equal(games.get('WSH')?.opponent, 'JAX');

  // An alias must never invent a game for a team that isn't playing.
  assert.equal(games.has('MIA'), false);
  assert.equal(games.has('GBP'), false, 'an alias for a team with no event stays absent');
}

// --- fetchNflGames degrades rather than throwing on a thin scoreboard ---
{
  stubFetch(() => okJson({ events: [
    // A competitor with no identifiable opponent still needs its clock, since
    // that is what the win-probability model reads; the opponent half just
    // comes back null and the drawer omits that part of the line.
    { competitions: [{ status: { type: { state: 'pre' } }, competitors: [{ team: { abbreviation: 'SEA' }, homeAway: 'home' }] }] },
    // Junk entries must not take the whole map down with them.
    { competitions: [{ status: {}, competitors: [{ team: {} }, {}] }] },
    {},
  ] }));
  const games = await fetchNflGames();
  assert.equal(games.get('SEA').opponent, null, 'a lone competitor has no opponent, and that is not an error');
  assert.equal(games.get('SEA').secondsRemaining, 3600);
  assert.equal(games.get('SEA').detail, null);
}

// --- fetchEspnScoring: join against clockMap, starters only ---
{
  const clockMap = new Map([['SEA', 1800], ['NE', 0], ['KC', 3600]]);

  // appliedStatTotal and defaultPositionId feed the Scoring tab's detail
  // drawer (see espnTeamLiveStarters). Both are community-documented rather
  // than probed against a real league of ours — probe-live-scoring-players.yml
  // is what confirms them — so the last entry below deliberately omits
  // appliedStatTotal to pin the degrade path: an absent points field must
  // land null, never 0, since the drawer renders the two differently.
  const rosterEntry = (proTeamId, lineupSlotId, fullName, appliedStatTotal, defaultPositionId) => ({
    lineupSlotId,
    playerPoolEntry: {
      ...(appliedStatTotal === undefined ? {} : { appliedStatTotal }),
      player: { proTeamId, fullName, defaultPositionId },
    },
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
            rosterEntry(26, 3, 'Seattle Starter', 12.5, 3), // SEA starter (proTeamId 26 = SEA), WR
            rosterEntry(17, 3, 'Patriot Starter', 0, 4), // NE starter, game over (0 left), TE, genuine 0
            rosterEntry(12, 20, 'Bench Guy', 99, 3), // KC on the BENCH — must not count
          ],
        },
      },
      away: {
        teamId: 2,
        totalPoints: 15,
        rosterForCurrentScoringPeriod: {
          entries: [
            rosterEntry(12, 3, 'Chief Starter', undefined, 1), // KC starter, full game left, QB, NO points field
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
    [
      { name: 'Seattle Starter', secondsRemaining: 1800, position: 'WR', team: 'SEA', points: 12.5, stats: [] },
      { name: 'Patriot Starter', secondsRemaining: 0, position: 'TE', team: 'NE', points: 0, stats: [] },
    ],
    'the benched entry is excluded from the per-player breakdown too, by name since ESPN has no id FantasyPros joins against; stats is [] since these fixtures carry no player.stats array (see test-stat-breakdown.mjs for that)'
  );
  // A genuine 0 above survives as 0; a MISSING appliedStatTotal below lands
  // null. The drawer shows the first as "0.00" and the second as a dash —
  // "played and scored nothing" and "we don't know yet" are different facts.
  assert.deepEqual(
    away.players,
    [{ name: 'Chief Starter', secondsRemaining: 3600, position: 'QB', team: 'KC', points: null, stats: [] }]
  );
}

// --- fetchSleeperScoring: join against clockMap via playerMap, starters only ---
{
  const clockMap = new Map([['DAL', 900], ['PHI', 3600]]);
  const playerMap = new Map([
    ['100', { team: 'DAL', name: 'Cowboy Starter', position: 'RB' }],
    ['101', { team: 'PHI', name: 'Eagle Starter', position: 'QB' }],
    ['102', { team: 'DAL', name: 'Cowboy Bench', position: 'WR' }], // rostered but not a starter
  ]);

  stubFetch((url) => {
    if (url.includes('state/nfl')) return okJson({ week: 1, display_week: 1 });
    if (url.includes('/users')) return okJson([]);
    if (url.includes('/rosters')) return okJson([
      { roster_id: 1, owner_id: 'u1' },
      { roster_id: 2, owner_id: 'u2' },
    ]);
    // players_points is the per-player map the detail drawer reads, riding
    // along on the very response this call already makes. Roster 2
    // deliberately has none, pinning the degrade path: no map means null
    // points, never 0.
    if (url.includes('/matchups/1')) return okJson([
      {
        roster_id: 1, points: 10, matchup_id: 1, starters: ['100'], players: ['100', '102'],
        players_points: { 100: 10, 102: 4.5 },
      },
      { roster_id: 2, points: 8, matchup_id: 1, starters: ['101'], players: ['101'] },
    ]);
    // The bare league object, fetched for scoring_settings (the stat-
    // breakdown popover's per-category point rates) — no scoring_settings
    // here at all, pinning that sleeperStatBreakdown degrades to [] rather
    // than throwing when a league's rules didn't load. See
    // test-stat-breakdown.mjs for the populated case.
    if (/\/league\/[^/]+$/.test(url)) return okJson({});
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
    [{ name: 'Cowboy Starter', secondsRemaining: 900, position: 'RB', team: 'DAL', points: 10, stats: [] }],
    'only the roster\'s own `starters` list feeds the per-player breakdown, same as minutesRemaining'
  );
  assert.deepEqual(
    away.players,
    [{ name: 'Eagle Starter', secondsRemaining: 3600, position: 'QB', team: 'PHI', points: null, stats: [] }],
    'no players_points on this roster means null points, not a fabricated 0'
  );
}

console.log('test-espn-sleeper-live-time.mjs OK');
