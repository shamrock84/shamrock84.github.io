// Unit test for the History tab's placement derivation —
// scripts/lib/history.mjs.
//
// The MFL fixtures for the top ("Fantasy Bowl") family below are copied
// verbatim from what probe-league-history.mjs printed against the real API
// for league 26696, year 2025 (see that script's own header comment for the
// full run history). The bottom ("Toilet Bowl") family fixture is
// synthetic — the probe only ever fetched BRACKET_ID=1's raw shape, not 3
// or 4 — built to the same shape (a 5-team main bracket, a 2-team
// consolation) specifically to pin that the direction (winner gets the
// better of the two remaining ranks) is identical for both families, per
// explicit instruction: a Toilet Bowl is not scored backwards.

import assert from 'node:assert/strict';
import {
  bracketFamily,
  isConsolationBracket,
  franchisesInBracket,
  computeMflSeasonPlacements,
  espnSeasonPlacement,
} from './lib/history.mjs';
import { yearsNeedingHistoryBackfill } from './fetch-rosters.mjs';

// ---- Bracket name classification -------------------------------------------

{
  // Real names seen across leagues in this config for the same top bracket.
  for (const name of ['Fantasy Bowl', 'Sole Survivor', 'Championship Bracket', 'Champions Bracket']) {
    assert.equal(bracketFamily(name), 'top', `"${name}" is the top family`);
    assert.equal(isConsolationBracket(name), false, `"${name}" is not a consolation bracket`);
  }
  assert.equal(bracketFamily('Toilet Bowl'), 'bottom');
  assert.equal(bracketFamily('TOILET bowl'), 'bottom', 'case-insensitive');
  assert.equal(bracketFamily('toilet bowl consolation'), 'bottom', 'a consolation bracket keeps its family');
  assert.equal(isConsolationBracket('Fantasy Bowl Consolation'), true);
  assert.equal(isConsolationBracket('Toilet Bowl Consolation'), true);
  assert.equal(isConsolationBracket('Fantasy Bowl'), false);
}

// ---- Real MFL bracket data: league 26696, year 2025 ------------------------

// Bracket 1, "Fantasy Bowl" — verbatim from the probe. Seeds 1-3 (0010,
// 0008, 0001) bye into week 16; the week-15 game seeds 4 vs 5.
const fantasyBowl = {
  playoffRound: [
    {
      week: '15',
      playoffGame: {
        game_id: '1',
        away: { franchise_id: '0009', points: '118.6', seed: '5' },
        home: { franchise_id: '0002', points: '214.5', seed: '4' },
      },
    },
    {
      week: '16',
      playoffGame: [
        {
          game_id: '2',
          home: { franchise_id: '0010', points: '140.5', seed: '1' },
          away: { franchise_id: '0002', points: '126.8', winner_of_game: '1' },
        },
        {
          game_id: '3',
          home: { franchise_id: '0008', points: '137.2', seed: '2' },
          away: { franchise_id: '0001', points: '184.2', seed: '3' },
        },
      ],
    },
    {
      week: '17',
      playoffGame: {
        game_id: '4',
        home: { franchise_id: '0001', points: '111.5', winner_of_game: '3' },
        away: { franchise_id: '0010', points: '90.3', winner_of_game: '2' },
      },
    },
  ],
};

// Bracket 2, "Fantasy Bowl Consolation" — its game itself wasn't fetched
// directly by the probe, but its score is confirmed by the cross-check
// against TYPE=weeklyResults&W=17, which showed this exact matchup
// (0002 147.7, 0008 148) independently of the bracket endpoint.
const fantasyBowlConsolation = {
  playoffRound: [
    {
      week: '17',
      playoffGame: {
        game_id: '5',
        home: { franchise_id: '0008', points: '148', winner_of_game: '2' },
        away: { franchise_id: '0002', points: '147.7', winner_of_game: '1' },
      },
    },
  ],
};

