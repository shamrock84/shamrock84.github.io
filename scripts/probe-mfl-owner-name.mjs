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
//
// RUN #3 RESULTS (actual): the set of leagues showing owner_name was
// COMPLETELY DIFFERENT from the committed data/rosters.json snapshot taken
// hours earlier — May Rookies/July Semiquincentennial/July FFL for Dummies
// showed it this time, where the snapshot had shown Iron Bank/Wise
// Guys/April Pre-NFL Draft/June Tecmo Ball instead, with zero overlap. A
// per-league fact (privacy setting, commissioner assignment, anything MFL
// stores against the league) cannot change between two reads taken the same
// day with nothing in between editing it — so run #2's frame ("this is a
// property of the league") was ALSO wrong, not just "commissioner access"
// specifically. And `abilities` — which requires the request to be
// recognized as a logged-in league member at all — came back "API requires
// logged in user" for 12 of 15 leagues, including leagues this project's own
// browser session is unquestionably the commissioner of (league 26696 /
// MNMx Dynasty: the Request Details PDF was captured mid-session while
// logged in as "melbosffl: Rumble Fish (Logout | Become Commissioner)" on
// that exact league). A session that IS privileged in the browser reading
// back as anonymous over the API, inconsistently across requests, points at
// a transport problem, not a permissions one.
//
// mflLoginForImport's own comment (same file, ~line 186) already diagnosed
// this exact failure mode for a different call: "the generic
// api.myfantasyleague.com host doesn't recognize the league-scoped session
// even though the cookie itself is domain-wide (.myfantasyleague.com) and
// present either way" — which is why lineup submission logs in scoped to
// L=<leagueId> and sends the import to the host that login redirects to,
// rather than the shared host. mflGet — used for every read in this
// project, including every owner-name-bearing call above — always targets
// the hardcoded `api.myfantasyleague.com`, never a league's own `baseURL`
// (present in every league object dumped above, e.g. "www43", "www46").
// Nothing about reads was ever changed to match the fix imports already
// needed. Run #4 tests exactly this: re-request TYPE=league for every
// league directly against its own baseURL (same cookie, no new login)
// alongside the existing api.myfantasyleague.com read, to see whether the
// correctly-hosted request reliably surfaces owner_name where the generic
// host doesn't.
//
// RUN #4 RESULTS (confirmed): every single one of the 15 MFL leagues in
// config/leagues.json returned real owner_name (and a real, populated
// `abilities` response — not the "API requires logged in user" error the
// generic host gave on almost every league) when queried directly against
// its own baseURL, with zero exceptions and zero failed requests. The
// generic host that run showed owner_name for only 2 of 15 (a different 2
// than run #3's 3, which was a different 4 than the committed snapshot's
// 4 — three runs, three different random subsets, no stable pattern).
// Verdict: this was never about who is or isn't the commissioner of a
// league. It was mflGet's hardcoded api.myfantasyleague.com host randomly
// failing to carry a genuinely privileged session through to MFL's
// backend for that specific league — exactly what mflLoginForImport's own
// comment already described, just never fixed on the read side. Fixed in
// this commit: fetchMflOwnerNames (providers.mjs) re-requests TYPE=league
// against each league's own baseURL specifically to extract owner names,
// wired into fetch-rosters.mjs's mflFranchiseInfoById and into
// fetchMflFranchiseNames (shared with api/live-scoring.js). One extra MFL
// request per MFL league where owner names are actually read — never on
// the hot path, and it degrades to an empty map (never throws) on failure,
// same as every other MFL fetch in this project.
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

