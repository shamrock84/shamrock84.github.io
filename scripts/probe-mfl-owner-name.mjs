#!/usr/bin/env node
// Asks whether MFL's TYPE=league export exposes anything owner/manager-name
// shaped per franchise, the same question probe-espn-team-owners.mjs
// answered for ESPN (confirmed: owners[]/members[], now shown as "Team Name
// (Owner)" on the Standings/Scoring cards for the two ESPN redraft leagues).
// Nothing in this project has ever read anything owner-shaped off MFL —
// mflFranchiseNames only reads `f.name` — so nothing here can be assumed.
//
// Unlike ESPN's fantasy API, MFL franchises are commonly understood (from
// community use, never checked against this project's own leagues before
// now) to NOT expose the real person behind a franchise via the public
// league-export API — a franchise's owner is a separate MFL user account
// the export doesn't name, likely for the same privacy reason MFL requires
// a login at all. This probe exists to check that assumption against real
// data instead of taking it on faith, across all three league types (a
// dynasty, a salary-cap, and a draft-only league) in case the shape differs
// by type.
//
// This exists because api.myfantasyleague.com is unreachable from the
// sandbox this repo is normally edited from, so a workflow run is the only
// place to ask. Read-only: one TYPE=league GET per sampled league.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mflLogin, mflGet, seasonOf } from './lib/providers.mjs';

const CONFIG_PATH = fileURLToPath(new URL('../config/leagues.json', import.meta.url));
const { leagues } = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));

const mflLeagues = leagues.filter((l) => !l.provider || l.provider === 'mfl');
if (mflLeagues.length === 0) {
  console.log('No MFL leagues in config/leagues.json — nothing to probe.');
  process.exit(0);
}

// One representative per type, not every MFL league — the question is
// "does the shape carry owner data at all, and does it differ by type,"
// which three leagues answer as well as fifteen would.
const sampleTypes = ['dynasty', 'salarycap', 'draftonly'];
const samples = sampleTypes
  .map((type) => mflLeagues.find((l) => l.type === type))
  .filter(Boolean);

const SUSPECT = /owner|manager|email|user|real.?name|first.?name|last.?name|contact/i;

const cookie = await mflLogin(process.env.MFL_USERNAME, process.env.MFL_PASSWORD);

for (const league of samples) {
  console.log(`\n=== ${league.name} (${league.id}, type=${league.type}) ===`);
  try {
    const data = await mflGet(`/export?TYPE=league&L=${league.id}&JSON=1`, cookie, seasonOf(league));

    console.log('  league-level keys:');
    for (const k of Object.keys(data?.league || {})) {
      const flag = SUSPECT.test(k) ? '  <-- SUSPECT' : '';
      console.log(`    ${k}${flag}`);
    }

    const franchises = data?.league?.franchises?.franchise ?? [];
    const franchiseList = Array.isArray(franchises) ? franchises : [franchises];

    const allKeys = new Set();
    for (const f of franchiseList) for (const k of Object.keys(f)) allKeys.add(k);
    console.log(`  franchise keys (union across ${franchiseList.length} franchises):`);
    for (const k of allKeys) {
      const flag = SUSPECT.test(k) ? '  <-- SUSPECT' : '';
      console.log(`    ${k}${flag}`);
    }

    const mine = franchiseList.find((f) => f.id === league.franchiseId);
    console.log(`  this league's own franchise (id=${league.franchiseId}), full object:`);
    console.log(`    ${JSON.stringify(mine)}`);

    console.log(`  a different franchise's full object, for comparison:`);
    const other = franchiseList.find((f) => f.id !== league.franchiseId);
    console.log(`    ${JSON.stringify(other)}`);
  } catch (err) {
    console.log(`  FAILED: ${err.message}`);
  }
}

console.log('\n=== verdict ===');
console.log('If no key above was flagged SUSPECT, and neither dumped franchise object carries anything');
console.log('name-shaped beyond the team `name` itself, MFL\'s public league export does not expose an owner');
console.log('identity the way ESPN\'s members[] does — "Team Name (Owner)" would need a different source (a');
console.log('manual per-league config field, most likely) rather than a sync-time fetch.');
