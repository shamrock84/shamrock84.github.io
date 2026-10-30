// Pins the History backfill's retry throttle and lookup gate, and the sync's
// early start of its non-MFL fetches (see fetch-rosters.mjs).
//
// Background: every sync spent ~37s of its ~90s on a backfill that changed
// nothing — seven consecutive snapshots had identical `results`. Guessed years
// (a genuine bracket gap, re-fetched byte-identical) were retried every sync
// and ate the whole MFL budget; and every MFL league paid a TYPE=league lookup
// before anything was known to be missing. The sync now re-reads a guess at
// most weekly and looks a league's history up at most weekly. The on-demand
// backfill (backfill-history.yml) passes neither, and still re-reads everything.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  GUESSED_RETRY_DAYS,
  yearsNeedingHistoryBackfill,
  historyCheckKey,
  historyLookupIsDue,
  backfillLeagueHistory,
} from './fetch-rosters.mjs';

const NOW = new Date('2026-10-30T13:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString().slice(0, 10);
const years = (list) => list.map((y) => ({ year: String(y), id: `id${y}` }));
const missingYears = (history, results, retry, overrides) =>
  yearsNeedingHistoryBackfill(history, results, '2026', undefined, 'dynasty', overrides, retry).map((m) => m.year);

// ---- yearsNeedingHistoryBackfill with the throttle --------------------------
{
  const history = years([2023, 2024, 2025]);
  const results = [
    { year: '2023', rank: 4, total: 12, guessed: true, triedAt: daysAgo(2) },
    { year: '2024', rank: 5, total: 12, guessed: true, triedAt: daysAgo(GUESSED_RETRY_DAYS) },
    { year: '2025', rank: 6, total: 12, guessed: true }, // written before the stamp existed
  ];
  const retry = { now: NOW };
  assert.deepEqual(missingYears(history, results, retry).sort(), ['2024', '2025'],
    'a guess tried this week is left alone; one a full week old, or never stamped, is eligible');
  assert.deepEqual(missingYears(history, results, undefined).sort(), ['2023', '2024', '2025'],
    'without a throttle (the on-demand backfill) every guess is eligible, stamped or not');

  const confirmed = [{ year: '2023', rank: 1, total: 12, guessed: false, divisionWinnerFranchiseId: '0001', triedAt: daysAgo(0) }];
  assert.deepEqual(missingYears(years([2023]), confirmed, retry), [], 'a confirmed year is still never re-read');

  // The throttle never hides a year that has no entry at all.
  assert.deepEqual(missingYears(years([2022, 2023]), [results[0]], retry), ['2022'], 'unrecorded years are untouched');

  // An override only reorders the queue; a recently tried overridden guess is throttled like any other.
  const overridden = { 2023: 'id9' };
  assert.deepEqual(missingYears(years([2023, 2025]), results, retry, overridden), ['2025'],
    'an override does not exempt a recently tried guess from the throttle');
  assert.deepEqual(missingYears(years([2023, 2025]), results, undefined, overridden), ['2023', '2025'],
    'unthrottled, the override still jumps the queue');

  // A confirmed year missing its division winner has no stamp to be throttled by.
  const needsDivision = [{ year: '2023', rank: 2, total: 12, guessed: false, triedAt: daysAgo(0) }];
  assert.deepEqual(missingYears(years([2023]), needsDivision, retry), ['2023'], 'division-winner backfill is not throttled');
}

// ---- the lookup gate --------------------------------------------------------
{
  const league = { id: '1', season: '2026', startYear: '2023', type: 'dynasty', historyLeagueIds: { 2011: 'b', 2010: 'a' } };
  assert.equal(historyLookupIsDue(league, NOW), true, 'never checked: due');

  const checked = { ...league, historyCheck: { on: daysAgo(3), key: historyCheckKey(league) } };
  assert.equal(historyLookupIsDue(checked, NOW), false, 'checked this week with nothing eligible: skip the lookup');

  const stale = { ...league, historyCheck: { on: daysAgo(GUESSED_RETRY_DAYS), key: historyCheckKey(league) } };
  assert.equal(historyLookupIsDue(stale, NOW), true, 'a week later it is due again');

  for (const [what, change] of [
    ['a season rollover', { season: '2027' }],
    ['an edited startYear', { startYear: '2020' }],
    ['a type change', { type: 'salarycap' }],
    ['a new override', { historyLeagueIds: { 2010: 'a', 2011: 'b', 2012: 'c' } }],
    ['a changed override id', { historyLeagueIds: { 2010: 'a', 2011: 'z' } }],
  ]) {
    assert.equal(historyLookupIsDue({ ...checked, ...change }, NOW), true, `${what} makes the league due at once`);
  }
  assert.equal(
    historyCheckKey({ ...league, historyLeagueIds: { 2010: 'a', 2011: 'b' } }),
    historyCheckKey({ ...league, historyLeagueIds: { 2011: 'b', 2010: 'a' } }),
    'override key order does not matter'
  );
}

// ---- backfillLeagueHistory end to end, with fetch stubbed -------------------
{
  const realFetch = globalThis.fetch;
  let requests = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    requests.push(u);
    let body = {};
    if (u.includes('TYPE=league&')) {
      body = { league: { history: { league: [
        { year: '2025', url: 'https://www43.myfantasyleague.com/2025/home/11111' },
        { year: '2024', url: 'https://www43.myfantasyleague.com/2024/home/22222' },
      ] } } };
    } else if (u.includes('TYPE=leagueStandings')) {
      body = { leagueStandings: { franchise: [{ id: '0001' }, { id: '0002' }, { id: '0003' }] } };
    } else if (u.includes('TYPE=playoffBrackets')) {
      body = { playoffBrackets: {} }; // no brackets: placement falls back to regular-season order, a guess
    }
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };

  const makeLeague = () => ({
    id: '1', name: 'T', provider: 'mfl', type: 'dynasty', franchiseId: '0002', season: '2026',
  });
  try {
    const guessedRecently = { year: '2024', rank: 2, total: 3, guessed: true, triedAt: daysAgo(1) };
    const prev = new Map([['1', { id: '1', results: [{ year: '2025', rank: 1, total: 3, guessed: false, divisionWinnerFranchiseId: '0001' }, guessedRecently] }]]);

    // Sync, first look: the lookup runs (never checked), finds only a throttled guess, and records the check.
    let league = makeLeague();
    await backfillLeagueHistory([league], prev, 'cookie', { throttle: true, now: NOW });
    assert.equal(requests.length, 1, 'only the lookup is spent; the recently tried guess is not re-read');
    assert.deepEqual(league.historyCheck, { on: daysAgo(0), key: historyCheckKey(league) }, 'nothing eligible: the check is recorded');
    assert.equal(league.results.find((r) => r.year === '2024').triedAt, daysAgo(1), 'the guess keeps its original stamp');

    // Sync, next time: carried check, so no requests at all.
    requests = [];
    const prev2 = new Map([['1', { ...prev.get('1'), historyCheck: league.historyCheck }]]);
    league = makeLeague();
    await backfillLeagueHistory([league], prev2, 'cookie', { throttle: true, now: new Date(NOW.getTime() + 4 * 3600 * 1000) });
    assert.equal(requests.length, 0, 'a league checked this week costs the sync nothing');
    assert.deepEqual(league.historyCheck, prev2.get('1').historyCheck, 'the check carries forward untouched');

    // A week on, the guess is due: it is re-read, re-stamped, and the check is left unrecorded until the next lookup.
    requests = [];
    const later = new Date(NOW.getTime() + 8 * 86400000);
    league = makeLeague();
    await backfillLeagueHistory([league], prev2, 'cookie', { throttle: true, now: later });
    assert.ok(requests.length > 1, 'the due guess is fetched again');
    const reread = league.results.find((r) => r.year === '2024');
    assert.equal(reread.guessed, true, 'with no brackets it is still a guess');
    assert.equal(reread.triedAt, later.toISOString().slice(0, 10), 'and it is stamped with the new attempt');

    // On-demand: no throttle, so the recently tried guess is re-read and the lookup is never skipped.
    requests = [];
    league = makeLeague();
    await backfillLeagueHistory([league], prev2, 'cookie');
    assert.ok(requests.length > 1, 'the on-demand backfill ignores both the stamp and the carried check');
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---- the sync starts its non-MFL fetches before the MFL passes --------------
{
  const src = readFileSync(new URL('./fetch-rosters.mjs', import.meta.url), 'utf8');
  const mflPasses = src.indexOf('const leagues = [];');
  assert.ok(mflPasses > 0, 'found the roster pass');
  for (const name of ['depthChartsRead', 'nflStandingsRead', 'nflSchedulesRead', 'nflPowerRankingsRead', 'projectionsRead']) {
    const started = src.indexOf(`const ${name} =`);
    assert.ok(started > 0 && started < mflPasses, `${name} is started before the MFL passes`);
  }
  assert.ok(!/await (fetchAllDepthCharts|fetchNflStandings|fetchNflSchedules|fetchNflPowerRankings|fetchProjections)\(/.test(src),
    'none of those fetches is awaited inline again');
}

console.log('test-history-retry-throttle: ok');
