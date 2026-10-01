#!/usr/bin/env node
// Asks what MFL and ESPN actually return for pending waiver claims and open
// auctions, which the Waivers tab (api/waivers.js, and the "Waivers &
// auctions" section of scripts/lib/providers.mjs) shipped reading WITHOUT
// that having been confirmed on any league of ours — api.myfantasyleague.com
// is unreachable from the sandbox the feature was written in. What it was
// built on instead:
//
//   - MFL TYPE=pendingWaivers: owner-access, names its record after the
//     waiver system (waiverRequest / blindBidWaiverRequest), each carrying
//     an `addsDrops` string like "8851,|425000|15777," — read off another
//     public MFL client's fixes, not our own leagues.
//   - MFL TYPE=transactions: auctions logged as AUCTION_INIT / AUCTION_BID /
//     AUCTION_WON with `transaction: "playerId|amount|..."` — same source.
//   - ESPN view=mTransactions2: type WAIVER, status PENDING, items[] of
//     ADD/DROP — community documentation.
//
// PRIVACY: this repo is public, and so are its Actions logs. A pending
// claim is exactly what the Waivers tab keeps out of the public snapshot,
// so this never prints one. Every string value is shown with its digits
// masked (N) — enough to confirm "N,|N|N," is the format without saying
// which player or what bid. Key names, record types and counts are printed
// as-is.
//
// Record findings here, run by run, as the other probe headers do.
//
// RUN 1 (2026-10-01, claims filed in every MFL Dynasty and both ESPN
// leagues, auctions open in all four Salary Cap leagues):
//   - MFL pendingWaivers: the league's own host answers; the generic host
//     returns "API requires logged in user in league ID ..." for all three,
//     so the host routing was necessary. Records are `waiverRequest` (MNMx,
//     rolling, an array when several) and `blindBidWaiverRequest` (OSD and
//     Survivor, one object), keys round/timestamp/comments/addsDrops.
//     addsDrops is UNDERSCORE-separated, not the pipe form assumed at
//     ship: "N_N,N_N" (rolling add_drop pairs) and "N_N_N" (add_bid_drop).
//     The shipped parser would have rendered these as garbled ids; fixed
//     in parseMflAddsDrops the same day.
//   - MFL transactions: AUCTION_INIT/BID/WON present in all four Salary Cap
//     leagues, `transaction` exactly "playerId|amount|" with an optional
//     free-text third segment ("<team> forced bid increase"). As assumed.
//   - ESPN mTransactions2: pending claims are type WAIVER, status PENDING,
//     isPending true, numeric teamId and bidAmount, items[] of
//     { type, playerId, ... }. As assumed, except no `subOrder` field.
//   - Not covered by RUN 1: whether ESPN's kona_player_info name lookup
//     answers, and the parsers end to end. The "end to end" section below
//     was added for RUN 2 to check exactly that, still printing only counts.
//
// RUN 2 (2026-10-01, after the parser fix):
//   - MFL end to end: every claim and auction parsed, every player named
//     (MNMx 3 claim rows / 6 ids / 6 named; OSD 1/2/2; Survivor 1/1/1, its
//     drop being the all-zero "none"; Iron Bank, Wise Guys, Game On 5 open
//     auctions each and Super Cap 1, all named and all with a bid).
//   - ESPN: claims read (4 and 2) but 0 of 12 ids named —
//     fetchEspnPlayerNames' kona_player_info lookup comes back empty, and it
//     swallows its own error by design. The "ESPN name lookup" section
//     below was added for RUN 3 to find out why: it tries the shipped
//     request and three alternatives, printing only HTTP status, response
//     key names and match counts — never a name, since a claimed player's
//     name is the claim.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  mflLogin, mflGet, seasonOf, fetchMflLeagueData, espnGet, setMflRequestInterval, loadPlayerMap,
  fetchMflPendingWaivers, fetchMflActiveAuctions, fetchEspnPendingWaivers, fetchEspnPlayerNames,
} from './lib/providers.mjs';

setMflRequestInterval(300);
const CONFIG_PATH = fileURLToPath(new URL('../config/leagues.json', import.meta.url));
const { leagues } = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));

const mask = (v) => String(v).replace(/[0-9]/g, 'N');