{
  const brackets = [
    { id: '1', name: 'Fantasy Bowl', teamsInvolved: '5' },
    { id: '2', name: 'Fantasy Bowl Consolation', teamsInvolved: '2' },
  ];
  const bracketDataById = new Map([
    ['1', fantasyBowl],
    ['2', fantasyBowlConsolation],
  ]);
  // Regular-season order only matters for a genuine gap — none here, but a
  // realistic value (MNMx's actual leagueStandings order) is supplied
  // anyway so a bug that wrongly falls back to it would be visible.
  const regularSeasonOrder = ['0010', '0008', '0001', '0005', '0004', '0002', '0006', '0009', '0007', '0003'];
  const leagueFranchiseIds = ['0001', '0002', '0008', '0009', '0010'];

  const result = computeMflSeasonPlacements({ leagueFranchiseIds, brackets, bracketDataById, regularSeasonOrder });
  const byId = Object.fromEntries(result.map((r) => [r.franchiseId, r]));

  // The real result: 0001 won the championship despite entering as the
  // 3-seed, and 0010 — the actual best regular-season record — lost the
  // final and finished 2nd. This is the exact case the whole investigation
  // was for: leagueStandings order alone would have called 0010 the winner.
  assert.equal(byId['0001'].rank, 1, 'bracket final winner, despite being the 3-seed');
  assert.equal(byId['0010'].rank, 2, 'bracket final loser, despite the best regular-season record');
  assert.equal(byId['0008'].rank, 3, 'consolation final winner');
  assert.equal(byId['0002'].rank, 4, 'consolation final loser');
  assert.equal(byId['0009'].rank, 5, 'the one team eliminated in the first round with no consolation game — determined by elimination, not guessed');
  for (const id of leagueFranchiseIds) {
    assert.equal(byId[id].total, 5);
    assert.equal(byId[id].guessed, false, `${id}'s rank is fully determined by bracket results, not a guess`);
  }
}

// ---- Synthetic Toilet Bowl: same shape, same direction ---------------------
// Explicit instruction: the Toilet Bowl's winner escapes the worse of the
// two remaining ranks exactly the way the championship bracket's winner
// does — it is not scored backwards. This fixture pins that the SAME
// function, given a "toilet" name, applies the identical rule.

const toiletBowl = {
  playoffRound: [
    { week: '15', playoffGame: { game_id: '10', away: { franchise_id: '0107', points: '80' }, home: { franchise_id: '0106', points: '95' } } },
    {
      week: '16',
      playoffGame: [
        { game_id: '11', home: { franchise_id: '0103', points: '100' }, away: { franchise_id: '0106', points: '70', winner_of_game: '10' } },
        { game_id: '12', home: { franchise_id: '0104', points: '90' }, away: { franchise_id: '0105', points: '85' } },
      ],
    },
    { week: '17', playoffGame: { game_id: '13', home: { franchise_id: '0103', points: '60', winner_of_game: '11' }, away: { franchise_id: '0104', points: '75', winner_of_game: '12' } } },
  ],
};
const toiletBowlConsolation = {
  playoffRound: [
    { week: '17', playoffGame: { game_id: '14', home: { franchise_id: '0105', points: '55', winner_of_game: '12' }, away: { franchise_id: '0106', points: '65', winner_of_game: '11' } } },
  ],
};

{
  const brackets = [
    { id: '1', name: 'Fantasy Bowl', teamsInvolved: '5' },
    { id: '2', name: 'Fantasy Bowl Consolation', teamsInvolved: '2' },
    { id: '3', name: 'Toilet Bowl', teamsInvolved: '5' },
    { id: '4', name: 'Toilet Bowl Consolation', teamsInvolved: '2' },
  ];
  const bracketDataById = new Map([
    ['1', fantasyBowl],
    ['2', fantasyBowlConsolation],
    ['3', toiletBowl],
    ['4', toiletBowlConsolation],
  ]);
  const leagueFranchiseIds = ['0001', '0002', '0008', '0009', '0010', '0103', '0104', '0105', '0106', '0107'];
  const regularSeasonOrder = [...leagueFranchiseIds]; // irrelevant here — nothing ambiguous

  const result = computeMflSeasonPlacements({ leagueFranchiseIds, brackets, bracketDataById, regularSeasonOrder });
  const byId = Object.fromEntries(result.map((r) => [r.franchiseId, r]));

  assert.equal(byId['0104'].rank, 6, 'Toilet Bowl final winner takes the BETTER remaining rank (6), same direction as the top family');
  assert.equal(byId['0103'].rank, 7, 'Toilet Bowl final loser — confirmed last of the two finalists');
  assert.equal(byId['0106'].rank, 8, "Toilet Bowl Consolation winner — escaped the worse tail rank");
  assert.equal(byId['0105'].rank, 9);
  assert.equal(byId['0107'].rank, 10, 'the one team eliminated in the Toilet Bowl\'s first round — determined by elimination');
  assert.ok([...leagueFranchiseIds].every((id) => !byId[id].guessed), 'every rank here is bracket-determined, not guessed');
}

