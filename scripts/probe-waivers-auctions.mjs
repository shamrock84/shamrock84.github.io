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

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mflLogin, mflGet, seasonOf, fetchMflLeagueData, espnGet, setMflRequestInterval } from './lib/providers.mjs';

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
