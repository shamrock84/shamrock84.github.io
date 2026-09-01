// Answers the question behind head-to-head pairing on the Scoring tab:
// TYPE=liveScoring (what fetchScoring uses) is a flat per-franchise list —
// no opponent field has ever been read off it. Two candidate sources for
// pairing, checked here before writing any parsing code:
//
//   1. TYPE=liveScoring itself — does the whole-league response secretly
//      carry an opponent id per franchise that nothing has ever looked for?
//   2. TYPE=league — this is already fetched every poll for franchise names
//      (fetchMflFranchiseNames, cached 1h in live-scoring.js), so if it also
//      carries a static season schedule (franchise pairs per week), pairing
//      is free: no new request, no new rate-limit cost, no change to the
//      live-scoring proxy's request budget.
//
// Read-only. Run from the Actions tab (probe-live-scoring-matchup.yml).
import { mflLogin, mflGet, seasonOf } from './lib/providers.mjs';

const MFL_LEAGUE_ID = process.env.PROBE_MFL_LEAGUE_ID;
const WEEK = process.env.PROBE_WEEK || '1';

if (!MFL_LEAGUE_ID) {
  console.log('PROBE_MFL_LEAGUE_ID is required.');
  process.exit(1);
}

const league = { id: MFL_LEAGUE_ID };
const year = seasonOf(league);
console.log(`\n=== MFL league ${MFL_LEAGUE_ID}, season ${year}, week ${WEEK} ===\n`);

const cookie = await mflLogin(process.env.MFL_USERNAME, process.env.MFL_PASSWORD);

console.log('--- TYPE=liveScoring (whole league, no FRANCHISE_ID) ---');
try {
  const liveData = await mflGet(`/export?TYPE=liveScoring&L=${MFL_LEAGUE_ID}&W=${WEEK}&JSON=1`, cookie, year);
  console.log(JSON.stringify(liveData, null, 2));
} catch (err) {
  console.log(`  liveScoring failed: ${err.message}`);
}

console.log('\n--- TYPE=liveScoring, scoped to one FRANCHISE_ID (does scoping in the opponent?) ---');
try {
  const leagueDataForFranchise = await mflGet(`/export?TYPE=league&L=${MFL_LEAGUE_ID}&JSON=1`, cookie, year);
  const franchises = leagueDataForFranchise?.league?.franchises?.franchise ?? [];
  const franchiseList = Array.isArray(franchises) ? franchises : [franchises];
  const firstId = franchiseList[0]?.id;
  if (firstId) {
    const scoped = await mflGet(
      `/export?TYPE=liveScoring&L=${MFL_LEAGUE_ID}&W=${WEEK}&FRANCHISE_ID=${firstId}&JSON=1`,
      cookie,
      year
    );
    console.log(JSON.stringify(scoped, null, 2));
  } else {
    console.log('  no franchise id found to scope with');
  }
} catch (err) {
  console.log(`  scoped liveScoring failed: ${err.message}`);
}

console.log('\n--- TYPE=league (full body — looking for a schedule/matchup section) ---');
try {
  const leagueData = await mflGet(`/export?TYPE=league&L=${MFL_LEAGUE_ID}&JSON=1`, cookie, year);
  const keys = Object.keys(leagueData?.league || {});
  console.log(`  top-level league keys: ${keys.join(', ')}`);
  if (leagueData?.league?.schedule) {
    console.log('  FOUND schedule key — full contents:');
    console.log(JSON.stringify(leagueData.league.schedule, null, 2));
  } else {
    console.log('  no "schedule" key present.');
  }
} catch (err) {
  console.log(`  TYPE=league failed: ${err.message}`);
}

console.log('\n--- TYPE=weeklyResults for the same week (does it carry live/partial scores pre-kickoff?) ---');
try {
  const weeklyData = await mflGet(`/export?TYPE=weeklyResults&L=${MFL_LEAGUE_ID}&W=${WEEK}&JSON=1`, cookie, year);
  console.log(JSON.stringify(weeklyData, null, 2));
} catch (err) {
  console.log(`  weeklyResults failed: ${err.message}`);
}

console.log('\n=== done ===');
