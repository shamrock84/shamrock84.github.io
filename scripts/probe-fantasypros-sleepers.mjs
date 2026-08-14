// Asks FantasyPros whether "Sleepers" and "Busts" — their curated lists of
// undervalued/breakout and overvalued/regression candidates, each published
// as an article on fantasypros.com each preseason and updated through the
// year — are reachable as ranking DATA behind the partner API key this
// project already holds, the same way DYNASTY/DRAFT/ROS/WEEKLY/ADP already
// are (see rankingSpecForLeague in scripts/lib/fantasypros.mjs, all four
// confirmed working today). Sleepers was confirmed by an earlier run of
// this same probe (type=SLEEPERS, plural) — see attachSleepers in
// scripts/lib/fantasypros.mjs. Busts is the open question.
//
// Two live possibilities going in, both worth ruling out explicitly rather
// than guessing: (1) "Sleepers" is just another `type` value on the SAME
// consensus-rankings endpoint the sync already calls, shaped identically to
// DRAFT/DYNASTY/etc — the cheap, ideal case; or (2) like team power rankings
// (see probe-fantasypros-power-rank.mjs), it's editorial content behind
// FantasyPros' consumer product (an article/page), not exposed to the
// public partner API at all, in which case nothing here can be built from
// it as ranking data.
//
// This exists because api.fantasypros.com is unreachable from a sandbox and
// the key is a GitHub Actions secret, so the only place this question can be
// answered is a workflow run — the same reason every other probe here
// exists. Read-only: a handful of GETs, none of them writes.
//
// What it reports:
//   - the control: the same consensus-rankings GET the sync already makes
//     (type=DRAFT). If this fails the run fails, because then every
//     candidate's 4xx means "broken key", not "no such type/endpoint",
//     and the probe has answered nothing;
//   - each candidate `type` value against consensus-rankings — every
//     plausible spelling FantasyPros might use for this list;
//   - each candidate standalone endpoint path, in case "Sleepers" is its
//     own resource rather than a type on the rankings endpoint.

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
    console.log(body.slice(0, 500).replace(/\s+/g, ' '));
    return { status: res.status, body };
  } catch (err) {
    console.log(`request failed: ${err.message}`);
    return { status: null, body: '' };
  }
}

// The GET the sync makes every run, exactly as configured (week=0 is the
// preseason slot DRAFT/DYNASTY use). Everything after this is interpreted
// relative to it: a candidate's 404 only means "no such type" if this same
// key got a 200 here moments earlier.
const control = await probe(
  'control: consensus-rankings type=DRAFT (the call the sync already makes)',
  `${FP_BASE}/nfl/${season}/consensus-rankings?position=ALL&type=DRAFT&scoring=PPR&week=0`
);
if (control.status !== 200) {
  console.error('\nControl request failed — key or API is broken, so the candidate results below mean nothing.');
  process.exit(1);
}

// Every plausible `type` value for the SAME endpoint the sync already uses —
// the cheap case, if any of these answer 200 with a real player list.
// SLEEPERS is already confirmed (kept here as a regression check); BUST/
// BUSTS is the new question.
const typeCandidates = ['SLEEPER', 'SLEEPERS', 'BREAKOUT', 'BREAKOUTS', 'BUST', 'BUSTS'];
let anyTypeHit = false;
for (const type of typeCandidates) {
  const { status, body } = await probe(
    `candidate type=${type} on consensus-rankings`,
    `${FP_BASE}/nfl/${season}/consensus-rankings?position=ALL&type=${type}&scoring=PPR&week=0`
  );
  // FantasyPros answers an unrecognized `type` with 200 and an empty/error
  // body rather than a 4xx in some cases (seen elsewhere in this API), so a
  // count of actual players is worth more here than the status code alone.
  let playerCount = null;
  try { playerCount = JSON.parse(body)?.players?.length ?? null; } catch { /* not JSON */ }
  console.log(`  -> players: ${playerCount ?? 'n/a (not parseable JSON)'}`);
  if (status === 200 && playerCount > 0) anyTypeHit = true;
}

// In case "Sleepers" is its own resource rather than a type on the rankings
// endpoint — every plausible spelling under the partner base, mirroring how
// probe-fantasypros-power-rank.mjs checked for a standalone power-rankings
// resource. Expected answer for all of these: 404.
const pathCandidates = [
  ['sleepers (season-scoped)', `${FP_BASE}/nfl/${season}/sleepers`],
  ['sleepers (unscoped)', `${FP_BASE}/nfl/sleepers`],
  ['rankings/sleepers', `${FP_BASE}/nfl/${season}/rankings/sleepers`],
  ['articles/sleepers', `${FP_BASE}/nfl/${season}/articles/sleepers`],
  ['busts (season-scoped)', `${FP_BASE}/nfl/${season}/busts`],
  ['busts (unscoped)', `${FP_BASE}/nfl/busts`],
  ['rankings/busts', `${FP_BASE}/nfl/${season}/rankings/busts`],
  ['articles/busts', `${FP_BASE}/nfl/${season}/articles/busts`],
];
let anyPathHit = false;
for (const [label, url] of pathCandidates) {
  const { status } = await probe(`candidate path: ${label}`, url);
  if (status === 200) anyPathHit = true;
}

console.log('\n=== verdict ===');
console.log(anyTypeHit
  ? 'At least one `type` candidate answered 200 with real players on the SAME consensus-rankings endpoint — read its body above, this is the cheap path.'
  : 'No `type` candidate returned real players on consensus-rankings.');
console.log(anyPathHit
  ? 'At least one standalone path answered 200 — read its body above before assuming a shape.'
  : 'No standalone Sleepers endpoint exists behind this key.');
if (!anyTypeHit && !anyPathHit) {
  console.log('Sleepers is not reachable as ranking data through this API key — like team power rankings, it is');
  console.log('most likely editorial content behind FantasyPros\' consumer product, not the public partner API.');
}
