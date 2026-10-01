// Unit tests for the Waivers tab: the provider parsers behind it
// (scripts/lib/providers.mjs, "Waivers & auctions") and api/waivers.js.
//
// The MFL and ESPN shapes pinned here were confirmed against our own leagues
// by probe-waivers-auctions.yml RUN 1; see that probe's header. This pins:
//
//   * both addsDrops forms probe RUN 1 saw on our leagues parse (rolling
//     add_drop pairs, blind-bid add_bid_drop), and anything else is
//     refused rather than rendered as a garbled id;
//   * pendingWaivers records are found by SHAPE, so a blind-bid league's
//     `blindBidWaiverRequest` reads the same as a rolling `waiverRequest`;
//   * an MFL error body throws rather than reading as "nothing pending";
//   * an auction is open until an AUCTION_WON for that player, the high bid
//     and bidder are the LATEST bid's, and a re-opened player counts again;
//   * an auction ends 24h after the high bidder CHANGED — a different bidder
//     restarts the clock, the same bidder raising does not — and the Auctions
//     card's "Over In" is that, soonest-ending first;
//   * ESPN keeps only this team's still-pending WAIVER transactions, and
//     names come from the season-wide player list RUN 3 found working;
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
  finishedMflAuctions,
  AUCTION_END_HOURS,
  parseEspnPendingWaivers,
  fetchEspnPendingWaivers,
  fetchMflPendingWaivers,
  fetchEspnPlayerNames,
} = await import('./lib/providers.mjs');

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
};

// The two forms probe-waivers-auctions.yml RUN 1 actually saw on our leagues.
await test('addsDrops: rolling priority, comma-separated add_drop pairs (MNMx)', () => {
  assert.deepEqual(parseMflAddsDrops('16778_13593,9431_8812'), [
    { adds: ['16778'], bid: null, drops: ['13593'] },
    { adds: ['9431'], bid: null, drops: ['8812'] },
  ]);
});
await test('addsDrops: blind bid add_bid_drop (OSD, Survivor)', () => {
  assert.deepEqual(parseMflAddsDrops('16778_12_13593'), [{ adds: ['16778'], bid: 12, drops: ['13593'] }]);
});
await test('addsDrops: an all-zero drop means none', () => {
  assert.deepEqual(parseMflAddsDrops('16778_12_0000'), [{ adds: ['16778'], bid: 12, drops: [] }]);
});
await test('addsDrops: a $0 bid survives as 0, not null', () => {
  assert.equal(parseMflAddsDrops('16778_0_13593')[0].bid, 0);
});
// The pipe form another public client reported; never seen on ours, still accepted.
await test('addsDrops: pipe form still parses', () => {
  assert.deepEqual(parseMflAddsDrops('14063,|425000|15777,16191,'), [{ adds: ['14063'], bid: 425000, drops: ['15777', '16191'] }]);
  assert.deepEqual(parseMflAddsDrops('|17064,'), [{ adds: [], bid: null, drops: ['17064'] }]);
});
await test('addsDrops: anything yielding non-numeric ids is null, never a garbled id', () => {
  assert.equal(parseMflAddsDrops(''), null);
  assert.equal(parseMflAddsDrops(undefined), null);
  assert.equal(parseMflAddsDrops('16778-13593'), null);
  assert.equal(parseMflAddsDrops('a_b_c_d'), null);
});

