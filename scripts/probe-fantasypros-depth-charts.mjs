// Asks whether the partner API can answer anything depth-chart-shaped —
// starter/backup ordering per NFL team — before any Depth Charts tab is
// designed around data that might not exist behind this key.
//
// The suspicion this probe tests: FantasyPros' public depth-chart page
// (fantasypros.com/nfl/depth-charts.php) is a consumer-site feature, and the
// partner API at /public/v2/json has only ever been confirmed to answer
// consensus-rankings, players, and projections (see
// probe-fantasypros-power-rank.mjs, which found every team/power candidate
// under that base 404s). If that pattern holds here too, every candidate
// below 404s and depth-chart order — if this project ever wants it — has to
// come from somewhere else entirely, not from this key.
//
// This exists because api.fantasypros.com is unreachable from a sandbox and
// the key is a GitHub Actions secret, so the only place this question can be
// answered is a workflow run — the same reason every other probe here exists.
// Read-only: a handful of GETs, none of them writes.
//
// What it reports:
//   - the control: the consensus-rankings GET the sync makes every run. If
//     this fails the run fails, because then the candidates' 4xxs mean
//     "broken key", not "no such endpoint", and the probe has answered
//     nothing;
//   - each candidate depth-chart endpoint: HTTP status, content type, and
//     the first few hundred bytes of body — a 404 body often names the
//     valid endpoints, which is worth as much as the status;
//   - the players endpoint, checked for any field that looks like a
//     depth-chart position or starter rank, since a partial answer could be
//     riding along on a request the sync already makes rather than needing
//     its own endpoint at all.
//
// First run, 2026-08 (workflow run 33211878439): the control succeeded (HTTP
// 200) but all six depth-chart candidates came back HTTP 403 "Missing
// Authentication Token" — API Gateway's stock answer for a route that isn't
// wired up at all, the 403-flavored sibling of the 404s the power-rank probe
// got for the same reason. /nfl/players (8,534 entries) carries only ECR/ADP
// rank fields (rank_ecr, rank_adp, rank_ecr_ppr, rank_adp_ppr, rank_ecr_half)
// and nothing depth-chart-shaped. Conclusion: the partner API does not expose
// depth-chart data under this key, under any of the spellings tried — a
// Depth Charts tab would need a different data source entirely, not this
// one.

import { fantasyProsApiKey, nflSeasonPhase } from './lib/fantasypros.mjs';

const apiKey = fantasyProsApiKey();
if (!apiKey) {
  console.error('No FANTASYPROS_API_KEY set — nothing to probe.');
  process.exit(1);
}

const FP_BASE = 'https://api.fantasypros.com/public/v2/json';
const season = nflSeasonPhase().season;

async function probe(label, url) {
  console.log(`\n--- ${label} ---`);
  console.log(`GET ${url}`);
  try {
    const res = await fetch(url, { headers: { 'x-api-key': apiKey } });
    const body = await res.text();
    console.log(`HTTP ${res.status}  content-type: ${res.headers.get('content-type') ?? '—'}  bytes: ${body.length}`);
    console.log(body.slice(0, 400).replace(/\s+/g, ' '));
    return { status: res.status, body };
  } catch (err) {
    console.log(`request failed: ${err.message}`);
    return { status: null, body: '' };
  }
}

// The GET the sync makes every run. Everything after this is interpreted
// relative to it: candidates' 404s only mean "no such endpoint" if this
// same key got a 200 here moments earlier.
const control = await probe(
  'control: consensus-rankings (the call the sync already makes)',
  `${FP_BASE}/nfl/${season}/consensus-rankings?position=ALL&type=DRAFT&scoring=PPR&week=0`
);
if (control.status !== 200) {
  console.error('\nControl request failed — key or API is broken, so the candidate results below mean nothing.');
  process.exit(1);
}

// Every plausible spelling of a depth-chart endpoint under the partner
// base. Expected answer for all of them: 404. A 200 on any is the headline.
const candidates = [
  ['depth-charts (season-scoped)', `${FP_BASE}/nfl/${season}/depth-charts`],
  ['depth-charts (unscoped)', `${FP_BASE}/nfl/depth-charts`],
  ['depth-chart (singular, season-scoped)', `${FP_BASE}/nfl/${season}/depth-chart`],
  ['depth-chart (singular, unscoped)', `${FP_BASE}/nfl/depth-chart`],
  ['teams/depth-charts', `${FP_BASE}/nfl/${season}/teams/depth-charts`],
  ['team depth-chart, sample team (KC)', `${FP_BASE}/nfl/${season}/KC/depth-chart`],
];
let anyHit = false;
for (const [label, url] of candidates) {
  const { status } = await probe(`candidate: ${label}`, url);
  if (status === 200) anyHit = true;
}

// The players endpoint the sync's own code comments say has "no Sleeper IDs
// at all" — checked here for depth-chart-shaped fields riding along on a
// request that otherwise exists mainly for foreign-id lookups.
const playersRes = await probe('players (checked for depth-chart-shaped fields)', `${FP_BASE}/nfl/players`);
if (playersRes.status === 200) {
  try {
    const data = JSON.parse(playersRes.body);
    const players = data?.players || [];
    if (players.length > 0) {
      const fields = Object.keys(players[0]);
      const depthLike = fields.filter((f) => /depth|starter|rank_order|position_rank/i.test(f));
      console.log(`\n  ${players.length} players; fields possibly depth-chart-shaped: ${depthLike.join(', ') || '(none)'}`);
      console.log(`  all fields on first player: ${fields.join(', ')}`);
    }
  } catch (err) {
    console.log(`  could not parse players response: ${err.message}`);
  }
}

console.log(`\n=== ${anyHit ? 'AT LEAST ONE depth-chart candidate answered 200 — see above.' : 'No depth-chart candidate answered 200. Consistent with the partner API being player-list-only.'} ===`);
