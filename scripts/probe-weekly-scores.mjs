// Asks MFL what it actually exposes about a past, fully-completed season's
// week-by-week scoring — the History tab wants two new numbers per season
// (highest single-week score, highest season point total) for leagues that
// pay out on them, and nothing in this codebase has ever parsed a
// franchise-level total score off TYPE=weeklyResults. Two open questions:
//
//   1. Does a franchise entry in TYPE=weeklyResults carry its own total
//      `score` field directly, or does it have to be summed from each
//      player's individual `score`? (fetchMflLineup, the only existing
//      reader of this endpoint, only ever reads player-level `status` for
//      the lineup pilot — it has never needed the total.)
//   2. Does TYPE=leagueStandings' `pf` (points-for) match the SUM of regular-
//      season weekly totals exactly, or does it also fold in playoff weeks?
//      If it matches, `pf` is a free season-point-total (leagueStandings is
//      already fetched during the History bracket backfill, at zero extra
//      request cost) instead of something that has to be summed from
//      per-week fetches.
//
// Read-only. Run from the Actions tab (probe-weekly-scores.yml).
import { mflLogin, mflGet } from './lib/providers.mjs';

const MFL_LEAGUE_ID = process.env.PROBE_MFL_LEAGUE_ID;
const YEAR = process.env.PROBE_YEAR;

if (!MFL_LEAGUE_ID || !YEAR) {
  console.log('PROBE_MFL_LEAGUE_ID and PROBE_YEAR are both required.');
  process.exit(1);
}

console.log(`\n=== MFL league ${MFL_LEAGUE_ID}, season ${YEAR} ===\n`);
const cookie = await mflLogin(process.env.MFL_USERNAME, process.env.MFL_PASSWORD);

console.log('--- TYPE=league (lastRegularSeasonWeek / endWeek / franchise names) ---');
const leagueData = await mflGet(`/export?TYPE=league&L=${MFL_LEAGUE_ID}&JSON=1`, cookie, YEAR);
const lastRegWeek = Number(leagueData?.league?.lastRegularSeasonWeek);
const endWeek = Number(leagueData?.league?.endWeek);
console.log(`  lastRegularSeasonWeek=${lastRegWeek} endWeek=${endWeek}`);
const franchises = leagueData?.league?.franchises?.franchise ?? [];
const franchiseList = Array.isArray(franchises) ? franchises : [franchises];
const nameById = new Map(franchiseList.map((f) => [f.id, f.name]));
console.log(`  franchises: ${franchiseList.length}`);

console.log('\n--- TYPE=leagueStandings (pf/pa per franchise, full first row) ---');
const standingsData = await mflGet(`/export?TYPE=leagueStandings&L=${MFL_LEAGUE_ID}&JSON=1`, cookie, YEAR);
const rawRows = standingsData?.leagueStandings?.franchise;
const standingsRows = Array.isArray(rawRows) ? rawRows : rawRows ? [rawRows] : [];
console.log(`  rows: ${standingsRows.length}`);
if (standingsRows.length) console.log(`  first row (every field): ${JSON.stringify(standingsRows[0])}`);
const pfById = new Map(standingsRows.map((r) => [r.id, Number(r.pf ?? NaN)]));

if (!Number.isFinite(lastRegWeek) || lastRegWeek < 1) {
  console.log('\n  lastRegularSeasonWeek not resolved — cannot probe weekly totals. Stopping.');
  process.exit(0);
}

console.log(`\n--- TYPE=weeklyResults for weeks 1..${lastRegWeek} (regular season) ---`);
// franchiseId -> array of that week's total, indexed by week number (1-based
// entries at index week-1) so a missing week is visibly `undefined` rather
// than silently absent from a sum.
const weeklyTotalsById = new Map();
let sawOwnScoreField = null; // true/false/'mixed' once we've seen at least one franchise entry

for (let week = 1; week <= lastRegWeek; week++) {
  const data = await mflGet(`/export?TYPE=weeklyResults&L=${MFL_LEAGUE_ID}&W=${week}&JSON=1`, cookie, YEAR);
  const matchups = data?.weeklyResults?.matchup;
  const matchupList = Array.isArray(matchups) ? matchups : matchups ? [matchups] : [];
  const seenThisWeek = [];
  for (const m of matchupList) {
    const franchisesInMatchup = Array.isArray(m.franchise) ? m.franchise : m.franchise ? [m.franchise] : [];
    for (const f of franchisesInMatchup) {
      const hasOwnScore = f.score !== undefined && f.score !== null && f.score !== '';
      if (sawOwnScoreField === null) sawOwnScoreField = hasOwnScore;
      else if (sawOwnScoreField !== hasOwnScore) sawOwnScoreField = 'mixed';

      const players = Array.isArray(f.player) ? f.player : f.player ? [f.player] : [];
      const summedStarters = players
        .filter((p) => p.status === 'starter')
        .reduce((sum, p) => sum + (Number(p.score) || 0), 0);

      if (!weeklyTotalsById.has(f.id)) weeklyTotalsById.set(f.id, []);
      weeklyTotalsById.get(f.id)[week - 1] = { ownScore: f.score, summedStarters };
      seenThisWeek.push(`id=${f.id} own=${f.score ?? '(none)'} summed=${summedStarters.toFixed(2)}`);
    }
  }
  console.log(`  week ${week}: ${matchupList.length} matchup(s) — ${seenThisWeek.join(' | ')}`);
}

console.log(`\n--- own-score-field presence across every franchise entry seen: ${sawOwnScoreField} ---`);

console.log('\n--- per-franchise: own-score sum vs summed-starters sum vs standings pf ---');
let maxOwnWeek = null;
for (const [fid, weeks] of weeklyTotalsById.entries()) {
  const ownSum = weeks.reduce((s, w) => s + (Number(w?.ownScore) || 0), 0);
  const starterSum = weeks.reduce((s, w) => s + (w?.summedStarters || 0), 0);
  const pf = pfById.get(fid);
  const name = nameById.get(fid) || fid;
  console.log(
    `  ${name} (${fid}): ownSum=${ownSum.toFixed(2)} starterSum=${starterSum.toFixed(2)} ` +
    `standings.pf=${Number.isFinite(pf) ? pf.toFixed(2) : '(missing)'} ` +
    `ownSum==pf? ${Number.isFinite(pf) ? (Math.abs(ownSum - pf) < 0.05) : 'n/a'}`
  );
  weeks.forEach((w, i) => {
    const own = Number(w?.ownScore) || 0;
    if (!maxOwnWeek || own > maxOwnWeek.own) maxOwnWeek = { name, fid, week: i + 1, own };
  });
}

console.log(`\n--- highest single regular-season week (by own-score field): ${JSON.stringify(maxOwnWeek)} ---`);

console.log('\n=== done ===');
