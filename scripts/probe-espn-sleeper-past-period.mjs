#!/usr/bin/env node
// Answers cost #1 from fetchEspnScoring's own comment (providers.mjs) before
// any fetching code for the declined "hold ESPN/Sleeper on the prior week
// until its games start" fix gets written: once a provider's own "current
// week" flag has rolled past a week, can that week still be read back
// explicitly, with real (non-zero, final) scores — or does the provider only
// ever answer for whatever it currently calls "current"?
//
// If a past period comes back empty/zero/errored, the whole fix is off the
// table regardless of the freshness (#2) and cold-start (#3) tradeoffs also
// named in that comment — there'd be no data to hold and show. If it comes
// back with real numbers, this is the confirmation needed to move on to
// designing the fix itself.
//
// ESPN: fetchEspnScoring's own current-period call never passes
// scoringPeriodId at all (view=mScoreboard&view=mTeam&view=mRoster), so this
// probes whether adding scoringPeriodId=<previous week> scopes the roster
// read to that week instead of silently being ignored (returning today's
// same zeroed current-week entries) — the failure mode that would make this
// look like it works when it doesn't.
//
// Sleeper: fetchSleeperScoring already reads /league/{id}/matchups/{week}
// with an explicit week — never itself confirmed to still return real
// numbers for last week once /state/nfl's week has ticked over, only
// presumed to since it's "the same category of provider-owned 'current
// week' flag."
//
// Read-only. Run from the Actions tab (probe-espn-sleeper-past-period.yml).
// Requires ESPN_S2/ESPN_SWID like every other ESPN-authenticated probe.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { espnGet } from './lib/providers.mjs';

const CONFIG_PATH = fileURLToPath(new URL('../config/leagues.json', import.meta.url));
const { leagues } = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));

const espnLeagues = leagues.filter((l) => l.provider === 'espn');
const sleeperLeague = leagues.find((l) => l.provider === 'sleeper');

function summarizeEntries(entries) {
  if (!entries || !entries.length) return { count: 0, totalApplied: null };
  let totalApplied = 0;
  let anyNonNull = false;
  for (const e of entries) {
    const stat = (e.playerPoolEntry?.player?.stats || []).find((s) => s.statSourceId === 0);
    if (stat && typeof stat.appliedTotal === 'number') {
      anyNonNull = true;
      totalApplied += stat.appliedTotal;
    }
  }
  return { count: entries.length, totalApplied: anyNonNull ? totalApplied : null };
}

console.log('=== ESPN: can a past scoring period still be read after currentMatchupPeriod rolls? ===');
for (const league of espnLeagues) {
  console.log(`\n--- league ${league.id} (${league.name || 'unnamed'}) ---`);
  try {
    const current = await espnGet(league, 'view=mScoreboard&view=mTeam&view=mRoster');
    const currentPeriod = current.status?.currentMatchupPeriod;
    console.log(`currentMatchupPeriod: ${currentPeriod}`);
    const currentSchedule = (current.schedule || []).filter((m) => m.matchupPeriodId === currentPeriod);
    for (const side of ['home', 'away']) {
      const m = currentSchedule[0]?.[side];
      if (!m) continue;
      console.log(`  current period ${side} totalPointsLive: ${m.totalPointsLive}, rosterForCurrentScoringPeriod entries: ${m.rosterForCurrentScoringPeriod?.entries?.length ?? 'none'}`);
    }

    if (!currentPeriod || currentPeriod < 2) {
      console.log('  currentMatchupPeriod < 2 — no prior week to probe yet this season.');
      continue;
    }
    const prevPeriod = currentPeriod - 1;

    const past = await espnGet(
      league,
      `view=mScoreboard&view=mTeam&view=mRoster&view=mBoxscore&scoringPeriodId=${prevPeriod}`
    );
    console.log(`\n  requested scoringPeriodId=${prevPeriod}; response status.currentMatchupPeriod still reads: ${past.status?.currentMatchupPeriod}`);
    const pastSchedule = (past.schedule || []).filter((m) => m.matchupPeriodId === prevPeriod);
    console.log(`  schedule entries for matchupPeriodId=${prevPeriod}: ${pastSchedule.length}`);
    const firstPast = pastSchedule[0];
    if (!firstPast) {
      console.log('  No schedule entry for the previous period in this response — past-period read looks infeasible this way.');
      continue;
    }
    for (const side of ['home', 'away']) {
      const m = firstPast[side];
      if (!m) continue;
      const entries = m.rosterForCurrentScoringPeriod?.entries || m.rosterForMatchupPeriod?.entries;
      const { count, totalApplied } = summarizeEntries(entries);
      console.log(
        `  past period ${side} totalPointsLive: ${m.totalPointsLive}, totalPoints: ${m.totalPoints}, ` +
        `roster entries: ${count}, summed appliedTotal (statSourceId 0): ${totalApplied}`
      );
    }
  } catch (err) {
    console.log(`  ESPN check failed: ${err.message}`);
  }
}

console.log('\n=== Sleeper: does /matchups/{week} still return real numbers for a week after state.week rolls past it? ===');
if (!sleeperLeague) {
  console.log('No Sleeper league in config — skipping.');
} else {
  try {
    const stateRes = await fetch('https://api.sleeper.app/v1/state/nfl');
    const state = await stateRes.json();
    const currentWeek = state.week > 0 ? state.week : state.display_week;
    console.log(`state/nfl week: ${state.week}, display_week: ${state.display_week}, resolved current: ${currentWeek}`);

    if (!currentWeek || currentWeek < 2) {
      console.log('resolved current week < 2 — no prior week to probe yet this season.');
    } else {
      const prevWeek = currentWeek - 1;

      const [currentRes, prevRes] = await Promise.all([
        fetch(`https://api.sleeper.app/v1/league/${sleeperLeague.id}/matchups/${currentWeek}`),
        fetch(`https://api.sleeper.app/v1/league/${sleeperLeague.id}/matchups/${prevWeek}`),
      ]);
      const currentMatchups = await currentRes.json();
      const prevMatchups = await prevRes.json();

      const totalPoints = (arr) => (arr || []).reduce((sum, m) => sum + (m.points || 0), 0);
      console.log(`week ${currentWeek} (current) matchups: ${currentMatchups?.length ?? 0}, summed points: ${totalPoints(currentMatchups)}`);
      console.log(`week ${prevWeek} (previous) matchups: ${prevMatchups?.length ?? 0}, summed points: ${totalPoints(prevMatchups)}`);
      console.log(`week ${prevWeek} matchups[0] full dump:`, JSON.stringify(prevMatchups?.[0], null, 2));
    }
  } catch (err) {
    console.log(`Sleeper check failed: ${err.message}`);
  }
}

console.log('\n=== done ===');
