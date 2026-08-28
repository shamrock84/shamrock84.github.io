// Unit test for extractDepthChartEntries in scripts/lib/espn-depth-chart.mjs
// — the parsing step every assumption about ESPN's undocumented depth-chart
// shape actually runs through. Fixtures below are shaped exactly like the
// real responses probe-espn-depth-chart-slot.mjs captured (Kansas City's
// QB and WR groups), not invented shapes.

import assert from 'node:assert/strict';
import { extractDepthChartEntries, buildRosterIndex } from './lib/espn-depth-chart.mjs';

const athleteRef = (id) => ({ $ref: `http://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/2026/athletes/${id}?lang=en&region=us` });
const roster = (entries) => new Map(entries.map(([id, name, injuryStatus = null]) => [id, { name, injuryStatus }]));

{
  // QB: one slot value (no WR-style role split), rank forms the order —
  // pinned against the real Kansas City QB group.
  const depthChart = {
    items: [
      {
        name: '3WR 1TE',
        positions: {
          qb: {
            athletes: [
              { slot: 9, rank: 1, athlete: athleteRef('3139477') },
              { slot: 9, rank: 2, athlete: athleteRef('4360423') },
              { slot: 9, rank: 3, athlete: athleteRef('4432665') },
            ],
          },
        },
      },
    ],
  };
  const rosterById = roster([
    ['3139477', 'Patrick Mahomes'],
    ['4360423', 'Justin Fields'],
    ['4432665', 'Garrett Nussmeier'],
  ]);
  const entries = extractDepthChartEntries(depthChart, 'qb', rosterById);
  assert.deepEqual(
    entries.map((e) => [e.rank, e.name, e.role]),
    [
      [1, 'Patrick Mahomes', null],
      [2, 'Justin Fields', null],
      [3, 'Garrett Nussmeier', null],
    ],
    'QB entries come back sorted by rank, with no role tag'
  );
}

{
  // WR: three role slots (1/2/8 -> X/Z/S) interleaving in rank order —
  // ordering must come from `rank`, never from `slot`, since `slot` is
  // constant per role and would group X-X-X-X, Z-Z-Z-Z, S-S-S-S if used.
  const depthChart = {
    items: [
      {
        name: '3WR 1TE',
        positions: {
          wr: {
            athletes: [
              { slot: 1, rank: 1, athlete: athleteRef('101') },
              { slot: 2, rank: 2, athlete: athleteRef('102') },
              { slot: 8, rank: 3, athlete: athleteRef('103') },
              { slot: 1, rank: 4, athlete: athleteRef('104') },
            ],
          },
        },
      },
    ],
  };
  const rosterById = roster([
    ['101', 'Outside X1'],
    ['102', 'Outside Z1'],
    ['103', 'Slot S1'],
    ['104', 'Outside X2'],
  ]);
  const entries = extractDepthChartEntries(depthChart, 'wr', rosterById);
  assert.deepEqual(
    entries.map((e) => [e.rank, e.name, e.role]),
    [
      [1, 'Outside X1', 'X'],
      [2, 'Outside Z1', 'Z'],
      [3, 'Slot S1', 'S'],
      [4, 'Outside X2', 'X'],
    ],
    'WR role comes from slot (1/2/8 -> X/Z/S), order comes from rank'
  );
}

{
  // A position that only appears on a chart whose name isn't requested is
  // simply absent — never falls back to guessing which chart is "offense".
  const depthChart = {
    items: [{ name: 'Base 4-3 D', positions: { lde: { athletes: [{ slot: 1, rank: 1, athlete: athleteRef('x') }] } } }],
  };
  const entries = extractDepthChartEntries(depthChart, 'qb', roster([]));
  assert.deepEqual(entries, [], 'a position missing from every chart on the team returns empty, not a crash');
}

{
  // Dropped rather than guessed at: no rank, unparseable $ref, and an id
  // with no roster match (e.g. practice squad, not on the active roster
  // response) are each their own reason to skip an entry.
  const depthChart = {
    items: [
      {
        name: '3WR 1TE',
        positions: {
          te: {
            athletes: [
              { slot: 10, rank: 1, athlete: athleteRef('201') },
              { slot: 10, rank: null, athlete: athleteRef('202') },
              { slot: 10, rank: 2, athlete: { $ref: 'not a url' } },
              { slot: 10, rank: 3, athlete: athleteRef('999') },
            ],
          },
        },
      },
    ],
  };
  const rosterById = roster([['201', 'Real Player']]);
  const entries = extractDepthChartEntries(depthChart, 'te', rosterById);
  assert.deepEqual(entries.map((e) => e.name), ['Real Player'], 'only the fully-resolvable entry survives');
}

{
  // Injury status carries through from the roster join — free on the same
  // request already needed for the name, per probe-espn-depth-chart-slot.mjs
  // — and abbreviated via normalizeInjuryStatus (providers.mjs), the same
  // function every other provider's injury designation already goes
  // through, rather than a second map. 'Out' is ESPN's real spelling,
  // confirmed by a live sync; extractDepthChartEntries never sees the raw
  // string, only what buildRosterIndex already normalized it to.
  const depthChart = {
    items: [{ name: '3WR 1TE', positions: { rb: { athletes: [{ slot: 11, rank: 1, athlete: athleteRef('301') }] } } }],
  };
  const rosterById = roster([['301', 'Banged Up Guy', 'O']]);
  const entries = extractDepthChartEntries(depthChart, 'rb', rosterById);
  assert.equal(entries[0].injuryStatus, 'O');
}

{
  // buildRosterIndex abbreviates via normalizeInjuryStatus (providers.mjs)
  // rather than storing the raw string — these five are the exact values a
  // live sync confirmed ESPN's site API actually returns (909 depth-chart
  // players checked, 142 carrying a status). A healthy player (no
  // `injuries` entries) gets null, not an empty-string badge.
  const rosterData = {
    athletes: [
      { position: 'offense', items: [
        { id: '1', displayName: 'Q Guy', injuries: [{ status: 'Questionable' }] },
        { id: '2', displayName: 'D Guy', injuries: [{ status: 'Doubtful' }] },
        { id: '3', displayName: 'O Guy', injuries: [{ status: 'Out' }] },
        { id: '4', displayName: 'IR Guy', injuries: [{ status: 'Injured Reserve' }] },
        { id: '5', displayName: 'Susp Guy', injuries: [{ status: 'Suspension' }] },
        { id: '6', displayName: 'Healthy Guy', injuries: [] },
      ] },
    ],
  };
  const byId = buildRosterIndex(rosterData);
  assert.deepEqual(
    [...byId.values()].map((p) => p.injuryStatus),
    ['Q', 'D', 'O', 'IR', 'SUSP', null],
    'every real ESPN depth-chart injury status abbreviates via the shared normalizeInjuryStatus'
  );
}

{
  // No crash on the edges: missing items array, missing positions object,
  // missing athletes array.
  assert.deepEqual(extractDepthChartEntries(null, 'qb', new Map()), []);
  assert.deepEqual(extractDepthChartEntries({}, 'qb', new Map()), []);
  assert.deepEqual(extractDepthChartEntries({ items: [{}] }, 'qb', new Map()), []);
  assert.deepEqual(extractDepthChartEntries({ items: [{ positions: { qb: {} } }] }, 'qb', new Map()), []);
}

console.log('test-espn-depth-chart: all assertions passed');
