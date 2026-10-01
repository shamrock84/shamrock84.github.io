// Unit tests for the Waivers tab: the provider parsers behind it
// (scripts/lib/providers.mjs, "Waivers & auctions") and api/waivers.js.
//
// The shapes pinned here are NOT confirmed against this project's own
// leagues yet — see that section's header and probe-waivers-auctions.yml.
// What this pins is the posture, which holds whatever the probe finds:
//
//   * every addsDrops form seen in the wild parses (blind bid with and
//     without drops, drop-only, rolling priority add|drop);
//   * pendingWaivers records are found by SHAPE, so a blind-bid league's
//     `blindBidWaiverRequest` reads the same as a rolling `waiverRequest`;
//   * an MFL error body throws rather than reading as "nothing pending";
//   * an auction is open until an AUCTION_WON for that player, the high bid
//     and bidder are the LATEST bid's, and a re-opened player counts again;
//   * ESPN keeps only this team's still-pending WAIVER transactions;
//   * the endpoint refuses without a valid token, never offers Draft Only,
//     reports Sleeper as unsupported rather than empty, and one league's
//     failure never blanks the rest.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.ESPN_S2 = 'x';
process.env.ESPN_SWID = '{y}';
process.env.MFL_USERNAME = 'u';
process.env.MFL_PASSWORD = 'p';
process.env.SESSION_SECRET = 'secret';

const {
  parseMflAddsDrops,
  parseMflPendingWaivers,
  activeMflAuctions,
  parseEspnPendingWaivers,
  fetchMflPendingWaivers,
} = await import('./lib/providers.mjs');

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
};

await test('addsDrops: blind bid add with no drop', () => {
  assert.deepEqual(parseMflAddsDrops('8851,|425000|'), { adds: ['8851'], bid: 425000, drops: [] });
});
await test('addsDrops: blind bid add with two drops', () => {
  assert.deepEqual(parseMflAddsDrops('14063,|425000|15777,16191,'), { adds: ['14063'], bid: 425000, drops: ['15777', '16191'] });
});
await test('addsDrops: drop only', () => {
  assert.deepEqual(parseMflAddsDrops('|17064,16191,'), { adds: [], bid: null, drops: ['17064', '16191'] });
});
await test('addsDrops: rolling priority add|drop', () => {
  assert.deepEqual(parseMflAddsDrops('14063,|15777,'), { adds: ['14063'], bid: null, drops: ['15777'] });
});
await test('addsDrops: a $0 bid survives as 0, not null', () => {
  assert.equal(parseMflAddsDrops('8851,|0|').bid, 0);
});
await test('addsDrops: empty or non-string is null', () => {
  assert.equal(parseMflAddsDrops(''), null);
  assert.equal(parseMflAddsDrops(undefined), null);
});

