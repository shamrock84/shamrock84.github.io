// Pins how the sync treats an MFL host it cannot reach.
//
// Seen 2026-10-30: three leagues' MFL servers stopped accepting connections for
// about 85 seconds. Every request to them died after undici's ten-second connect
// timeout, and the sync made nine of them (roster, standings, scoring for two
// leagues, standings for a third) — a 36s sync became 100s, and the page's
// "Sync failing" row said only "fetch failed".
//
// Two fixes, both pinned here:
//   1. mflGet reports a rejected fetch as `MFL unreachable: <reason>` and flags
//      it `transport`, so the real cause (UND_ERR_CONNECT_TIMEOUT) is visible and
//      an HTTP error is still distinguishable from "no answer at all".
//   2. Once a league's host fails that way, the sync stops asking it for the rest
//      of the run — later passes and the history backfill fall back to the
//      previous snapshot, as a failed read already did, without waiting again.
//      HTTP errors (429/5xx/404) are NOT treated this way: those are answers.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mflGet, describeTransportError } from './lib/providers.mjs';
import { backfillLeagueHistory } from './fetch-rosters.mjs';

// ---- the readable reason ------------------------------------------------------
{
  const cause = (code) => Object.assign(new TypeError('fetch failed'), { cause: { code } });
  assert.equal(describeTransportError(cause('UND_ERR_CONNECT_TIMEOUT')), 'connect timeout');
  assert.equal(describeTransportError(cause('ETIMEDOUT')), 'connect timeout');
  assert.equal(describeTransportError(cause('ECONNRESET')), 'connection reset');
  assert.equal(describeTransportError(cause('ECONNREFUSED')), 'connection refused');
  assert.equal(describeTransportError(cause('ENOTFOUND')), 'DNS lookup failed');
  assert.equal(describeTransportError(cause('UND_ERR_HEADERS_TIMEOUT')), 'response timeout');
  assert.equal(describeTransportError(cause('EWHATEVER')), 'EWHATEVER', 'an unknown code is passed through, which still beats "fetch failed"');
  // A dual-stack connect timeout arrives as an AggregateError.
  assert.equal(
    describeTransportError(Object.assign(new TypeError('fetch failed'), { cause: { errors: [{ code: 'ETIMEDOUT' }] } })),
    'connect timeout'
  );
  assert.equal(describeTransportError(new TypeError('fetch failed')), 'fetch failed', 'with no cause at all, the message is all there is');
  assert.equal(describeTransportError(undefined), 'network error');
}

// ---- mflGet: no answer at all vs an HTTP answer ---------------------------------
const realFetch = globalThis.fetch;
try {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
  };
  const started = Date.now();
  await assert.rejects(
    mflGet('/export?TYPE=league&L=1&JSON=1', 'cookie', '2026'),
    (err) => {
      assert.equal(err.message, 'MFL unreachable: connect timeout', 'the reason is in the message the page shows');
      assert.equal(err.transport, true, 'flagged so the sync can tell it from an HTTP error');
      assert.equal(err.status, undefined, 'and it has no HTTP status');
      assert.equal(err.cause?.cause?.code, 'UND_ERR_CONNECT_TIMEOUT', 'the original error is kept');
      return true;
    }
  );
  assert.equal(calls, 1, 'a transport failure is not retried by mflGet (the 429 retry is for 429s only)');
  assert.ok(Date.now() - started < 500, 'and costs no backoff sleep');

  for (const status of [404, 500, 503]) {
    globalThis.fetch = async () => ({ ok: false, status, json: async () => ({}), text: async () => '' });
    await assert.rejects(mflGet('/export?TYPE=x', 'cookie', '2026'), (err) => {
      assert.equal(err.transport, undefined, `an HTTP ${status} is an answer, not a transport failure`);
      assert.equal(err.status, status);
      assert.match(err.message, new RegExp(`MFL request failed \\(${status}\\)`));
      return true;
    });
  }
} finally {
  globalThis.fetch = realFetch;
}

// ---- the backfill leaves an unreachable league alone, and keeps its data --------
{
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
  };
  try {
    const league = { id: '35217', name: 'Iron Bank', provider: 'mfl', type: 'salarycap', franchiseId: '0001', season: '2026' };
    const results = [{ year: '2025', rank: 3, total: 12, guessed: false, divisionWinnerFranchiseId: '0002' }];
    const historyCheck = { on: '2026-10-30', key: '2026|||salarycap|' };
    const prev = new Map([['35217', { id: '35217', results, historyCheck, historyBoundaryYear: '2012' }]]);

    await backfillLeagueHistory([league], prev, 'cookie', { skipLeagueIds: new Set(['35217']) });
    assert.equal(requests, 0, 'no request is made for a skipped league');
    assert.deepEqual(league.results, results, 'its recorded results are carried forward, not dropped from the snapshot');
    assert.deepEqual(league.historyCheck, historyCheck, 'and so is its history check');
    assert.equal(league.historyBoundaryYear, '2012');

    // Not skipped, the same league does make requests, so the zero above is the skip and not an empty fixture.
    const again = { ...league, results: undefined, historyCheck: undefined };
    await backfillLeagueHistory([again], prev, 'cookie', { skipLeagueIds: new Set(['someone-else']) });
    assert.ok(requests > 0, 'a league not in the skip set is still read');
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---- every pass that talks to MFL honours it -----------------------------------
{
  const src = readFileSync(new URL('./fetch-rosters.mjs', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('async function main()'));

  // Only a transport failure marks a league, never an HTTP error.
  const helper = body.slice(body.indexOf('const markUnreachable'), body.indexOf('};', body.indexOf('const markUnreachable')));
  assert.ok(/!err\?\.transport/.test(helper), 'markUnreachable only records transport failures');

  // The marks: the roster pass and each later pass.
  for (const label of ['Failed to fetch ${league.name}', 'Failed to fetch standings', 'Failed to fetch scoring', 'Failed to fetch lineup']) {
    const at = body.indexOf(label);
    assert.ok(at > 0, `found the "${label}" handler`);
    assert.ok(body.slice(at, at + 200).includes('markUnreachable(league, err)'), `${label}: a transport failure marks the league`);
  }

  // The guards: each later pass checks before it fetches.
  for (const call of ['fetchStandings(league, cookie', 'fetchScoring(league, cookie', 'fetchMflLineup(league, cookie']) {
    const callAt = body.indexOf(call);
    assert.ok(callAt > 0, `found ${call}`);
    const tryAt = body.lastIndexOf('try {', callAt);
    assert.ok(body.slice(tryAt, callAt).includes('unreachable.has(league.id)'), `${call}: skipped for an unreachable league`);
  }
  const availability = body.slice(body.indexOf('if (league.provider === \'sleeper\' || target.rosteredNames) continue;') - 220, body.indexOf('if (league.provider === \'sleeper\' || target.rosteredNames) continue;'));
  assert.ok(availability.includes('unreachable.has(league.id)'), 'the free-agent/draft-status pass skips it too');
  assert.ok(/skipLeagueIds:\s*new Set\(unreachable\.keys\(\)\)/.test(body), 'and so does the history backfill');

  // Falling back is the existing degrade path, not a new one.
  const standings = body.slice(body.indexOf('Failed to fetch standings'), body.indexOf('Failed to fetch standings') + 400);
  assert.ok(/prev\?\.standings/.test(standings), 'standings fall back to the previous snapshot');
}

console.log('test-unreachable-host: ok');
