// Unit test for the MFL half of the Scoring tab's stat-breakdown popover —
// the workaround for MFL's own API having no source for this at all (see
// mfl/README.md): ESPN's PUBLIC (non-fantasy) per-game boxscore, joined by
// normalized player name, crossed against the league's own MFL scoring
// rules (TYPE=rules) to compute "X points for Y stat" independently.
// Confirmed real via probe-live-scoring-players.yml RUN 5/6/7 — this pins
// the parsing/joining logic against fixtures shaped exactly like what those
// runs captured.
//
// Deliberately NOT testing that the computed sum reconciles with the real
// MFL score — this project shipped without that check (see
// mflStatBreakdownFromBoxscore's own comment for why), so there is nothing
// to pin there yet.

import assert from 'node:assert/strict';
import {
  addBoxscoreToStatIndex,
  fetchMflSkillPositionRates,
  fetchScoring,
} from './lib/providers.mjs';

function stubFetch(handler) {
  globalThis.fetch = async (url) => handler(String(url));
}
const okJson = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

// A boxscore statistics category shaped exactly like ESPN's real response
// (probe RUN 5/6): parallel `keys`/`athletes[].stats` arrays, one entry per
// athlete.
function category(name, keys, athletes) {
  return { name, keys, athletes: athletes.map(([displayName, stats]) => ({ athlete: { displayName }, stats })) };
}

// --- addBoxscoreToStatIndex: the ESPN-boxscore -> MFL-event-code join ---
{
  const boxscore = {
    players: [
      {
        team: { abbreviation: 'NE' },
        statistics: [
          category('passing', ['completions/passingAttempts', 'passingYards', 'yardsPerPassAttempt', 'passingTouchdowns', 'interceptions'], [
            ['Drake Maye', ['23/33', '178', '5.4', '1', '3']],
          ]),
          // A category this join doesn't touch — must not leak into the index
          // at all, and its own "interceptions" key (INTs CAUGHT) must never
          // be mistaken for passing's "interceptions" (INTs THROWN).
          category('defensive', ['totalTackles', 'sacks'], [['Robert Spillane', ['8', '0']]]),
        ],
      },
      {
        team: { abbreviation: 'SEA' },
        statistics: [
          category('rushing', ['rushingAttempts', 'rushingYards', 'yardsPerRushAttempt', 'rushingTouchdowns', 'longRushing'], [
            ['Jadarian Price', ['10', '52', '5.2', '0', '13']],
          ]),
          category('receiving', ['receptions', 'receivingYards', 'yardsPerReception', 'receivingTouchdowns', 'longReception', 'receivingTargets'], [
            ['Jaxon Smith-Njigba', ['8', '122', '15.3', '1', '45', '11']],
            // A genuine zero (no rushing/receiving TD) must not produce a
            // zero-point row later — see mflStatBreakdownFromBoxscore's own
            // filter, which skips a null/zero rate or contribution the same
            // way espnStatBreakdown/sleeperStatBreakdown already do.
            ['Zero Man', ['0', '0', '0', '0', '0', '0']],
          ]),
        ],
      },
    ],
  };

  const index = addBoxscoreToStatIndex(boxscore);
  assert.deepEqual(
    index.get('jaxon smith njigba'),
    { CY: 122, '#C': 1, CC: 8 },
    'receiving yards/TD/receptions all land under their MFL event codes, keyed by normalized name'
  );
  assert.deepEqual(
    index.get('drake maye'),
    { PY: 178, '#P': 1, IN: 3 },
    'passing yards/TD/interceptions-thrown all land under their MFL event codes'
  );
  assert.deepEqual(
    index.get('jadarian price'),
    { RY: 52 },
    'a genuine 0 (no rushing TD) produces no #R entry at all — never a zero stored and later shown as a zero-point row'
  );
  assert.equal(index.get('zero man'), undefined, 'a player with every stat at 0 gets no entry whatsoever');
  assert.equal(index.get('robert spillane'), undefined, 'the defensive category is not in ESPN_BOXSCORE_TO_MFL_EVENT, so it contributes nothing');

  // Two games merge into one shared index — the real usage in
  // api/live-scoring.js, where every NFL game in play this week folds into
  // one map before any MFL league is processed.
  const secondBoxscore = {
    players: [{
      team: { abbreviation: 'KC' },
      statistics: [category('receiving', ['receptions', 'receivingYards', 'yardsPerReception', 'receivingTouchdowns', 'longReception', 'receivingTargets'], [
        ['Travis Kelce', ['6', '70', '11.7', '1', '20', '8']],
      ])],
    }],
  };
  addBoxscoreToStatIndex(secondBoxscore, index);
  assert.deepEqual(index.get('travis kelce'), { CY: 70, '#C': 1, CC: 6 }, 'a second game folds into the same shared map');
  assert.ok(index.has('drake maye'), 'the first game\'s entries survive the merge');
}