// Structure of an arbitrary response: keys and types all the way down,
// arrays summarised by length plus their first element, strings masked.
function shape(node, depth = 0) {
  if (depth > 6) return '…';
  if (Array.isArray(node)) return node.length ? [`(${node.length} items)`, shape(node[0], depth + 1)] : [];
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, shape(v, depth + 1)]));
  }
  if (typeof node === 'string') return mask(node);
  return typeof node;
}
const print = (label, obj) => console.log(`${label}:\n${JSON.stringify(obj, null, 2)}\n`);

const mflTargets = leagues.filter((l) => (l.provider || 'mfl') === 'mfl' && l.type !== 'draftonly');
let cookie = null;
if (mflTargets.length) cookie = await mflLogin(process.env.MFL_USERNAME, process.env.MFL_PASSWORD);

for (const league of mflTargets) {
  console.log(`=== MFL ${league.name} (L=${league.id}, type ${league.type}) ===`);
  try {
    const leagueData = await fetchMflLeagueData(league, cookie);
    const host = leagueData?.league?.baseURL;
    console.log(`baseURL present: ${!!host}`);
    if (league.type === 'salarycap') {
      const tx = await mflGet(`/export?TYPE=transactions&L=${league.id}&DAYS=30&JSON=1`, cookie, seasonOf(league), 1, host);
      const rows = [].concat(tx?.transactions?.transaction ?? []);
      const byType = {};
      for (const r of rows) byType[r.type] = (byType[r.type] || 0) + 1;
      print('transactions: count by type (last 30 days)', byType);
      const auctionRows = rows.filter((r) => String(r.type).startsWith('AUCTION'));
      print('transactions: first 5 AUCTION_* rows, masked', auctionRows.slice(0, 5).map((r) => shape(r)));
      if (tx?.error) print('transactions: error', tx.error);
    } else {
      for (const [label, h] of [['league host', host], ['generic host', undefined]]) {
        const pw = await mflGet(`/export?TYPE=pendingWaivers&L=${league.id}&JSON=1`, cookie, seasonOf(league), 1, h);
        print(`pendingWaivers (${label}), masked`, shape(pw));
      }
    }
  } catch (err) {
    console.log(`FAILED: ${err.message}\n`);
  }
}

for (const league of leagues.filter((l) => l.provider === 'espn' && l.type !== 'draftonly')) {
  console.log(`=== ESPN ${league.name} (id ${league.id}, team ${league.franchiseId}) ===`);
  try {
    const status = await espnGet(league, 'view=mStatus');
    console.log(`top-level scoringPeriodId: ${status?.scoringPeriodId}, status.currentMatchupPeriod: ${status?.status?.currentMatchupPeriod}`);
    const data = await espnGet(league, `view=mTransactions2&scoringPeriodId=${status?.scoringPeriodId || 1}`);
    const txs = data?.transactions ?? [];
    const counts = {};
    for (const t of txs) {
      const key = `${t.type}/${t.status}${t.isPending ? '/isPending' : ''}${String(t.teamId) === String(league.franchiseId) ? '/MINE' : ''}`;
      counts[key] = (counts[key] || 0) + 1;
    }
    print('mTransactions2: count by type/status', counts);
    const pending = txs.filter((t) => t.status === 'PENDING' || t.isPending);
    print('mTransactions2: first 3 pending, masked', pending.slice(0, 3).map((t) => shape(t)));
    if (!pending.length && txs.length) print('mTransactions2: first transaction, masked (no pending found)', shape(txs[0]));
  } catch (err) {
    console.log(`FAILED: ${err.message}\n`);
  }
}

