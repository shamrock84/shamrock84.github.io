// How deep does FantasyPros actually rank each position — not how deep our
// own stored pool goes, which is capped at RANKING_POOL_SIZE (250) and, per
// the committed data/rosters.json, is HITTING that cap on every pool type
// (Dynasty/Draft-PPR/Draft-HalfPPR all show a deepest stored rank right at
// or past 250). That means the stored pools understate FantasyPros' real
// depth and can't answer this question — only the live, per-position,
// unbounded response can.
//
// This matters for the Depth Charts tab's plan to exclude any player with
// no ECR at all (trusting FantasyPros' own judgment on fantasy relevance,
// same principle buildRankingList already uses via `rank != null`) — the
// open question is how many real depth-chart slots that quietly drops. A
// handful of inactive-squad names is fine; gutting whole position groups to
// 2-3 names each is a different tradeoff.
//
// This exists because api.fantasypros.com is unreachable from a sandbox and
// the key is a GitHub Actions secret, so the only place this can be
// answered is a workflow run. Read-only: 9 GETs (4 positions x 2 ranking
// types, plus one ALL-position control per type).
//
// What it reports, per (type, position):
//   - total player count in the response
//   - how many of those actually carry a rank_ecr (FantasyPros' own
//     relevance cutoff — some players in the response have none);
//   - the deepest (largest) rank_ecr value present, which is the real
//     answer to "how deep does ECR go" for that position/type.
// Plus a position=ALL control per type, to confirm our own 250-cap
// understates things (it should show FantasyPros' combined list going
// past 250, and combined depth should roughly match summing the
// per-position deepest ranks).
//
// First run, 2026-08 (7 of 9 requests before hitting a 429 — DYNASTY/TE and
// DYNASTY/ALL missing, plenty already answered without them): every single
// response was 100% ranked — no player in any position/type query lacked
// rank_ecr, so "exclude players with no ECR" never means "drop a null
// field," only "no join match at all" for a name the response never
// contained. DRAFT depth: QB 105, RB 196, WR 255, TE 178. DYNASTY (partial):
// QB 93, RB 142, WR 191. The deepest depth-chart position group seen
// anywhere in probe-espn-depth-chart-slot.mjs's samples was 14 (WR), so
// these lists run 7-18x deeper than anything a depth chart could need —
// the exclusion filter is safe to build as planned; it will only ever catch
// a genuine practice-squad body FantasyPros doesn't rank at all.
//
// Side-finding, unrelated to that question but worth recording: DRAFT/ALL
// totaled only 518 players — noticeably less than QB+RB+WR+TE queried
// separately would sum to (734). position=ALL is not the union of each
// position's own list; it's a shallower combined ranking. This means the
// already-synced rankingPools (built from position=ALL, RANKING_POOL_SIZE=
// 250) under-covers any single position compared to querying that position
// directly — not a problem for Depth Charts (whose needs are far shallower
// than either list), but worth knowing before assuming rankingPools' depth
// for anything else.

import { fantasyProsApiKey, nflSeasonPhase } from './lib/fantasypros.mjs';

const apiKey = fantasyProsApiKey();
if (!apiKey) {
  console.error('No FANTASYPROS_API_KEY set — nothing to probe.');
  process.exit(1);
}

const FP_BASE = 'https://api.fantasypros.com/public/v2/json';
const season = nflSeasonPhase().season;

const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'ALL'];
const TYPES = ['DRAFT', 'DYNASTY'];

async function probe(type, position) {
  const params = new URLSearchParams({ position, type, scoring: 'PPR', week: '0' });
  const url = `${FP_BASE}/nfl/${season}/consensus-rankings?${params}`;
  console.log(`\nGET ${url}`);
  const res = await fetch(url, { headers: { 'x-api-key': apiKey } });
  const body = await res.text();
  if (!res.ok) {
    console.log(`HTTP ${res.status} — ${body.slice(0, 300)}`);
    return null;
  }
  const data = JSON.parse(body);
  const players = data?.players || [];
  const ranked = players.filter((p) => p.rank_ecr != null && p.rank_ecr !== '');
  const deepest = ranked.reduce((max, p) => Math.max(max, Number(p.rank_ecr) || 0), 0);
  console.log(
    `  ${type}/${position}: ${players.length} total players, ${ranked.length} carry rank_ecr, ` +
      `deepest rank_ecr = ${deepest}, last_updated=${data?.last_updated ?? '—'}`
  );
  return { type, position, total: players.length, ranked: ranked.length, deepest };
}

const results = [];
for (const type of TYPES) {
  console.log(`\n=== ${type} ===`);
  for (const position of POSITIONS) {
    const r = await probe(type, position);
    if (r) results.push(r);
  }
}

console.log('\n\n=== SUMMARY ===');
for (const r of results) {
  console.log(`  ${r.type.padEnd(8)} ${r.position.padEnd(4)} total=${String(r.total).padEnd(4)} ranked=${String(r.ranked).padEnd(4)} deepest=${r.deepest}`);
}

console.log(
  '\nCompare each type\'s per-position "deepest" values above against RANKING_POOL_SIZE (250, in scripts/lib/fantasypros.mjs) ' +
    'to see how much a no-ECR exclusion filter would actually cut per position, and against data/rosters.json\'s committed ' +
    'rankingPools (which hit the 250 cap on every stored pool) to confirm the stored pools understate real depth.'
);
