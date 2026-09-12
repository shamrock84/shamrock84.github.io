#!/usr/bin/env node
// Asks whether MFL's TYPE=league export exposes anything owner/manager-name
// shaped per franchise, the same question probe-espn-team-owners.mjs
// answered for ESPN (confirmed: owners[]/members[], now shown as "Team Name
// (Owner)" on the Standings/Scoring cards for the two ESPN redraft leagues).
// Nothing in this project has ever read anything owner-shaped off MFL —
// mflFranchiseNames only reads `f.name` — so nothing here can be assumed.
//
// Run #1 (2026-09-08, cookie session auth, one dynasty/one salarycap/one
// draftonly league) found nothing owner-shaped in any franchise object.
//
// Run #2 first suspected the missing ingredient was python-mfl's documented
// PASSWORD+FRANCHISE_ID request params (github.com/mikeplis/python-mfl) and
// tried that on the same three leagues — also nothing. But MFL's own API
// docs (api_info page, pasted by the user mid-session) settle what actually
// gates this field:
//
//   "league: ... If you pass the cookie of a user with commissioner access,
//   it will return otherwise private owner information, like owner names,
//   email addresses, etc. ... Personal user information, like name and
//   email addresses only returned to league owners."
//
// So it's neither FRANCHISE_ID nor PASSWORD — it's whether the account
// behind the session cookie holds COMMISSIONER access for THAT league. That
// is a per-league fact having nothing to do with league type, which is why
// sampling one league per type (runs #1-#2) could never answer it: it needs
// checking against every MFL league this project's own account is in, to
// see which (if any) it commissions. Plain cookie auth only this time —
// mflGet's own production auth path, nothing extra to prove.
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

const SUSPECT = /owner|manager|email|user|real.?name|first.?name|last.?name|contact/i;

const cookie = await mflLogin(process.env.MFL_USERNAME, process.env.MFL_PASSWORD);

const commissionerLeagues = [];

for (const league of mflLeagues) {
  console.log(`\n=== ${league.name} (${league.id}, type=${league.type}) ===`);
  try {
    const data = await mflGet(`/export?TYPE=league&L=${league.id}&JSON=1`, cookie, seasonOf(league));

    const leagueKeys = Object.keys(data?.league || {});
    const suspectLeagueKeys = leagueKeys.filter((k) => SUSPECT.test(k));

    const franchises = data?.league?.franchises?.franchise ?? [];
    const franchiseList = Array.isArray(franchises) ? franchises : [franchises];
    const allFranchiseKeys = new Set();
    for (const f of franchiseList) for (const k of Object.keys(f)) allFranchiseKeys.add(k);
    const suspectFranchiseKeys = [...allFranchiseKeys].filter((k) => SUSPECT.test(k));

    if (suspectFranchiseKeys.length === 0 && suspectLeagueKeys.length === 0) {
      console.log('  no owner-shaped keys — this account is not the commissioner here.');
      continue;
    }

    console.log('  SUSPECT league-level keys:', suspectLeagueKeys.join(', ') || '(none)');
    console.log('  SUSPECT franchise keys:', suspectFranchiseKeys.join(', ') || '(none)');
    console.log(`  franchise keys (union across ${franchiseList.length}):`, [...allFranchiseKeys].join(', '));
    for (const f of franchiseList) {
      console.log(`    ${JSON.stringify(f)}`);
    }
    commissionerLeagues.push(league.name);
  } catch (err) {
    console.log(`  FAILED: ${err.message}`);
  }
}

console.log('\n=== verdict ===');
if (commissionerLeagues.length === 0) {
  console.log('No MFL league in the config returned an owner-shaped field. Per MFL\'s own API docs, that means');
  console.log('this account does not hold commissioner access on any of them — commissioner status, not league');
  console.log('type or request params, is what gates the field. "Team Name (Owner)" for MFL would need a');
  console.log('different source (a manual per-league config field, most likely) rather than a sync-time fetch.');
} else {
  console.log(`Commissioner access confirmed on: ${commissionerLeagues.join(', ')}. Only these leagues can get`);
  console.log('owner names from a sync-time fetch; every other MFL league still needs a different source.');
}