// --- End to end: the exact functions api/waivers.js calls, counts only ---
// Proves the parsers read the real responses and that names resolve, without
// printing a single id, name or bid.
console.log('=== END TO END (counts only) ===');
const playerMap = cookie ? await loadPlayerMap(cookie).catch(() => new Map()) : new Map();
console.log(`MFL player map size: ${playerMap.size}`);
for (const league of mflTargets) {
  try {
    const leagueData = await fetchMflLeagueData(league, cookie);
    if (league.type === 'salarycap') {
      const open = await fetchMflActiveAuctions(league, cookie, leagueData);
      const named = open.filter((a) => playerMap.has(a.playerId)).length;
      const withBid = open.filter((a) => a.bid != null).length;
      console.log(`${league.name}: ${open.length} open auctions, ${named} named, ${withBid} with a bid`);
    } else {
      const claims = await fetchMflPendingWaivers(league, cookie, leagueData);
      const ids = claims.flatMap((c) => [...c.adds, ...c.drops]);
      const named = ids.filter((id) => playerMap.has(id)).length;
      const withBid = claims.filter((c) => c.bid != null).length;
      console.log(`${league.name}: ${claims.length} claim rows, ${ids.length} player ids, ${named} named, ${withBid} with a bid`);
    }
  } catch (err) {
    console.log(`${league.name}: FAILED ${err.message}`);
  }
}
for (const league of leagues.filter((l) => l.provider === 'espn' && l.type !== 'draftonly')) {
  try {
    const claims = await fetchEspnPendingWaivers(league);
    const ids = claims.flatMap((c) => [...c.adds, ...c.drops]);
    const names = await fetchEspnPlayerNames(league, ids);
    const named = ids.filter((id) => names.has(id)).length;
    console.log(`${league.name}: ${claims.length} claims, ${ids.length} player ids, ${named} named`);
  } catch (err) {
    console.log(`${league.name}: FAILED ${err.message}`);
  }
}

// --- ESPN name lookup diagnostics (RUN 3) — status, keys and counts only ---
console.log('=== ESPN NAME LOOKUP (counts only) ===');
const espnCookie = `espn_s2=${process.env.ESPN_S2}; SWID=${process.env.ESPN_SWID}`;
async function espnRaw(url, headers = {}) {
  let res;
  for (let hop = 0; hop < 5; hop++) {
    res = await fetch(url, { headers: { ...headers, Cookie: espnCookie }, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), url).toString();
      continue;
    }
    break;
  }
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body, bytes: text.length };
}
// Keys of the response, and of one entry, with no values at all.
function keysOnly(body) {
  if (Array.isArray(body)) {
    const e = body[0];
    return `array(${body.length}) entry keys: ${e && typeof e === 'object' ? Object.keys(e).join(',') : typeof e}`;
  }
  if (body && typeof body === 'object') {
    const players = body.players;
    const e = Array.isArray(players) ? players[0] : null;
    return `object keys: ${Object.keys(body).join(',')}; players: ${Array.isArray(players) ? players.length : typeof players}`
      + (e ? `; players[0] keys: ${Object.keys(e).join(',')}${e.player ? `; players[0].player keys: ${Object.keys(e.player).join(',')}` : ''}` : '');
  }
  return `not JSON`;
}
function matchCount(body, wanted) {
  const list = Array.isArray(body) ? body : Array.isArray(body?.players) ? body.players : [];
  const ids = new Set(list.map((e) => String((e?.player || e)?.id)));
  return wanted.filter((id) => ids.has(id)).length;
}
for (const league of leagues.filter((l) => l.provider === 'espn' && l.type !== 'draftonly')) {
  try {
    const claims = await fetchEspnPendingWaivers(league);
    const wanted = [...new Set(claims.flatMap((c) => [...c.adds, ...c.drops]))];
    const nums = wanted.map(Number);
    const season = seasonOf(league);
    const leagueUrl = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${league.id}`;
    const globalUrl = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/players`;
    const filter = JSON.stringify({ players: { filterIds: { value: nums }, limit: nums.length } });
    const candidates = [
      ['A league kona_player_info + filter (shipped)', `${leagueUrl}?view=kona_player_info`, { 'x-fantasy-filter': filter }],
      ['B league kona_player_info + filter + scoringPeriodId', `${leagueUrl}?view=kona_player_info&scoringPeriodId=4`, { 'x-fantasy-filter': filter }],
      ['C global players_wl + filter', `${globalUrl}?view=players_wl`, { 'x-fantasy-filter': JSON.stringify({ filterIds: { value: nums } }) }],
      ['D global players_wl, no filter', `${globalUrl}?scoringPeriodId=0&view=players_wl`, {}],
    ];
    console.log(`${league.name}: ${wanted.length} distinct ids wanted`);
    for (const [label, url, headers] of candidates) {
      try {
        const r = await espnRaw(url, headers);
        console.log(`  ${label}: HTTP ${r.status}, ${r.bytes} bytes, ${keysOnly(r.body)}, matched ${matchCount(r.body, wanted)}/${wanted.length}`);
      } catch (err) {
        console.log(`  ${label}: threw ${String(err.message).replace(/[0-9]/g, 'N').slice(0, 160)}`);
      }
    }
  } catch (err) {
    console.log(`${league.name}: FAILED ${err.message}`);
  }
}
