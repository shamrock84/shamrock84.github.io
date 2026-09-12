#!/usr/bin/env node
// Asks whether MFL's TYPE=league export exposes anything owner/manager-name
// shaped per franchise, the same question probe-espn-team-owners.mjs
// answered for ESPN (confirmed: owners[]/members[], now shown as "Team Name
// (Owner)" on the Standings/Scoring cards for the two ESPN redraft leagues).
// Nothing in this project has ever read anything owner-shaped off MFL —
// mflFranchiseNames only reads `f.name` — so nothing here can be assumed.
//
// Run #1 (2026-09-08, cookie session auth only — the same auth mflGet uses
// everywhere else in this project) found nothing: every franchise object
// carried only cosmetic/team-level fields — icon, division, name,
// waiverSortOrder, id, logo, sound, stadium, abbrev (salarycap adds
// salaryCapAmount) — nothing person-shaped, and no league-level key
// suggested one either.
//
// That wasn't the full answer. python-mfl (github.com/mikeplis/python-mfl)
// documents its league() call as: "If a valid password and franchise_id
// combination are supplied, it also returns otherwise private information
// about the league owners like names and email addresses" — and its call
// passes PASSWORD/FRANCHISE_ID as request PARAMETERS on the TYPE=league
// export itself, not as a prior cookie login. Run #1 never tried that: it
// authenticated with mflLogin's cookie and never added FRANCHISE_ID or
// PASSWORD to the TYPE=league query string. So this run also tries that
// exact shape, both instead of and alongside the cookie, to see whether
// MFL's franchise objects grow owner-shaped fields under it.
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

function dumpFranchiseKeys(label, league, data) {
  console.log(`  -- ${label} --`);
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
}

const cookie = await mflLogin(process.env.MFL_USERNAME, process.env.MFL_PASSWORD);

for (const league of samples) {
  console.log(`\n=== ${league.name} (${league.id}, type=${league.type}) ===`);

  try {
    const data = await mflGet(`/export?TYPE=league&L=${league.id}&JSON=1`, cookie, seasonOf(league));
    dumpFranchiseKeys('cookie session only (the auth mflGet uses everywhere else)', league, data);
  } catch (err) {
    console.log(`  cookie-session variant FAILED: ${err.message}`);
  }

  // python-mfl's league() call: PASSWORD + FRANCHISE_ID as request params on
  // the TYPE=league export itself, which its own docstring says is what
  // unlocks "otherwise private information about the league owners like
  // names and email addresses". Tried both stacked on the cookie session
  // and on a bare unauthenticated request, in case the cookie interferes.
  const franchiseParams = `&FRANCHISE_ID=${league.franchiseId}&PASSWORD=${encodeURIComponent(process.env.MFL_PASSWORD)}`;
  try {
    const data = await mflGet(`/export?TYPE=league&L=${league.id}${franchiseParams}&JSON=1`, cookie, seasonOf(league));
    dumpFranchiseKeys('cookie session + FRANCHISE_ID/PASSWORD params', league, data);
  } catch (err) {
    console.log(`  cookie + FRANCHISE_ID/PASSWORD variant FAILED: ${err.message}`);
  }

  try {
    const data = await mflGet(`/export?TYPE=league&L=${league.id}${franchiseParams}&JSON=1`, null, seasonOf(league));
    dumpFranchiseKeys('no cookie, FRANCHISE_ID/PASSWORD params only', league, data);
  } catch (err) {
    console.log(`  no-cookie FRANCHISE_ID/PASSWORD variant FAILED: ${err.message}`);
  }
}

console.log('\n=== verdict ===');
console.log('If no key above was flagged SUSPECT in ANY of the three variants, and no dumped franchise object');
console.log('carries anything name-shaped beyond the team `name` itself, MFL\'s public league export does not');
console.log('expose an owner identity the way ESPN\'s members[] does — "Team Name (Owner)" would need a');
console.log('different source (a manual per-league config field, most likely) rather than a sync-time fetch.');
