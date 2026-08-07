#!/usr/bin/env node
// Asks MFL what it actually says about a league in a season that may not exist
// yet, and prints the raw answer.
//
// Why this exists: resolveSeason in fetch-rosters.mjs decides whether a league
// has rolled over by asking whether it exists in the target season. That answer
// is only as good as the detection, and MFL's behaviour for a missing
// league-year isn't documented — it could be an HTTP error, or a 200 carrying
// an <error> body, which mflGet would hand back as a perfectly ordinary
// success. mflLeagueExists is written to treat both as absence; this script is
// how that gets confirmed against the real API rather than assumed.
//
// Run it from the Actions tab (probe-mfl-season.yml) against a league you know
// exists in the current season and a season far enough ahead that it can't —
// the useful comparison is the two side by side.
//
// Read-only: TYPE=league exports. Nothing is written to any provider.

import { mflLogin, mflGet, mflLeagueExists, YEAR } from './lib/providers.mjs';

const LEAGUE_ID = process.env.PROBE_LEAGUE_ID;
const SEASONS = (process.env.PROBE_SEASONS || `${YEAR},${Number(YEAR) + 1}`)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!LEAGUE_ID) {
  console.error('PROBE_LEAGUE_ID is required (a league id from config/leagues.json).');
  process.exit(1);
}

const cookie = await mflLogin(process.env.MFL_USERNAME, process.env.MFL_PASSWORD);
console.log(`Probing league ${LEAGUE_ID} across seasons: ${SEASONS.join(', ')}\n`);

for (const season of SEASONS) {
  console.log(`--- ${season} ---`);

  // The raw request first, so the actual response shape is visible whatever it
  // turns out to be — this is the part that can't be guessed from here.
  try {
    const raw = await mflGet(`/export?TYPE=league&L=${LEAGUE_ID}&JSON=1`, cookie, season);
    const keys = raw && typeof raw === 'object' ? Object.keys(raw) : [];
    console.log(`  raw: resolved, top-level keys: ${JSON.stringify(keys)}`);
    if (raw?.error) console.log(`  raw: carries an "error" field: ${JSON.stringify(raw.error)}`);
    if (raw?.league) {
      console.log(`  raw: league.id=${JSON.stringify(raw.league.id)} league.name=${JSON.stringify(raw.league.name)}`);
    }
    console.log(`  body (first 400 chars): ${JSON.stringify(raw).slice(0, 400)}`);
  } catch (err) {
    console.log(`  raw: threw — ${err.message}`);
  }

  // Then the verdict the sync would actually reach.
  const verdict = await mflLeagueExists({ id: LEAGUE_ID }, cookie, season);
  console.log(`  mflLeagueExists -> ${verdict}\n`);
}

console.log('Expected: true for a season the league is in, false for one it is not.');
console.log('If a season the league is NOT in comes back true, mflLeagueExists needs');
console.log('to account for whatever shape the body above actually has.');