// Bypasses mflGet's hardcoded api.myfantasyleague.com host — this is the
// whole point of run #4. Same cookie, same request, only the host differs.
async function hostGet(host, path, cookie) {
  const res = await fetch(`${host}${path}`, { headers: cookie ? { Cookie: cookie } : {}, redirect: 'follow' });
  if (!res.ok) {
    const err = new Error(`request failed (${res.status}): ${host}${path}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function franchiseListOf(data) {
  const franchises = data?.league?.franchises?.franchise ?? [];
  return Array.isArray(franchises) ? franchises : franchises ? [franchises] : [];
}

function hasOwnerName(franchiseList) {
  return franchiseList.some((f) => OWNER_KEY.test(Object.keys(f).join(',')) && f.owner_name);
}

const cookie = await mflLogin(process.env.MFL_USERNAME, process.env.MFL_PASSWORD);

const genericShows = [];
const genericNo = [];
const hostShows = [];
const hostNo = [];
const hostFailed = [];

for (const league of mflLeagues) {
  console.log(`\n=== ${league.name} (${league.id}, type=${league.type}, our franchiseId=${league.franchiseId}) ===`);
  try {
    const data = await mflGet(`/export?TYPE=league&L=${league.id}&JSON=1`, cookie, seasonOf(league));

    const leagueObj = data?.league || {};
    const { franchises, divisions, ...leagueRest } = leagueObj;
    console.log('  [generic host] FULL league-level object (minus franchises/divisions):', JSON.stringify(leagueRest));

    const franchiseList = franchiseListOf(data);
    const genericOwnerName = hasOwnerName(franchiseList);
    (genericOwnerName ? genericShows : genericNo).push(league.name);

    console.log(`  [generic host] owner_name present: ${genericOwnerName ? 'YES' : 'no'}`);
    console.log(`  [generic host] FULL raw franchise list (${franchiseList.length}):`);
    for (const f of franchiseList) {
      console.log(`    ${JSON.stringify(f)}`);
    }

    try {
      const abilities = await mflGet(`/export?TYPE=abilities&L=${league.id}&DETAILS=1&JSON=1`, cookie, seasonOf(league));
      console.log('  [generic host] abilities (current franchise):', JSON.stringify(abilities));
    } catch (err) {
      console.log(`  [generic host] abilities FAILED: ${err.message}`);
    }

    // RUN #4: re-request the exact same TYPE=league call, same cookie, but
    // sent directly to this league's own baseURL instead of the shared
    // api.myfantasyleague.com host — testing mflLoginForImport's own
    // diagnosis of the identical problem on a different call.
    const year = seasonOf(league);
    const baseURL = leagueRest.baseURL;
    if (!baseURL) {
      console.log('  [own host] no baseURL on the league object — cannot test.');
      continue;
    }
    try {
      const hostData = await hostGet(baseURL, `/${year}/export?TYPE=league&L=${league.id}&JSON=1`, cookie);
      const hostFranchiseList = franchiseListOf(hostData);
      const hostOwnerName = hasOwnerName(hostFranchiseList);
      (hostOwnerName ? hostShows : hostNo).push(league.name);
      console.log(`  [own host ${baseURL}] owner_name present: ${hostOwnerName ? 'YES' : 'no'}`);
      if (hostOwnerName !== genericOwnerName) {
        console.log(`  [own host ${baseURL}] *** DIFFERS from generic-host result *** raw franchises:`);
        for (const f of hostFranchiseList) console.log(`    ${JSON.stringify(f)}`);
      }
      try {
        const hostAbilities = await hostGet(baseURL, `/${year}/export?TYPE=abilities&L=${league.id}&DETAILS=1&JSON=1`, cookie);
        console.log(`  [own host ${baseURL}] abilities:`, JSON.stringify(hostAbilities));
      } catch (err) {
        console.log(`  [own host ${baseURL}] abilities FAILED: ${err.message}`);
      }
    } catch (err) {
      hostFailed.push(league.name);
      console.log(`  [own host ${baseURL}] FAILED: ${err.message}`);
    }
  } catch (err) {
    console.log(`  FAILED: ${err.message}`);
  }
}

console.log('\n=== verdict ===');
console.log('Generic host (api.myfantasyleague.com) shows owner_name:', genericShows.join(', ') || '(none)');
console.log('Generic host does NOT show owner_name:', genericNo.join(', ') || '(none)');
console.log("League's own baseURL host shows owner_name:", hostShows.join(', ') || '(none)');
console.log("League's own baseURL host does NOT show owner_name:", hostNo.join(', ') || '(none)');
console.log('Own-host requests that failed outright:', hostFailed.join(', ') || '(none)');
console.log('If the own-host column reliably shows owner_name for leagues the manager actually commissions');
console.log('(regardless of what the generic host showed), that confirms mflGet\'s hardcoded');
console.log('api.myfantasyleague.com host is the real bug — the same host-routing problem');
console.log('mflLoginForImport already documented and worked around for lineup submission, never applied to reads.');
