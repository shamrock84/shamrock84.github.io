#!/usr/bin/env node
// Asks MFL what per-player value/rank signals it can supply beyond the
// rosters/scoring/rules the sync already reads — specifically whether MFL
// itself can serve as a SECOND source for the Power Rankings card's
// Overall/Starter/Bench tables to average against FantasyPros. The card's
// Total columns are already built to absorb this: meanOf() in myffl.html
// takes a list of values, and today every table passes it exactly one
// (FantasyPros'). A second source is a second entry in that list, once one
// exists to add.
//
// Three candidates, all documented on MFL's public API index but never hit
// by this project before, so their real shape — and even whether these
// param names/values are still current — is unknown:
//   - TYPE=projectedScores — MFL's own weekly projected points per player,
//     scored under a specific league's rules (same shape as TYPE=playerScores,
//     which fetchMflSeasonPoints already uses for actual points). The
//     natural analog to FantasyPros' Proj.
//   - TYPE=adp — Average Draft Position across MFL's site-wide mock/live
//     drafts for a given format (franchise count, PPR-ness, keeper-ness).
//     Site-wide rather than league-scoped, and not dynasty-aware, but a
//     real consensus-rank signal — the natural analog to FantasyPros' ECR,
//     and probably the more honest fit for draftonly/redraft leagues than
//     dynasty ones.
//   - TYPE=aav — Average Auction Value, the same idea priced in draft-budget
//     dollars instead of pick order. Directly relevant to every salarycap
//     league in config/leagues.json (all of which are auction-drafted).
//
// api.myfantasyleague.com is unreachable from a sandbox, so — like every
// other probe here — this only runs from a workflow dispatch. Read-only:
// a handful of GETs, no writes, same login the sync already uses.
//
// What it reports:
//   - a control: TYPE=league for a real league, using the same cookie every
//     other probe below reuses. If this fails, every other probe's 4xx
//     means "broken cookie", not "no such endpoint" or "wrong params" —
//     and the probe has answered nothing.
//   - TYPE=projectedScores across a few weeks and PLAYERS shapes, since
//     fetchMflSeasonPoints needed an explicit PLAYERS list for actual
//     scores and projections may or may not follow the same rule, and
//     there is no reason yet to assume a week=0/YTD/ROS slot exists the
//     way it does for playerScores.
//   - TYPE=adp and TYPE=aav across a few plausible FRANCHISES/IS_PPR/PERIOD
//     combinations, since none of those param values are verified current.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mflLogin } from './lib/providers.mjs';

const CONFIG_PATH = fileURLToPath(new URL('../config/leagues.json', import.meta.url));
const ROSTERS_PATH = fileURLToPath(new URL('../data/rosters.json', import.meta.url));
const { leagues } = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));

const YEAR = process.env.MFL_YEAR || String(new Date().getFullYear());
const BASE = `https://api.myfantasyleague.com/${YEAR}`;

const cookie = await mflLogin(process.env.MFL_USERNAME, process.env.MFL_PASSWORD);

async function probe(label, path) {
  const url = `${BASE}${path}`;
  console.log(`\n--- ${label} ---`);
  console.log(`GET ${url}`);
  try {
    const res = await fetch(url, { headers: { Cookie: cookie }, redirect: 'follow' });
    const body = await res.text();
    console.log(`HTTP ${res.status}  content-type: ${res.headers.get('content-type') ?? '—'}  bytes: ${body.length}`);
    console.log(body.slice(0, 700).replace(/\s+/g, ' '));
    let json = null;
    try { json = JSON.parse(body); } catch { /* not JSON, or an HTML error page */ }
    return { status: res.status, body, json };
  } catch (err) {
    console.log(`request failed: ${err.message}`);
    return { status: null, body: '', json: null };
  }
}

// A small, representative slice — one dynasty, one salary-cap/auction, one
// draft-only, all MFL. Sleeper/ESPN leagues have no MFL export to ask about.
const dynasty = leagues.find((l) => l.id === '26696'); // MNMx Dynasty
const auction = leagues.find((l) => l.id === '34850'); // Wise Guys
const draftonly = leagues.find((l) => l.id === '56191'); // Worlds Collide

// A few real MFL player ids off the committed snapshot, so PLAYERS= is
// tested against ids that actually exist rather than made-up numbers.
let samplePlayerIds = ['14783', '13592']; // Jalen Hurts, Sam Darnold — fallback if the snapshot is unreadable
try {
  const prev = JSON.parse(await readFile(ROSTERS_PATH, 'utf8'));
  const league = (prev.leagues || []).find((l) => l.id === dynasty?.id);
  const ids = (league?.players || []).slice(0, 4).map((p) => p.id).filter(Boolean);
  if (ids.length) samplePlayerIds = ids;
} catch {
  console.log('No data/rosters.json to read sample player ids from — using hardcoded fallbacks.\n');
}

console.log('=== control: TYPE=league (already known to work) ===');
const control = await probe(`${dynasty?.name} (L=${dynasty?.id})`, `/export?TYPE=league&L=${dynasty?.id}&JSON=1`);
if (control.status !== 200) {
  console.error('\nControl request failed — cookie or league id is broken, so everything below means nothing.');
  process.exit(1);
}

console.log("\n=== TYPE=projectedScores — MFL's own weekly projections ===");
for (const league of [dynasty, auction, draftonly].filter(Boolean)) {
  for (const w of ['1', '2', 'YTD', '0']) {
    await probe(`${league.name} (L=${league.id}) W=${w}, no PLAYERS`, `/export?TYPE=projectedScores&L=${league.id}&W=${w}&JSON=1`);
  }
  await probe(`${league.name} (L=${league.id}) W=1, PLAYERS=${samplePlayerIds.join(',')}`,
    `/export?TYPE=projectedScores&L=${league.id}&W=1&PLAYERS=${samplePlayerIds.join(',')}&JSON=1`);
}

console.log('\n=== TYPE=adp — site-wide average draft position ===');
for (const [franchises, ppr, period] of [['12', '1', 'RECENT'], ['12', '1', 'ALL'], ['12', '1', null], ['10', '0', null]]) {
  const periodParam = period ? `&PERIOD=${period}` : '';
  await probe(`FRANCHISES=${franchises} IS_PPR=${ppr}${periodParam || ' (no PERIOD)'}`,
    `/export?TYPE=adp&FRANCHISES=${franchises}&IS_PPR=${ppr}${periodParam}&JSON=1`);
}

console.log('\n=== TYPE=aav — site-wide average auction value ===');
for (const [franchises, ppr, period] of [['12', '1', 'RECENT'], ['12', '1', null]]) {
  const periodParam = period ? `&PERIOD=${period}` : '';
  await probe(`FRANCHISES=${franchises} IS_PPR=${ppr}${periodParam || ' (no PERIOD)'}`,
    `/export?TYPE=aav&FRANCHISES=${franchises}&IS_PPR=${ppr}${periodParam}&JSON=1`);
}

console.log('\n=== verdict ===');
console.log('Read the bodies above — this only reports what came back. Nothing here is assumed about field');
console.log('names or shape; the next step is designed from whichever of the above actually answered 200.');
