// Asks MFL what it actually exposes about a past, fully-completed season's
// week-by-week scoring — the History tab wants two new numbers per season
// (highest single-week score, highest season point total) for leagues that
// pay out on them, and nothing in this codebase has ever parsed a
// franchise-level total score off TYPE=weeklyResults. Two open questions
// from the first round:
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
// First round confirmed both: every franchise's own `score` field matched
// its summed-starters total exactly, every matchup, every week — but only
// checked weeks 1..lastRegularSeasonWeek. That's a real gap: the shipped
// feature fetches a fixed weeks 1-18 window specifically BECAUSE payouts
// run through the playoff bracket too (see backfillLeagueScoringRecords in
// fetch-rosters.mjs), so the untested weeks are exactly the ones a real
// weekly-high win is most likely to land on — round-1 byes, consolation
// games, and any week where not every franchise has a "real" matchup.
//
// Round 2 fetched the SAME fixed weeks-1-18 window backfillLeagueScoringRecords
// does and counted how many distinct franchises actually appeared in each
// week against the league's real franchise count — and round 3 confirmed
// exactly the gap round 2 worried about was real: MNMx's 2021 week 15 had
// six of ten franchises missing from fetchMflWeekScores entirely. The raw
// body (dumped below whenever a week comes up short) showed why —
// weeklyResults.matchup only ever carries a franchise with an active
// head-to-head game that week; a bye, an eliminated team, or anything past
// its own bracket's final appears as a flat entry directly under
// weeklyResults.franchise instead, sibling to matchup rather than nested in
// it, still carrying a completely real score. fetchMflWeekScores only ever
// read matchup, so that franchise's week vanished — and that week, one of
// the missing flat entries (142.5) was the actual weekly high, silently
// replaced by a matchup entry at 90.3. Fixed in parseMflWeekScores, pinned
// with this exact fixture in scripts/test-weekly-scores.mjs. The
// missing-franchise check below still runs on every future probe as a
// regression guard — a week that comes up short again after this fix is
// worth investigating as a third shape, not assumed away.
//
// Read-only. Run from the Actions tab (probe-weekly-scores.yml).
import { mflLogin, mflGet, fetchMflWeekScores, fetchMflSeasonMeta } from './lib/providers.mjs';
import { computeSeasonScoringRecords } from './lib/history.mjs';

const MFL_LEAGUE_ID = process.env.PROBE_MFL_LEAGUE_ID;
const YEAR = process.env.PROBE_YEAR;
const WEEKLY_HIGH_SCORE_WEEKS = 18;
const SEASON_HIGH_SCORE_WEEKS = 17;

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
console.log(`  franchises: ${franchiseList.length} — ${franchiseList.map((f) => f.id).join(', ')}`);

console.log('\n--- TYPE=leagueStandings (pf/pa per franchise, full first row) ---');
const standingsData = await mflGet(`/export?TYPE=leagueStandings&L=${MFL_LEAGUE_ID}&JSON=1`, cookie, YEAR);
const rawRows = standingsData?.leagueStandings?.franchise;
const standingsRows = Array.isArray(rawRows) ? rawRows : rawRows ? [rawRows] : [];
console.log(`  rows: ${standingsRows.length}`);
if (standingsRows.length) console.log(`  first row (every field): ${JSON.stringify(standingsRows[0])}`);
const pfById = new Map(standingsRows.map((r) => [r.id, Number(r.pf ?? NaN)]));

// The exact window backfillLeagueScoringRecords fetches — fixed 1-18,
// capped by the season's own endWeek for a season that never reached 18.
const { endWeek: metaEndWeek } = await fetchMflSeasonMeta(MFL_LEAGUE_ID, cookie, YEAR);
const weeksToFetch = Number.isFinite(metaEndWeek) && metaEndWeek > 0
  ? Math.min(WEEKLY_HIGH_SCORE_WEEKS, metaEndWeek)
  : WEEKLY_HIGH_SCORE_WEEKS;
console.log(`\n--- fetching weeks 1..${weeksToFetch} (the production window, via fetchMflWeekScores) ---`);

const weeklyScoresByWeek = new Map();
const rawResponses = new Map();
for (let week = 1; week <= weeksToFetch; week++) {
  const totals = await fetchMflWeekScores(MFL_LEAGUE_ID, cookie, YEAR, week);
  weeklyScoresByWeek.set(week, totals);
  const seenIds = totals.map((t) => t.franchiseId);
  const missing = franchiseList.map((f) => f.id).filter((id) => !seenIds.includes(id));
  const best = totals.reduce((b, t) => (!b || t.points > b.points ? t : b), null);
  console.log(
    `  week ${week}: ${totals.length}/${franchiseList.length} franchise(s) seen` +
    (missing.length ? ` — MISSING: ${missing.join(', ')}` : '') +
    (best ? ` — high: ${nameById.get(best.franchiseId) || best.franchiseId} (${best.points.toFixed(2)})` : '')
  );
  if (totals.length) {
    console.log(`    all: ${totals.map((t) => `${nameById.get(t.franchiseId) || t.franchiseId}=${t.points.toFixed(2)}`).join(', ')}`);
  }
  // Raw body for any week with a gap, or any week past the regular season —
  // a missing franchise there is either a genuine bye/eliminated team (no
  // real score to compare) or a structural gap (their real matchup exists
  // but isn't showing up the way this parses it), and the only way to tell
  // the two apart is to look at exactly what MFL actually sent back.
  if (missing.length || (Number.isFinite(lastRegWeek) && week > lastRegWeek)) {
    const raw = await mflGet(`/export?TYPE=weeklyResults&L=${MFL_LEAGUE_ID}&W=${week}&JSON=1`, cookie, YEAR);
    rawResponses.set(week, raw);
  }
}

if (rawResponses.size) {
  console.log('\n--- raw TYPE=weeklyResults body for every week probed above (gap or post-regular-season) ---');
  for (const [week, raw] of rawResponses.entries()) {
    console.log(`  week ${week}: ${JSON.stringify(raw)}`);
  }
}

console.log('\n--- per-franchise: fetchMflWeekScores sum (weeks 1-17) vs standings pf ---');
const sumsById = new Map();
for (const [week, totals] of weeklyScoresByWeek.entries()) {
  if (week > SEASON_HIGH_SCORE_WEEKS) continue;
  for (const { franchiseId, points } of totals) {
    sumsById.set(franchiseId, (sumsById.get(franchiseId) || 0) + points);
  }
}
for (const [fid, sum] of sumsById.entries()) {
  const pf = pfById.get(fid);
  console.log(
    `  ${nameById.get(fid) || fid} (${fid}): weeks1-17Sum=${sum.toFixed(2)} standings.pf=${Number.isFinite(pf) ? pf.toFixed(2) : '(missing)'} ` +
    `match? ${Number.isFinite(pf) ? (Math.abs(sum - pf) < 0.05) : 'n/a'}`
  );
}

console.log('\n--- computeSeasonScoringRecords, run on this exact fetched data (production logic, real inputs) ---');
const { weeklyHighs, seasonHigh } = computeSeasonScoringRecords(weeklyScoresByWeek, nameById, SEASON_HIGH_SCORE_WEEKS);
console.log('  weeklyHighs:');
for (const w of weeklyHighs) {
  console.log(`    week ${w.week}: ${w.teamName} (${w.franchiseId}) — ${w.points.toFixed(2)}`);
}
console.log(`  seasonHigh: ${seasonHigh ? `${seasonHigh.teamName} (${seasonHigh.franchiseId}) — ${seasonHigh.points.toFixed(2)}` : 'null'}`);

console.log('\n=== done ===');
