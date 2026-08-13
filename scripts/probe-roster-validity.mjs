#!/usr/bin/env node
// Asks whether MFL's API says anything about a roster being invalid — over
// legal limits, illegal taxi squad/IR placements, that kind of thing — before
// any code assumes a field for it exists. Nothing in this project reads
// anything limit-shaped today: fetchLeagueRoster pulls TYPE=league and
// TYPE=rosters for the starting-lineup requirement and the players
// themselves, and never looks at roster-size, taxi-squad, or IR limits at
// all. Whether MFL's own "your roster has a problem" banner (visible on the
// site) comes from an explicit API flag or is computed by the site itself
// from limits vs. counts is exactly the open question here.
//
// Deliberately run against a league known to be in an invalid state right
// now (OSD, per config/leagues.json) rather than a healthy one — a probe
// against a compliant roster could only prove a field exists, never that it
// fires.
//
// This exists because api.myfantasyleague.com is unreachable from a
// sandbox, the same reason every other probe here exists. Read-only: two
// GETs against endpoints the sync already calls every run.
//
// What it reports:
//   - every top-level key on the TYPE=league response, and the raw value of
//     anything whose name suggests a limit (roster size, taxi squad, IR,
//     "max", "limit") or a violation ("invalid", "violation", "warn",
//     "alert", "legal", "error");
//   - the same scan one level into the franchise this league's config points
//     at, since a per-franchise flag would live there rather than at the
//     league level;
//   - every key on the TYPE=rosters response for that franchise, and on each
//     player row, since a per-roster or per-player violation flag is the
//     other place this could live;
//   - a plain count of players by `status` (ROSTER/TAXI_SQUAD/
//     INJURED_RESERVE/...), which is the input any client-side check would
//     need regardless of what the probe finds.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mflLogin, mflGet, seasonOf } from './lib/providers.mjs';

const CONFIG_PATH = fileURLToPath(new URL('../config/leagues.json', import.meta.url));
const { leagues } = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));

const TARGET_NAME = process.env.PROBE_LEAGUE_NAME || 'OSD';
const league = leagues.find((l) => l.name === TARGET_NAME);
if (!league) {
  console.error(`No league named "${TARGET_NAME}" in config/leagues.json.`);
  process.exit(1);
}
console.log(`Probing ${league.name} (L=${league.id}, franchise ${league.franchiseId})\n`);

const cookie = await mflLogin(process.env.MFL_USERNAME, process.env.MFL_PASSWORD);
const season = seasonOf(league);

const SUSPECT = /invalid|violat|illegal|warn|alert|legal|error|limit|max|roster.?size|taxi|reserve|cap/i;

function scanKeys(label, obj) {
  console.log(`--- ${label}: every top-level key ---`);
  if (!obj || typeof obj !== 'object') {
    console.log('  (not an object)');
    return;
  }
  for (const [k, v] of Object.entries(obj)) {
    const shown = typeof v === 'object' && v !== null
      ? (Array.isArray(v) ? `[array of ${v.length}]` : `{${Object.keys(v).join(', ')}}`)
      : String(v);
    const flag = SUSPECT.test(k) ? '  <-- SUSPECT' : '';
    console.log(`  ${k}: ${shown}${flag}`);
  }
}

// --- TYPE=league ---
const leagueData = await mflGet(`/export?TYPE=league&L=${league.id}&JSON=1`, cookie, season);
scanKeys('TYPE=league -> league', leagueData?.league);

const franchises = leagueData?.league?.franchises?.franchise ?? [];
const franchiseList = Array.isArray(franchises) ? franchises : [franchises];
const myFranchiseInfo = franchiseList.find((f) => f.id === league.franchiseId);
console.log(`\n--- TYPE=league -> this franchise's own entry (id=${league.franchiseId}) ---`);
if (myFranchiseInfo) {
  for (const [k, v] of Object.entries(myFranchiseInfo)) {
    const flag = SUSPECT.test(k) ? '  <-- SUSPECT' : '';
    console.log(`  ${k}: ${JSON.stringify(v)}${flag}`);
  }
} else {
  console.log('  (franchise not found in the league export)');
}

// --- TYPE=rosters ---
console.log();
const rostersData = await mflGet(`/export?TYPE=rosters&L=${league.id}&FRANCHISE=${league.franchiseId}&JSON=1`, cookie, season);
scanKeys('TYPE=rosters -> rosters', rostersData?.rosters);

const rosterFranchise = Array.isArray(rostersData?.rosters?.franchise)
  ? rostersData.rosters.franchise[0]
  : rostersData?.rosters?.franchise;
console.log(`\n--- TYPE=rosters -> franchise node ---`);
if (rosterFranchise) {
  for (const [k, v] of Object.entries(rosterFranchise)) {
    if (k === 'player') continue; // dumped separately below
    const flag = SUSPECT.test(k) ? '  <-- SUSPECT' : '';
    console.log(`  ${k}: ${JSON.stringify(v)}${flag}`);
  }
} else {
  console.log('  (no franchise node returned)');
}

const rawPlayers = rosterFranchise?.player
  ? (Array.isArray(rosterFranchise.player) ? rosterFranchise.player : [rosterFranchise.player])
  : [];
console.log(`\n--- every key seen across ${rawPlayers.length} player rows ---`);
const allPlayerKeys = new Set();
for (const p of rawPlayers) for (const k of Object.keys(p)) allPlayerKeys.add(k);
for (const k of allPlayerKeys) {
  const flag = SUSPECT.test(k) ? '  <-- SUSPECT' : '';
  console.log(`  ${k}${flag}`);
}

console.log('\n--- counts by status ---');
const counts = new Map();
for (const p of rawPlayers) counts.set(p.status || '(none)', (counts.get(p.status || '(none)') || 0) + 1);
for (const [status, n] of counts) console.log(`  ${status}: ${n}`);
console.log(`  TOTAL: ${rawPlayers.length}`);

console.log('\n=== verdict ===');
console.log('Read the SUSPECT-flagged lines above by hand — this prints candidates, it does not decide anything.');
console.log('If nothing usable turned up, the counts-by-status block above plus TYPE=league\'s limits (if any appeared)');
console.log('are what a client-side check would compare, the same way the power score works from raw fields rather than a provided verdict.');
