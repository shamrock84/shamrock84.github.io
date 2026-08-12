// Asks FantasyPros whether the partner API can answer anything team-shaped —
// specifically whether a "power rank" of a league's franchises exists behind
// the key the sync already holds, before any code assumes it does.
//
// The suspicion this probe tests: team power rankings are a My Playbook
// feature (FantasyPros' consumer product, behind a user login), and the
// public partner API at /public/v2/json is player-level only. If that's
// right, every candidate below 404s and the homegrown computation is the
// only path. If any answers 200, its body is dumped so the next step can be
// designed from what's actually there rather than from the endpoint's name.
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
//   - each candidate power/team endpoint: HTTP status, content type, and the
//     first few hundred bytes of body — a 404 body often names the valid
//     endpoints, which is worth as much as the status;
//   - projections: not power-rank-related, but it decides what the homegrown
//     score can be built from — rest-of-season projected points beat a rank
//     ordinal as a strength weight if the key can reach them.

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

// Every plausible spelling of a team/power endpoint under the partner base.
// Expected answer for all of them: 404. A 200 on any is the headline.
const candidates = [
  ['power-rankings (season-scoped)', `${FP_BASE}/nfl/${season}/power-rankings`],
  ['power-rankings (unscoped)', `${FP_BASE}/nfl/power-rankings`],
  ['team-rankings', `${FP_BASE}/nfl/${season}/team-rankings`],
  ['team-power-rankings', `${FP_BASE}/nfl/${season}/team-power-rankings`],
  ['league (My Playbook-shaped)', `${FP_BASE}/nfl/${season}/league`],
  ['endpoint index (season root)', `${FP_BASE}/nfl/${season}`],
  ['endpoint index (sport root)', `${FP_BASE}/nfl`],
];
let anyHit = false;
for (const [label, url] of candidates) {
  const { status } = await probe(`candidate: ${label}`, url);
  if (status === 200) anyHit = true;
}

// Decides the homegrown score's input, not the FantasyPros question:
// week=0 in-season means rest-of-season projections, which would be a
// better strength weight than an ECR ordinal if the key can reach them.
const projections = await probe(
  'projections (homegrown-score input, not a power-rank candidate)',
  `${FP_BASE}/nfl/${season}/projections?position=QB&week=0&scoring=PPR`
);

console.log('\n=== verdict ===');
console.log(anyHit
  ? 'At least one team-level candidate answered 200 — read its body above before building anything.'
  : 'No team-level endpoint exists behind this key: every candidate 404d while the control answered 200. Power ranks must be computed homegrown.');
console.log(projections.status === 200
  ? 'Projections ARE reachable with this key — the homegrown score can weight by projected points rather than rank ordinal.'
  : `Projections are NOT reachable (HTTP ${projections.status}) — the homegrown score weights by ECR rank.`);