await test('pendingWaivers: blind-bid record found by shape, single object', () => {
  const claims = parseMflPendingWaivers({
    pendingWaivers: { blindBidWaiverRequest: { timestamp: '1788478227', round: '1', addsDrops: '16778_12_13593', comments: '' } },
  });
  assert.deepEqual(claims, [{ round: '1', bid: 12, adds: ['16778'], drops: ['13593'], timestamp: 1788478227 }]);
});
await test('pendingWaivers: rolling records in an array, each pair its own row, MFL order kept', () => {
  const claims = parseMflPendingWaivers({
    pendingWaivers: { waiverRequest: [{ round: '1', addsDrops: '1_2,3_4' }, { round: '2', addsDrops: '5_0000' }] },
  });
  assert.deepEqual(claims.map((c) => c.adds[0]), ['1', '3', '5']);
  assert.deepEqual(claims.map((c) => c.round), ['1', '1', '2']);
  assert.deepEqual(claims[2].drops, []);
});
await test('pendingWaivers: an unrecognised claim string throws rather than vanishing', () => {
  assert.throws(() => parseMflPendingWaivers({ pendingWaivers: { waiverRequest: { addsDrops: 'garbage' } } }), /doesn.t recognise/);
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
  assert.deepEqual(open[0], {
    playerId: '100', bid: 7, franchiseId: '0002', startedAt: 10, lastBidAt: 20,
    highBidderSince: 20, endsAt: 20 + 24 * 3600, bids: 2,
  });
});