// ---- Gap: no bottom bracket run at all --------------------------------------
// Some leagues only run a playoffs bracket for the top half and nothing for
// the rest — a real, likely-common shape, not an edge case invented for
// coverage. Every team outside the one bracket that exists must still get a
// row (never silently dropped), ordered by regular-season standing, and
// flagged as a guess since nothing besides that standing placed them.

{
  const brackets = [{ id: '1', name: 'Fantasy Bowl', teamsInvolved: '5' }];
  const bracketDataById = new Map([['1', fantasyBowl]]);
  const leagueFranchiseIds = ['0001', '0002', '0008', '0009', '0010', 'X1', 'X2', 'X3'];
  // Best-to-worst; X1/X2/X3 are the three teams with no bracket at all.
  const regularSeasonOrder = ['0010', '0008', '0001', '0002', '0009', 'X2', 'X1', 'X3'];

  const result = computeMflSeasonPlacements({ leagueFranchiseIds, brackets, bracketDataById, regularSeasonOrder });
  const byId = Object.fromEntries(result.map((r) => [r.franchiseId, r]));

  // The bracket-covered five keep their bracket-determined ranks 1-5,
  // unaffected by the fact that a second family never ran.
  assert.equal(byId['0001'].rank, 1);
  assert.equal(byId['0009'].rank, 5);
  assert.equal(byId['0001'].guessed, false);

  // The uncovered three fill ranks 6-8 in their regular-season order.
  assert.equal(byId['X2'].rank, 6);
  assert.equal(byId['X1'].rank, 7);
  assert.equal(byId['X3'].rank, 8);
  assert.ok(byId['X1'].guessed && byId['X2'].guessed && byId['X3'].guessed, 'all three are flagged as guesses');
}

// ---- Gap: a family with more leftover teams than a consolation can settle --