await test('pendingWaivers: blind-bid record found by shape, single object', () => {
  const claims = parseMflPendingWaivers({
    pendingWaivers: { blindBidWaiverRequest: { timestamp: '1788478227', round: '1', addsDrops: '16778,|12|13593,', comments: '' } },
  });
  assert.deepEqual(claims, [{ round: '1', bid: 12, adds: ['16778'], drops: ['13593'], timestamp: 1788478227 }]);
});
await test('pendingWaivers: rolling records in an array keep MFL order', () => {
  const claims = parseMflPendingWaivers({
    pendingWaivers: { waiverRequest: [{ round: '1', addsDrops: '1,|2,' }, { round: '2', addsDrops: '3,|' }] },
  });
  assert.deepEqual(claims.map((c) => c.adds[0]), ['1', '3']);
  assert.deepEqual(claims.map((c) => c.round), ['1', '2']);
});
await test('pendingWaivers: no claims reads as empty', () => {
  assert.deepEqual(parseMflPendingWaivers({ pendingWaivers: {} }), []);
  assert.deepEqual(parseMflPendingWaivers({}), []);
});
await test('pendingWaivers: an MFL error body throws, never reads as empty', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { $t: 'Requires owner access' } }), { status: 200 });
  try {
    await assert.rejects(
      fetchMflPendingWaivers({ id: '1', franchiseId: '0001' }, 'c', { league: { baseURL: 'https://www43.myfantasyleague.com' } }),
      /Requires owner access/
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

await test('auctions: open until won; high bid is the latest', () => {
  const open = activeMflAuctions({
    transactions: {
      transaction: [
        { type: 'AUCTION_INIT', franchise: '0001', transaction: '100|5|', timestamp: '10' },
        { type: 'AUCTION_BID', franchise: '0002', transaction: '100|7|', timestamp: '20' },
        { type: 'AUCTION_INIT', franchise: '0003', transaction: '200|1|', timestamp: '15' },
        { type: 'AUCTION_WON', franchise: '0003', transaction: '200|1|', timestamp: '30' },
        { type: 'FREE_AGENT', franchise: '0004', transaction: '300,|', timestamp: '40' },
      ],
    },
  });
  assert.equal(open.length, 1);
  assert.deepEqual(open[0], { playerId: '100', bid: 7, franchiseId: '0002', startedAt: 10, lastBidAt: 20, bids: 2 });
});
await test('auctions: a single transaction object (not an array) still reads', () => {
  const open = activeMflAuctions({ transactions: { transaction: { type: 'AUCTION_INIT', franchise: '0001', transaction: '9|3|hi', timestamp: '5' } } });
  assert.equal(open[0].playerId, '9');
  assert.equal(open[0].bid, 3);
});
await test('auctions: out-of-order log is sorted by timestamp before folding', () => {
  const open = activeMflAuctions({
    transactions: {
      transaction: [
        { type: 'AUCTION_WON', franchise: '0002', transaction: '100|7|', timestamp: '30' },
        { type: 'AUCTION_INIT', franchise: '0001', transaction: '100|5|', timestamp: '10' },
      ],
    },
  });
  assert.equal(open.length, 0);
});

await test('ESPN: only this team, only pending waivers', () => {
  const claims = parseEspnPendingWaivers({
    transactions: [
      { type: 'WAIVER', status: 'PENDING', teamId: 5, bidAmount: 11, subOrder: 1, items: [{ type: 'ADD', playerId: 1 }, { type: 'DROP', playerId: 2 }] },
      { type: 'WAIVER', status: 'PENDING', teamId: 5, bidAmount: 0, subOrder: 0, items: [{ type: 'ADD', playerId: 3 }] },
      { type: 'WAIVER', status: 'PENDING', teamId: 6, items: [{ type: 'ADD', playerId: 4 }] },
      { type: 'WAIVER', status: 'EXECUTED', teamId: 5, items: [{ type: 'ADD', playerId: 5 }] },
      { type: 'FREEAGENT', status: 'PENDING', teamId: 5, items: [{ type: 'ADD', playerId: 6 }] },
    ],
  }, '5');
  assert.deepEqual(claims.map((c) => c.adds), [['3'], ['1']]);
  assert.deepEqual(claims[1].drops, ['2']);
  assert.equal(claims[0].bid, 0);
});

// --- api/waivers.js ---
const { default: handler, waiversKindFor } = await import('../api/waivers.js');
const { createToken } = await import('../api/lib/auth.mjs');

function mockRes() {
  return {
    statusCode: 200, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { return this; },
  };
}

await test('endpoint: rejects a missing or bad token', async () => {
  const res = mockRes();
  await handler({ method: 'GET', headers: { authorization: 'Bearer nope' } }, res);
  assert.equal(res.statusCode, 401);
});

await test('kind: salary cap is auctions, draft only is nothing, the rest waivers', () => {
  assert.equal(waiversKindFor({ type: 'salarycap' }), 'auctions');
  assert.equal(waiversKindFor({ type: 'draftonly' }), null);
  assert.equal(waiversKindFor({ type: 'dynasty' }), 'waivers');
  assert.equal(waiversKindFor({ type: 'redraft', provider: 'espn' }), 'waivers');
});

await test('endpoint: every non-draftonly league answered; failures isolated; Sleeper unsupported', async () => {
  const config = JSON.parse(readFileSync(fileURLToPath(new URL('../config/leagues.json', import.meta.url)), 'utf8'));
  const expected = config.leagues.filter((l) => l.type !== 'draftonly');
  const firstMfl = expected.find((l) => (l.provider || 'mfl') === 'mfl' && l.type !== 'salarycap');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/login')) return new Response('', { status: 200, headers: { 'set-cookie': 'MFL_USER_ID=abc; path=/' } });
    if (u.includes('TYPE=players')) return new Response(JSON.stringify({ players: { player: [{ id: '16778', name: 'Doe, John', position: 'WR', team: 'KCC' }] } }));
    if (u.includes('TYPE=league&')) return new Response(JSON.stringify({ league: { baseURL: 'https://www43.myfantasyleague.com', franchises: { franchise: [{ id: '0002', name: 'Rival' }] } } }));
    if (u.includes('TYPE=pendingWaivers')) {
      if (u.includes(`L=${firstMfl.id}&`)) return new Response('boom', { status: 500 });
      return new Response(JSON.stringify({ pendingWaivers: { blindBidWaiverRequest: { round: '1', addsDrops: '16778,|12|' } } }));
    }
    if (u.includes('TYPE=transactions')) return new Response(JSON.stringify({ transactions: { transaction: [{ type: 'AUCTION_BID', franchise: '0002', transaction: '16778|9|', timestamp: '100' }] } }));
    if (u.includes('view=mStatus')) return new Response(JSON.stringify({ scoringPeriodId: 4 }));
    if (u.includes('view=mTransactions2')) return new Response(JSON.stringify({ transactions: [] }));
    if (u.includes('view=kona_player_info')) return new Response(JSON.stringify({ players: [] }));
    throw new Error(`unexpected fetch ${u}`);
  };
  try {
    const res = mockRes();
    await handler({ method: 'GET', headers: { authorization: `Bearer ${createToken('secret')}` } }, res);
    assert.equal(res.statusCode, 200);
    const byId = new Map(res.body.leagues.map((l) => [l.id, l]));
    assert.deepEqual([...byId.keys()].sort(), expected.map((l) => l.id).sort());
    assert.ok(byId.get(firstMfl.id).error, 'the failing league reports an error');
    for (const l of expected) {
      const r = byId.get(l.id);
      if (l.id === firstMfl.id) continue;
      if (l.provider === 'sleeper') { assert.ok(r.unsupported); continue; }
      assert.ok(!r.error, `${l.id} should not error: ${r.error}`);
      if (l.type === 'salarycap') {
        assert.equal(r.auctions[0].player.name, 'John Doe');
        assert.equal(r.auctions[0].franchiseName, 'Rival');
        assert.equal(r.auctions[0].mine, l.franchiseId === '0002');
      } else if ((l.provider || 'mfl') === 'mfl') {
        assert.equal(r.claims[0].adds[0].name, 'John Doe');
        assert.equal(r.claims[0].bid, 12);
      } else {
        assert.deepEqual(r.claims, []);
      }
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- myffl.html ---
const html = readFileSync(fileURLToPath(new URL('../myffl.html', import.meta.url)), 'utf8');
await test('page: Waivers sits between Scores and Standings', () => {
  const order = html.match(/const VIEW_ORDER = \[([^\]]*)\]/)[1];
  assert.match(order, /'scoring', 'waivers', 'standings'/);
});
await test('page: the Waivers cards are built only when logged in', () => {
  assert.match(html, /if \(isLoggedIn\(\)\) \{\s*for \(const kind of \['waivers', 'auctions'\]\)/);
});
await test('page: logout forgets the last read', () => {
  const logout = html.match(/function doLogout\(\) \{[\s\S]*?\n\t\t\}/)[0];
  assert.match(logout, /waiversState = \{ status: 'idle', data: null/);
});

console.log(`\n${passed} passed`);
