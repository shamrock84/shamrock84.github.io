#!/usr/bin/env node
// One-off diagnostic: dump the raw MFL API shapes for TYPE=league and
// TYPE=rosters on an auction/salary-cap league, to find the field names for
// salary adjustments / salary cap / cap room. Not part of the regular sync —
// delete once the real fields are confirmed and wired into providers.mjs.

import { mflLogin } from './lib/providers.mjs';

const YEAR = new Date().getFullYear();
const BASE = `https://api.myfantasyleague.com/${YEAR}`;

async function mflGet(path, cookie) {
  const res = await fetch(`${BASE}${path}`, { headers: { Cookie: cookie } });
  return res.json();
}

async function main() {
  const username = process.env.MFL_USERNAME;
  const password = process.env.MFL_PASSWORD;
  const cookie = await mflLogin(username, password);

  const leagueId = '35217'; // Iron Bank
  const franchiseId = '0004';

  const leagueData = await mflGet(`/export?TYPE=league&L=${leagueId}&JSON=1`, cookie);
  console.log('=== TYPE=league top-level keys ===');
  console.log(Object.keys(leagueData.league || {}));

  const franchises = leagueData?.league?.franchises?.franchise ?? [];
  const franchiseInfo = Array.isArray(franchises) ? franchises.find((f) => f.id === franchiseId) : franchises;
  console.log('=== franchise entry (all attrs) ===');
  console.log(JSON.stringify(franchiseInfo, null, 2));

  console.log('=== league salary/cap related top-level fields ===');
  for (const [k, v] of Object.entries(leagueData.league || {})) {
    if (/salary|cap/i.test(k)) console.log(k, '=', JSON.stringify(v));
  }

  const rostersData = await mflGet(`/export?TYPE=rosters&L=${leagueId}&FRANCHISE=${franchiseId}&JSON=1`, cookie);
  const rosterFranchise = Array.isArray(rostersData?.rosters?.franchise)
    ? rostersData.rosters.franchise[0]
    : rostersData?.rosters?.franchise;
  console.log('=== TYPE=rosters franchise-level keys (non-player) ===');
  const { player, ...rest } = rosterFranchise || {};
  console.log(JSON.stringify(rest, null, 2));

  // Also try the dedicated salary adjustments export, if it exists.
  try {
    const salaryAdj = await mflGet(`/export?TYPE=salaryAdjustments&L=${leagueId}&FRANCHISE=${franchiseId}&JSON=1`, cookie);
    console.log('=== TYPE=salaryAdjustments ===');
    console.log(JSON.stringify(salaryAdj, null, 2));
  } catch (err) {
    console.log('TYPE=salaryAdjustments failed:', err.message);
  }

  // Also try rosterExtras (some MFL setups return salary adjustment there).
  try {
    const extras = await mflGet(`/export?TYPE=rosters&L=${leagueId}&FRANCHISE=${franchiseId}&SALARY_ADJUSTMENTS=1&JSON=1`, cookie);
    console.log('=== TYPE=rosters with SALARY_ADJUSTMENTS=1 (franchise-level, non-player) ===');
    const rf2 = Array.isArray(extras?.rosters?.franchise) ? extras.rosters.franchise[0] : extras?.rosters?.franchise;
    const { player: p2, ...rest2 } = rf2 || {};
    console.log(JSON.stringify(rest2, null, 2));
  } catch (err) {
    console.log('SALARY_ADJUSTMENTS=1 failed:', err.message);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