{
  // A 6-team family: round 1 is A-vs-F and B-vs-E, round 2 (semis) is
  // C-vs-(A winner) and D-vs-(B winner), and the final is the two semi
  // winners. The consolation covers the two SEMIFINAL losers (3rd/4th);
  // the two FIRST-ROUND losers (E and F) reach no further game at all,
  // leaving 2 leftover with no bracket data to order them relative to each
  // other — the genuine "impossible to fully deduce" case.
  const sixTeamMain = {
    playoffRound: [
      {
        week: '15',
        playoffGame: [
          { game_id: '20', home: { franchise_id: 'A', points: '100' }, away: { franchise_id: 'F', points: '90' } },
          { game_id: '21', home: { franchise_id: 'B', points: '110' }, away: { franchise_id: 'E', points: '95' } },
        ],
      },
      {
        week: '16',
        playoffGame: [
          { game_id: '22', home: { franchise_id: 'C', points: '105' }, away: { franchise_id: 'A', points: '80', winner_of_game: '20' } },
          { game_id: '23', home: { franchise_id: 'D', points: '99' }, away: { franchise_id: 'B', points: '120', winner_of_game: '21' } },
        ],
      },
      {
        week: '17',
        playoffGame: { game_id: '24', home: { franchise_id: 'C', points: '88', winner_of_game: '22' }, away: { franchise_id: 'B', points: '130', winner_of_game: '23' } },
      },
    ],
  };
  // The two semifinal LOSERS (A lost game 22 to C, D lost game 23 to B) play
  // each other for 3rd/4th — not either semifinal's winner.
  const consolation = {
    playoffRound: [
      { week: '17', playoffGame: { game_id: '25', home: { franchise_id: 'A', points: '85', winner_of_game: '22' }, away: { franchise_id: 'D', points: '70', winner_of_game: '23' } } },
    ],
  };
  const brackets = [
    { id: '1', name: 'Championship Bracket', teamsInvolved: '6' },
    { id: '2', name: 'Championship Bracket Consolation', teamsInvolved: '2' },
  ];
  const bracketDataById = new Map([
    ['1', sixTeamMain],
    ['2', consolation],
  ]);
  const leagueFranchiseIds = ['A', 'B', 'C', 'D', 'E', 'F'];
  // E and F are the two first-round losers left over. Best-to-worst overall
  // (used only to order the two of them relative to each other) — E ahead
  // of F.
  const regularSeasonOrder = ['B', 'C', 'A', 'D', 'E', 'F'];

  const result = computeMflSeasonPlacements({ leagueFranchiseIds, brackets, bracketDataById, regularSeasonOrder });
  const byId = Object.fromEntries(result.map((r) => [r.franchiseId, r]));

  assert.equal(byId['B'].rank, 1, 'main final winner');
  assert.equal(byId['C'].rank, 2, 'main final loser');
  assert.equal(byId['A'].rank, 3, 'consolation winner (the two semifinal losers play for 3rd/4th)');
  assert.equal(byId['D'].rank, 4, 'consolation loser');
  assert.ok(!byId['B'].guessed && !byId['C'].guessed && !byId['A'].guessed && !byId['D'].guessed, 'all four settled by an actual game result');

  // E and F never played each other or anyone past round 1 — nothing in the
  // bracket orders them, so they fall back to regular-season order and are
  // flagged as guesses, unlike the four teams above.
  assert.equal(byId['E'].rank, 5, 'regular-season order breaks the tie: E is ahead of F');
  assert.equal(byId['F'].rank, 6);
  assert.ok(byId['E'].guessed && byId['F'].guessed, 'both flagged as guesses — bracket data alone cannot order them');
}

// ---- franchisesInBracket ----------------------------------------------------

{
  const ids = franchisesInBracket(fantasyBowl);
  assert.deepEqual([...ids].sort(), ['0001', '0002', '0008', '0009', '0010'], 'every franchise across every round, including the first-round loser');
}

// ---- ESPN: a direct, never-guessed field -----------------------------------

{
  // Confirmed against real data: a clean 1..10 permutation, populated even
  // for a non-playoff team, independent of playoffSeed.
  assert.deepEqual(espnSeasonPlacement({ rankCalculatedFinal: 6 }, 10), { rank: 6, total: 10, guessed: false });
  assert.deepEqual(espnSeasonPlacement({ rankCalculatedFinal: 1 }, 10), { rank: 1, total: 10, guessed: false });
  assert.equal(espnSeasonPlacement({ rankCalculatedFinal: 0 }, 10), null, 'zero is not a real rank');
  assert.equal(espnSeasonPlacement({ rankCalculatedFinal: null }, 10), null);
  assert.equal(espnSeasonPlacement({}, 10), null, 'missing entirely — an old snapshot, or a season ESPN never resolved');
}

// ---- yearsNeedingHistoryBackfill --------------------------------------------

{
  const historyYears = [
    { year: '2023', id: '111' },
    { year: '2024', id: '111' },
    { year: '2025', id: '111' },
    { year: '2026', id: '111' }, // the currently active season
  ];
  const existingResults = [{ year: '2024', rank: 3, total: 10, guessed: false }];

  const missing = yearsNeedingHistoryBackfill(historyYears, existingResults, '2026');
  assert.deepEqual(
    missing.map((m) => m.year),
    ['2025', '2023'],
    'the active season is excluded, an already-recorded year is skipped, and the rest come back most-recent-first'
  );

  assert.deepEqual(
    yearsNeedingHistoryBackfill(historyYears, [], '2026').map((m) => m.year),
    ['2025', '2024', '2023'],
    'with nothing recorded yet, every past year is missing'
  );

  assert.deepEqual(yearsNeedingHistoryBackfill([], [], '2026'), [], 'no known history at all — nothing to backfill');
}

console.log('test-history: all assertions passed');