// The league rule, as the manager states it: 24 hours after the high bidder
// CHANGED. RUN 4 found closes as little as 15 minutes after the last bid,
// which only makes sense if a bidder raising their own bid doesn't restart it.
const H = 3600;
await test('auction clock: starts at nomination', () => {
  const [a] = activeMflAuctions({ transactions: { transaction: [
    { type: 'AUCTION_INIT', franchise: '0001', transaction: '7|1|', timestamp: String(100 * H) },
  ] } });
  assert.equal(AUCTION_END_HOURS, 24);
  assert.equal(a.endsAt, 100 * H + 24 * H);
});
await test('auction clock: a DIFFERENT bidder restarts it', () => {
  const [a] = activeMflAuctions({ transactions: { transaction: [
    { type: 'AUCTION_INIT', franchise: '0001', transaction: '7|1|', timestamp: String(100 * H) },
    { type: 'AUCTION_BID', franchise: '0002', transaction: '7|3|', timestamp: String(110 * H) },
  ] } });
  assert.equal(a.franchiseId, '0002');
  assert.equal(a.endsAt, 110 * H + 24 * H);
});
await test('auction clock: the SAME bidder raising does NOT restart it', () => {
  const [a] = activeMflAuctions({ transactions: { transaction: [
    { type: 'AUCTION_INIT', franchise: '0001', transaction: '7|1|', timestamp: String(100 * H) },
    { type: 'AUCTION_BID', franchise: '0002', transaction: '7|3|', timestamp: String(110 * H) },
    { type: 'AUCTION_BID', franchise: '0002', transaction: '7|9|', timestamp: String(120 * H) },
  ] } });
  assert.equal(a.bid, 9);
  assert.equal(a.lastBidAt, 120 * H);
  assert.equal(a.highBidderSince, 110 * H);
  assert.equal(a.endsAt, 110 * H + 24 * H);
});
await test('auction clock: the original bidder coming back after losing it restarts it', () => {
  const [a] = activeMflAuctions({ transactions: { transaction: [
    { type: 'AUCTION_INIT', franchise: '0001', transaction: '7|1|', timestamp: String(100 * H) },
    { type: 'AUCTION_BID', franchise: '0002', transaction: '7|3|', timestamp: String(105 * H) },
    { type: 'AUCTION_BID', franchise: '0001', transaction: '7|4|', timestamp: String(110 * H) },
  ] } });
  assert.equal(a.endsAt, 110 * H + 24 * H);
});
await test('auctions: soonest-ending first', () => {
  const open = activeMflAuctions({ transactions: { transaction: [
    { type: 'AUCTION_INIT', franchise: '0001', transaction: '1|1|', timestamp: String(300 * H) },
    { type: 'AUCTION_INIT', franchise: '0001', transaction: '2|1|', timestamp: String(100 * H) },
    { type: 'AUCTION_INIT', franchise: '0001', transaction: '3|1|', timestamp: String(200 * H) },
  ] } });
  assert.deepEqual(open.map((a) => a.playerId), ['2', '3', '1']);
});
await test('auctions: a closed auction carries its won time beside the predicted end, and a re-nomination starts fresh', () => {
  const log = { transactions: { transaction: [
    { type: 'AUCTION_INIT', franchise: '0001', transaction: '7|1|', timestamp: String(100 * H) },
    { type: 'AUCTION_BID', franchise: '0002', transaction: '7|3|', timestamp: String(110 * H) },
    { type: 'AUCTION_WON', franchise: '0002', transaction: '7|3|', timestamp: String(134 * H) },
    { type: 'AUCTION_INIT', franchise: '0003', transaction: '7|1|', timestamp: String(200 * H) },
  ] } };
  const [f] = finishedMflAuctions(log);
  assert.equal(f.endsAt, 134 * H);
  assert.equal(f.wonAt, 134 * H);
  assert.equal(activeMflAuctions(log)[0].highBidderSince, 200 * H);
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

const T = 3600 * 1000;
const claim = (extra) => ({ type: 'WAIVER', teamId: 5, bidAmount: 0, rating: 0, ...extra });
const item = (add, drop) => [{ type: 'ADD', playerId: add }, ...(drop ? [{ type: 'DROP', playerId: drop }] : [])];

await test('ESPN: only this team, only WAIVER claims still pending, oldest first', () => {
  const claims = parseEspnPendingWaivers({
    transactions: [
      claim({ status: 'PENDING', isPending: true, proposedDate: 20 * T, items: item(1, 2) }),
      claim({ status: 'PENDING', isPending: true, proposedDate: 10 * T, items: item(3) }),
      claim({ status: 'PENDING', teamId: 6, proposedDate: 5 * T, items: item(4) }),
      claim({ status: 'EXECUTED', proposedDate: 5 * T, items: item(5) }),
      { type: 'FREEAGENT', status: 'PENDING', teamId: 5, items: item(6) },
    ],
  }, '5');
  assert.deepEqual(claims.map((c) => c.adds), [['3'], ['1']]);
  assert.deepEqual(claims[1].drops, ['2']);
});

// RUN 6, League 1 and League 2, exactly as the probe saw them: ESPN leaves the
// original PENDING record and writes a separate processed twin (same adds and
// drops, later processDate). Reading status alone showed these as pending
// for 40+ hours after they resolved.
await test('ESPN: a PENDING record with a processed twin is resolved, not pending (RUN 6)', () => {
  const log = { transactions: [
    // League 2: four claims dropping the same player; one executed, three failed.
    claim({ status: 'PENDING', isPending: true, proposedDate: 100 * T, items: item(30, 99) }),
    claim({ status: 'PENDING', isPending: true, proposedDate: 100 * T + 1, items: item(40, 99) }),
    claim({ status: 'PENDING', isPending: true, proposedDate: 101 * T, items: item(50, 99) }),
    claim({ status: 'PENDING', isPending: true, proposedDate: 101 * T + 1, items: item(60, 99) }),
    claim({ status: 'FAILED_INVALIDPLAYERSOURCE', proposedDate: 110 * T, processDate: 110 * T, items: item(30, 99) }),
    claim({ status: 'EXECUTED', proposedDate: 110 * T, processDate: 110 * T, items: item(40, 99) }),
    claim({ status: 'FAILED_PLAYERALREADYDROPPED', proposedDate: 110 * T, processDate: 110 * T, items: item(50, 99) }),
    claim({ status: 'FAILED_PLAYERALREADYDROPPED', proposedDate: 110 * T, processDate: 110 * T, items: item(60, 99) }),
  ] };
  assert.deepEqual(parseEspnPendingWaivers(log, '5'), []);
});
await test('ESPN: the same claim filed again AFTER it processed is genuinely pending', () => {
  const claims = parseEspnPendingWaivers({ transactions: [
    claim({ status: 'FAILED_INVALIDPLAYERSOURCE', proposedDate: 100 * T, processDate: 100 * T, items: item(30, 99) }),
    claim({ status: 'PENDING', isPending: true, proposedDate: 120 * T, items: item(30, 99) }),
  ] }, '5');
  assert.equal(claims.length, 1);
  assert.deepEqual(claims[0].adds, ['30']);
});
await test('ESPN: a processed record for a DIFFERENT player or drop does not resolve a claim', () => {
  const log = { transactions: [
    claim({ status: 'EXECUTED', proposedDate: 110 * T, processDate: 110 * T, items: item(31, 99) }),
    claim({ status: 'EXECUTED', proposedDate: 110 * T, processDate: 110 * T, items: item(30, 98) }),
    claim({ status: 'PENDING', isPending: true, proposedDate: 100 * T, items: item(30, 99) }),
  ] };
  assert.equal(parseEspnPendingWaivers(log, '5').length, 1);
});
await test('ESPN: a processed record belonging to ANOTHER team never resolves mine', () => {
  const log = { transactions: [
    claim({ teamId: 6, status: 'EXECUTED', proposedDate: 110 * T, processDate: 110 * T, items: item(30, 99) }),
    claim({ status: 'PENDING', isPending: true, proposedDate: 100 * T, items: item(30, 99) }),
  ] };
  assert.equal(parseEspnPendingWaivers(log, '5').length, 1);
});

// RUN 6: acquisitionType WAIVERS_TRADITIONAL, isUsingAcquisitionBudget false,
// every bidAmount 0, waiverRank 10 / 6. A bid is for a league that bids.
await test('ESPN: a non-FAAB league shows the team’s waiver priority, never a $0 bid', () => {
  const log = { transactions: [claim({ status: 'PENDING', isPending: true, proposedDate: 100 * T, items: item(30, 99) })] };
  const [c] = parseEspnPendingWaivers(log, '5', { faab: false, priority: 10 });
  assert.equal(c.bid, null);
  assert.equal(c.priority, 10);
});
await test('ESPN: a FAAB league shows the bid and no priority', () => {
  const log = { transactions: [claim({ status: 'PENDING', isPending: true, bidAmount: 12, proposedDate: 100 * T, items: item(30, 99) })] };
  const [c] = parseEspnPendingWaivers(log, '5', { faab: true, priority: 10 });
  assert.equal(c.bid, 12);
  assert.equal(c.priority, null);
});
await test('ESPN: settings unreadable (faab unknown) shows a bid only when it is above zero', () => {
  const mk = (bid) => ({ transactions: [claim({ status: 'PENDING', isPending: true, bidAmount: bid, proposedDate: 1, items: item(30) })] });
  assert.equal(parseEspnPendingWaivers(mk(0), '5', { faab: null, priority: 4 })[0].bid, null);
  assert.equal(parseEspnPendingWaivers(mk(0), '5', { faab: null, priority: 4 })[0].priority, 4);
  assert.equal(parseEspnPendingWaivers(mk(7), '5', { faab: null })[0].bid, 7);
});
await test('ESPN: no readable waiver rank leaves priority null, not 0 or NaN', () => {
  const log = { transactions: [claim({ status: 'PENDING', isPending: true, proposedDate: 1, items: item(30) })] };
  assert.equal(parseEspnPendingWaivers(log, '5', { faab: false })[0].priority, null);
});

await test('ESPN: fetch reads the four views, folds in mPendingTransactions deduped by id, and survives optional failures', async () => {
  const realFetch = globalThis.fetch;
  const seenViews = [];
  const settingsFails = { v: false };
  globalThis.fetch = async (url) => {
    const u = String(url);
    const view = (u.match(/view=(m\w+)/) || [])[1];
    seenViews.push(view);
    if (view === 'mStatus') return new Response(JSON.stringify({ scoringPeriodId: 4 }));
    if (view === 'mTransactions2') return new Response(JSON.stringify({ transactions: [
      claim({ id: 'old', status: 'PENDING', isPending: true, proposedDate: 100 * T, items: item(30, 99) }),
      claim({ id: 'old-twin', status: 'EXECUTED', proposedDate: 110 * T, processDate: 110 * T, items: item(30, 99) }),
      claim({ id: 'live', status: 'PENDING', isPending: true, proposedDate: 120 * T, items: item(40) }),
    ] }));
    if (view === 'mPendingTransactions') return new Response(JSON.stringify({ pendingTransactions: [
      claim({ id: 'live', status: 'PENDING', isPending: true, proposedDate: 120 * T, items: item(40) }),
    ] }));
    if (view === 'mSettings') {
      if (settingsFails.v) return new Response('nope', { status: 500 });
      return new Response(JSON.stringify({ settings: { acquisitionSettings: { isUsingAcquisitionBudget: false } } }));
    }
    if (view === 'mTeam') return new Response(JSON.stringify({ teams: [{ id: 5, waiverRank: 6 }, { id: 6, waiverRank: 1 }] }));
    throw new Error(`unexpected fetch ${u}`);
  };
  try {
    const claims = await fetchEspnPendingWaivers({ id: '1', franchiseId: '5' });
    assert.deepEqual(seenViews.sort(), ['mPendingTransactions', 'mSettings', 'mStatus', 'mTeam', 'mTransactions2']);
    assert.equal(claims.length, 1, 'the stale one is gone, the live one is listed once');
    assert.deepEqual(claims[0].adds, ['40']);
    assert.equal(claims[0].priority, 6);
    assert.equal(claims[0].bid, null);
    // Settings and the pending view are optional: a failure never costs the claims.
    settingsFails.v = true;
    const again = await fetchEspnPendingWaivers({ id: '1', franchiseId: '5' });
    assert.equal(again.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// The request probe RUN 3 found working: the season-wide player list,
// filtered by id in the x-fantasy-filter header. The league-scoped
// kona_player_info this shipped with answered HTTP 400 on both leagues.
await test('ESPN names: season-wide players_wl, filtered by id, flat entries', async () => {
  const realFetch = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (url, opts) => {
    seen = { url: String(url), headers: opts.headers };
    return new Response(JSON.stringify([
      { id: 4431611, fullName: 'Caleb Williams', defaultPositionId: 1, proTeamId: 3 },
      { id: 99, fullName: 'Someone Else', defaultPositionId: 3, proTeamId: 0 },
    ]));
  };
  try {
    const names = await fetchEspnPlayerNames({ id: '1', season: '2026' }, ['4431611', '99', '4431611']);
    assert.match(seen.url, /\/seasons\/2026\/players\?view=players_wl$/);
    assert.doesNotMatch(seen.url, /leagues/);
    assert.deepEqual(JSON.parse(seen.headers['x-fantasy-filter']), { filterIds: { value: [4431611, 99] } });
    assert.deepEqual(names.get('4431611'), { name: 'Caleb Williams', position: 'QB', team: 'CHI' });
    assert.equal(names.get('99').team, 'FA');
  } finally {
    globalThis.fetch = realFetch;
  }
});
await test('ESPN names: a failed lookup is an empty map, never a thrown claim read', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"messages":["bad"]}', { status: 400 });
  try {
    assert.equal((await fetchEspnPlayerNames({ id: '1' }, ['5'])).size, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- api/waivers.js ---
const { default: handler, waiversKindFor } = await import('../api/waivers.js');
const { YEAR, mflAuctionPageUrl } = await import('./lib/providers.mjs');
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
      return new Response(JSON.stringify({ pendingWaivers: { blindBidWaiverRequest: { round: '1', addsDrops: '16778_12_0000' } } }));
    }
    if (u.includes('TYPE=transactions')) return new Response(JSON.stringify({ transactions: { transaction: [{ type: 'AUCTION_BID', franchise: '0002', transaction: '16778|9|', timestamp: '100' }] } }));
    if (u.includes('view=mStatus')) return new Response(JSON.stringify({ scoringPeriodId: 4 }));
    if (u.includes('view=mTransactions2')) return new Response(JSON.stringify({ transactions: [] }));
    if (u.includes('view=mPendingTransactions')) return new Response(JSON.stringify({}));
    if (u.includes('view=mSettings')) return new Response(JSON.stringify({ settings: { acquisitionSettings: { isUsingAcquisitionBudget: false } } }));
    if (u.includes('view=mTeam')) return new Response(JSON.stringify({ teams: [] }));
    if (u.includes('/players?view=players_wl')) return new Response(JSON.stringify([]));
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
        // The league's own regional host, the MFL auctions page (O=43).
        assert.equal(r.url, `https://www43.myfantasyleague.com/${YEAR}/options?L=${l.id}&O=43`);
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
// The page's "Over in" wording, run from the page's own source.
const timeLeftSrc = html.match(/function formatAuctionTimeLeft\(([^\n]*)\) \{\n([\s\S]*?)\n\t\t\}/);
const formatLeft = new Function(timeLeftSrc[1], timeLeftSrc[2]);
await test('page: the Auctions column is "Over In", not "Last Bid"', () => {
  assert.match(html, /el\('th', \{ text: 'Over In' \}\)/);
  assert.doesNotMatch(html, /text: 'Last Bid'/);
});
await test('page: time left is worded hours/minutes, days past a day, and never negative', () => {
  const now = Date.UTC(2026, 9, 1, 12, 0, 0);
  const left = (sec) => formatLeft((now + sec * 1000) / 1000, now);
  assert.equal(left(5 * 3600 + 12 * 60 + 30), '5h 12m');
  assert.equal(left(42 * 60 + 5), '42m');
  assert.equal(left(26 * 3600), '1d 2h');
  assert.equal(left(20), 'Ending');
  assert.equal(left(-9 * 3600), 'Ending');
  assert.equal(formatLeft(null, now), '\u2014');
  assert.equal(formatLeft(undefined, now), '\u2014');
});
await test('auction page URL: the manager\u2019s own Iron Bank example, on the league\u2019s regional host', () => {
  assert.equal(
    mflAuctionPageUrl({ id: '35217', season: '2026' }, { league: { baseURL: 'https://www46.myfantasyleague.com' } }),
    'https://www46.myfantasyleague.com/2026/options?L=35217&O=43'
  );
  // A trailing slash on baseURL doesn't double up, and no baseURL falls back to the generic host.
  assert.equal(
    mflAuctionPageUrl({ id: '35217', season: '2026' }, { league: { baseURL: 'https://www46.myfantasyleague.com/' } }),
    'https://www46.myfantasyleague.com/2026/options?L=35217&O=43'
  );
  assert.equal(mflAuctionPageUrl({ id: '35217', season: '2026' }, null), 'https://www.myfantasyleague.com/2026/options?L=35217&O=43');
});
const pageUrlSrc = html.match(/function auctionPageUrl\(([^\n]*)\) \{\n([\s\S]*?)\n\t\t\}/);
const auctionPageUrl = new Function(pageUrlSrc[1], pageUrlSrc[2]);
await test('page: the Auctions league link prefers the endpoint\u2019s address, else rebuilds it from the home link', () => {
  const league = { id: '35217', url: 'https://www.myfantasyleague.com/2026/home/35217' };
  assert.equal(auctionPageUrl(league, { url: 'https://www46.myfantasyleague.com/2026/options?L=35217&O=43' }), 'https://www46.myfantasyleague.com/2026/options?L=35217&O=43');
  assert.equal(auctionPageUrl(league, undefined), 'https://www.myfantasyleague.com/2026/options?L=35217&O=43');
  assert.equal(auctionPageUrl({ id: '1' }, null), null);
});
await test('page: only the Auctions card links to the auctions page; Waivers keeps the league home link', () => {
  assert.match(html, /kind === 'auctions' \? auctionPageUrl\(league, r\) : league\.url/);
});
const claimOrderSrc = html.match(/function formatClaimOrder\(([^\n]*)\) \{\n([\s\S]*?)\n\t\t\}/);
const fmtBid = (n) => (n == null ? '' : `$${Number(n).toLocaleString()}`);
const formatClaimOrder = (item) => new Function('formatBid', claimOrderSrc[1], claimOrderSrc[2])(fmtBid, item);
await test('page: a claim\u2019s last column is a bid only where the league bids, else priority, else round', () => {
  assert.equal(formatClaimOrder({ bid: 12 }), '$12');
  assert.equal(formatClaimOrder({ bid: 0 }), '$0', 'a real $0 blind bid survives');
  assert.equal(formatClaimOrder({ bid: null, priority: 10 }), 'Priority 10');
  assert.equal(formatClaimOrder({ bid: null, round: '2' }), 'Round 2');
  assert.equal(formatClaimOrder({ bid: null }), '\u2014');
  assert.match(html, /el\('th', \{ text: 'Bid \/ Priority' \}\)/);
});
await test('page: logout forgets the last read', () => {
  const logout = html.match(/function doLogout\(\) \{[\s\S]*?\n\t\t\}/)[0];
  assert.match(logout, /waiversState = \{ status: 'idle', data: null/);
});

// Cap room beside each Auctions league name: the SAME numbers the Rosters
// card's cap summary uses, pulled out of the page source so the two can't
// drift. plannedSalary/effectiveSalary are stubbed to the logged-in shape.
const rosterFnSrc = html.match(/function activeRosterPlayers\(league\) \{[\s\S]*?\n\t\t\}\n\t\tfunction capSummaryNumbers\(league, rosterPlayers\) \{[\s\S]*?\n\t\t\}/)[0];
const capInfoSrc = html.match(/function capRoomInfo\(league\) \{[\s\S]*?\n\t\t\}/)[0];
const capFns = new Function('plannedSalary', 'effectiveSalary', 'timeAgo', `${rosterFnSrc}\n${capInfoSrc}\nreturn { activeRosterPlayers, capSummaryNumbers, capRoomInfo };`);
const makeCap = (plans = {}) => {
  const planned = (l, p) => (plans[p.id] > 0 ? plans[p.id] : null);
  const effective = (l, p) => (Number(p.salary) > 0 ? Number(p.salary) : planned(l, p) ?? 0);
  return capFns(planned, effective, () => '2h ago');
};
await test('page: cap room = cap - (ROSTER salaries + adjustments); taxi/IR excluded', () => {
  const { capRoomInfo } = makeCap();
  const league = { salaryCap: 100, salaryAdjustments: 5.5, players: [
    { id: 'a', salary: 40, status: 'ROSTER' }, { id: 'b', salary: 20 }, // no status = ROSTER
    { id: 'c', salary: 30, status: 'INJURED_RESERVE' }, { id: 'd', salary: 9, status: 'TAXI_SQUAD' },
  ] };
  const info = capRoomInfo(league);
  assert.equal(info.money, '$34.50');
  assert.equal(info.negative, false);
  assert.match(info.title, /as of the last sync/);
});
await test('page: cap room goes negative when over, and null with no cap', () => {
  const { capRoomInfo } = makeCap();
  const over = capRoomInfo({ salaryCap: 10, players: [{ id: 'a', salary: 12, status: 'ROSTER' }] });
  assert.equal(over.money, '-$2.00');
  assert.equal(over.negative, true);
  assert.equal(capRoomInfo({ players: [] }), null);
});
await test('page: a planned salary stands in for an unpriced one and is flagged', () => {
  const { capRoomInfo } = makeCap({ a: 7 });
  const info = capRoomInfo({ salaryCap: 20, players: [{ id: 'a', status: 'ROSTER' }, { id: 'b', salary: 3, status: 'ROSTER' }] });
  assert.equal(info.money, '$10.00');
  assert.match(info.title, /1 locally-planned salary/);
});
await test('page: every committed salary-cap league yields a number matching an independent sum', () => {
  const snap = JSON.parse(readFileSync(fileURLToPath(new URL('../data/rosters.json', import.meta.url)), 'utf8'));
  const { capRoomInfo } = makeCap();
  const caps = snap.leagues.filter((l) => l.salaryCap != null);
  assert.ok(caps.length > 0);
  for (const l of caps) {
    const sum = (l.players || []).filter((p) => (p.status || 'ROSTER').toUpperCase() === 'ROSTER')
      .reduce((a, p) => a + (Number(p.salary) > 0 ? Number(p.salary) : 0), 0);
    const expected = l.salaryCap - (sum + (Number(l.salaryAdjustments) || 0));
    assert.equal(capRoomInfo(l).money, `$${expected.toFixed(2)}`, l.id);
  }
});
await test('page: the Auctions row renders cap room only for auctions', () => {
  assert.match(html, /waivers-cap/);
  assert.match(html, /kind === 'auctions'[^\n]*capRoomInfo|capRoomInfo\(league\)/);
});

console.log(`\n${passed} passed`);
