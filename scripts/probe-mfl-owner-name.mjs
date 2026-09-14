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
// tried that on the same three leagues — also nothing. MFL's own API docs
// (api_info page, pasted by the user mid-session) say:
//
//   "league: ... If you pass the cookie of a user with commissioner access,
//   it will return otherwise private owner information, like owner names,
//   email addresses, etc. ... Personal user information, like name and
//   email addresses only returned to league owners."
//
// Run #2's own verdict treated "an owner-shaped key showed up" as proof of
// commissioner access — but that's the docs' claim assumed true, not an
// independent check. Nothing in run #2 ever confirmed commissioner status
// against anything other than the very field it was trying to explain.
//
// Run #3 (2026-09-14) is that independent check, and it falsifies the
// theory: the project's manager confirmed directly that the account is NOT
// commissioner on any of the four leagues currently showing owner names
// (Iron Bank, Wise Guys, April Pre-NFL Draft, June Tecmo Ball) and IS
// commissioner on three leagues that don't (per config/leagues.json this is
// almost certainly MNMx Dynasty/OSD/Survivor, the only three-or-so where
// the account's own franchiseId looks like the founding owner). So
// "commissioner access gates it" is wrong, or at least not the whole
// picture — the docs describe MFL's intent, not what this project's actual
// account sees. Two things support a *per-league, not per-session* gate
// instead: (1) the field is all-or-nothing per league in the committed
// snapshot (Iron Bank shows 11/12, not some fraction spread evenly — a
// single unclaimed franchise, not a partial reveal) rather than varying
// franchise-by-franchise the way a per-owner privacy toggle would; and (2)
// leagues in the same apparent commissioner's monthly-draft family (April
// Pre-NFL Draft, May Rookies, June Tecmo Ball, July Semiquincentennial, July
// FFL for Dummies, August Judgment Day) split 2-for/4-against with no
// obvious pattern by type or date, which rules out "this account's role in
// the league" as a explanation on its own.
//
// This run stops inferring from SUSPECT-key presence and instead dumps
// everything unfiltered: every league-level key (not just suspect-matching
// ones — hunting for a privacy/visibility setting the commissioner of THAT
// league controls, independent of who's asking), the full raw franchise
// list with no key filtering at all, and the `abilities` endpoint (which
// per the docs returns 0/1 flags for "the current franchise" — closer to a
// ground-truth commissioner signal than inferring it from owner_name).
// Compare the dumps between a league that shows owner names and one that
// doesn't to find what actually differs.
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

const OWNER_KEY = /owner_name/i;

const cookie = await mflLogin(process.env.MFL_USERNAME, process.env.MFL_PASSWORD);

const showsOwnerName = [];
const doesNotShowOwnerName = [];

for (const league of mflLeagues) {
  console.log(`\n=== ${league.name} (${league.id}, type=${league.type}, our franchiseId=${league.franchiseId}) ===`);
  try {
    const data = await mflGet(`/export?TYPE=league&L=${league.id}&JSON=1`, cookie, seasonOf(league));

    const leagueObj = data?.league || {};
    const { franchises, divisions, ...leagueRest } = leagueObj;
    console.log('  FULL league-level object (minus franchises/divisions):', JSON.stringify(leagueRest));

    const franchiseList = Array.isArray(franchises?.franchise)
      ? franchises.franchise
      : franchises?.franchise
        ? [franchises.franchise]
        : [];
    const anyOwnerName = franchiseList.some((f) => OWNER_KEY.test(Object.keys(f).join(',')) && f.owner_name);
    (anyOwnerName ? showsOwnerName : doesNotShowOwnerName).push(league.name);

    console.log(`  owner_name present: ${anyOwnerName ? 'YES' : 'no'}`);
    console.log(`  FULL raw franchise list (${franchiseList.length}):`);
    for (const f of franchiseList) {
      console.log(`    ${JSON.stringify(f)}`);
    }

    try {
      const abilities = await mflGet(`/export?TYPE=abilities&L=${league.id}&DETAILS=1&JSON=1`, cookie, seasonOf(league));
      console.log('  abilities (current franchise):', JSON.stringify(abilities));
    } catch (err) {
      console.log(`  abilities FAILED: ${err.message}`);
    }
  } catch (err) {
    console.log(`  FAILED: ${err.message}`);
  }
}

console.log('\n=== verdict ===');
console.log('Shows owner_name:', showsOwnerName.join(', ') || '(none)');
console.log('Does NOT show owner_name:', doesNotShowOwnerName.join(', ') || '(none)');
console.log('Cross-reference this against which leagues the manager actually commissions (told directly, not');
console.log('inferred) and diff the FULL league-level and franchise dumps above between a showing and a');
console.log('non-showing league to find the real distinguishing field — do not re-assume commissioner access');
console.log('gates this without an independent confirmation this time.');