// --- fetchMflSkillPositionRates: TYPE=rules -> Map<position, Map<eventCode, rate>> ---
{
  // Shaped exactly like the real captured TYPE=rules response for league
  // 26696 (probe-live-scoring-players.yml RUN 2): a QB|RB|WR|TE|PK group
  // carrying every skill-position rule this feature reads, plus a Def-only
  // group with a non-`*`-prefixed threshold rule (field goals) that must be
  // excluded — this project has no way to reduce a distance-bucketed table
  // to one per-unit rate, so it's skipped rather than misapplied.
  const rulesResponse = {
    rules: {
      positionRules: [
        {
          positions: { $t: 'QB|RB|WR|TE|PK' },
          rule: [
            { event: { $t: '#P' }, points: { $t: '*4' } },
            { event: { $t: 'PY' }, points: { $t: '*.05' } },
            { event: { $t: 'IN' }, points: { $t: '*-3' } },
            { event: { $t: '#R' }, points: { $t: '*6' } },
            { event: { $t: 'RY' }, points: { $t: '*.1' } },
            { event: { $t: '#C' }, points: { $t: '*6' } },
            { event: { $t: 'CY' }, points: { $t: '*.1' } },
            { event: { $t: 'CC' }, points: { $t: '*1' } },
            // Not a per-unit rate — a flat range-keyed bonus, same shape as
            // the real league's FG rules. Must be excluded rather than
            // read as "0.05 points per yard, 1 point flat" nonsense.
            { event: { $t: 'FG' }, points: { $t: '3' }, range: { $t: '30-49' } },
          ],
        },
        // A TE-premium group, same real-world shape fetchMflReceptionPoints'
        // own comment describes — TE gets a different CC rate than WR/RB.
        { positions: { $t: 'TE' }, rule: [{ event: { $t: 'CC' }, points: { $t: '*1.5' } }] },
      ],
    },
  };
  stubFetch(() => okJson(rulesResponse));
  const rates = await fetchMflSkillPositionRates({ id: '26696' }, 'cookie');

  assert.equal(rates.get('WR').get('CC'), 1, 'WR keeps the base 1.0 PPR rate');
  assert.equal(rates.get('TE').get('CC'), 1.5, 'TE is overridden by its own premium group');
  assert.equal(rates.get('QB').get('PY'), 0.05);
  assert.equal(rates.get('QB').get('#P'), 4);
  assert.equal(rates.get('QB').get('IN'), -3);
  assert.equal(rates.get('RB').get('RY'), 0.1);
  assert.equal(rates.get('RB').get('#R'), 6);
  assert.equal(rates.get('WR').get('CY'), 0.1);
  assert.equal(rates.get('WR').get('#C'), 6);
  assert.equal(rates.get('QB').get('FG'), undefined, 'a non-*-prefixed threshold rule is excluded entirely');
}

// --- mflStatBreakdownFromBoxscore, exercised end-to-end through fetchScoring ---
{
  const liveScoringResponse = {
    liveScoring: {
      week: '1',
      matchup: [{
        franchise: [
          {
            id: '0001', score: '12.4', isHome: '1', gameSecondsRemaining: '0',
            players: { player: [{ id: '9001', status: 'starter', score: '12.4', gameSecondsRemaining: '0' }] },
          },
          { id: '0002', score: '0.0', isHome: '0', players: {}, gameSecondsRemaining: '3600' },
        ],
      }],
    },
  };
  stubFetch(() => okJson(liveScoringResponse));

  const league = { id: '26696', franchiseId: '0001' };
  const names = { nameById: new Map([['0001', 'My Team'], ['0002', 'Their Team']]), ownerById: new Map() };
  const playerMap = new Map([['9001', { name: 'Jaxon Smith-Njigba', position: 'WR', team: 'SEA' }]]);

  const statIndex = addBoxscoreToStatIndex({
    players: [{
      team: { abbreviation: 'SEA' },
      statistics: [category('receiving', ['receptions', 'receivingYards', 'yardsPerReception', 'receivingTouchdowns', 'longReception', 'receivingTargets'], [
        ['Jaxon Smith-Njigba', ['8', '122', '15.3', '1', '45', '11']],
      ])],
    }],
  });
  const rates = new Map([['WR', new Map([['CY', 0.1], ['#C', 6], ['CC', 1]])]]);

  const result = await fetchScoring(league, 'cookie', names, undefined, playerMap, statIndex, rates);
  const me = result.teams.find((t) => t.franchiseId === '0001');
  assert.deepEqual(
    me.players[0].stats,
    [
      { label: 'Receiving Yards', raw: 122, points: 0.1 * 122 },
      { label: 'Receptions', raw: 8, points: 8 },
      { label: 'Receiving Touchdowns', raw: 1, points: 6 },
    ],
    'largest contribution first (12.2, 8, 6), same ordering convention as espnStatBreakdown/sleeperStatBreakdown'
  );

  // Missing either input degrades to [] rather than throwing — same
  // graceful-absence posture as every other optional param in this file.
  const withoutIndex = await fetchScoring(league, 'cookie', names, undefined, playerMap, undefined, rates);
  assert.deepEqual(withoutIndex.teams.find((t) => t.franchiseId === '0001').players[0].stats, []);
  const withoutRates = await fetchScoring(league, 'cookie', names, undefined, playerMap, statIndex, undefined);
  assert.deepEqual(withoutRates.teams.find((t) => t.franchiseId === '0001').players[0].stats, []);

  // A stat this player recorded but this league's rules don't price (no
  // rate for that position/code) contributes no row, same as a category
  // absent from Sleeper's own scoring_settings.
  const noRecRate = new Map([['WR', new Map([['CY', 0.1]])]]);
  const priced = await fetchScoring(league, 'cookie', names, undefined, playerMap, statIndex, noRecRate);
  assert.deepEqual(
    priced.teams.find((t) => t.franchiseId === '0001').players[0].stats,
    [{ label: 'Receiving Yards', raw: 122, points: 0.1 * 122 }],
    'unpriced categories (here, TD and receptions) are dropped, not shown at a guessed rate'
  );
}

console.log('test-mfl-boxscore-breakdown.mjs OK');
