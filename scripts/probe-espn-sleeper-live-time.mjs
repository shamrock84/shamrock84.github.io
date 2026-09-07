#!/usr/bin/env node
// Answers whether ESPN and Sleeper can get the same Minutes Remaining / Win
// Probability treatment MFL just got (see providers.mjs's fetchScoring and
// its comment on estimateWinProbability).
//
// MFL's minutesRemaining is free: franchise.gameSecondsRemaining already
// sums each of that team's starters' own real NFL game clock, fetched by
// TYPE=liveScoring alongside everything else. Neither ESPN's fantasy API
// (fetchEspnScoring, view=mScoreboard&mTeam) nor Sleeper's (fetchSleeperScoring,
// /league/{id}/matchups/{week}) return anything like it today — this checks
// three candidate sources before writing any parsing code:
//
//   1. ESPN's OWN fantasy API, with extra views (mBoxscore, mLiveScoring)
//      added to what fetchEspnScoring already requests — does a roster
//      entry carry a live game clock/quarter/status anywhere already, so no
//      new external source would be needed?
//   2. The public, unauthenticated ESPN site API
//      (site.api.espn.com/.../nfl/scoreboard) — real NFL game clock/quarter
//      per team, provider-agnostic, joinable by team abbreviation against
//      either ESPN's own proTeamId (ESPN_PRO_TEAM_MAP already exists) or
//      Sleeper's player.team field (already read by loadSleeperPlayerMap).
//      If reachable and shaped usably, this is the one candidate that could
//      serve BOTH providers from a single new fetch.
//   3. Sleeper's own API for anything live-game-shaped on top of what
//      fetchSleeperScoring already reads (matchups) — in case there's a
//      field nothing has looked for yet.
//
// Read-only. Run from the Actions tab (probe-espn-sleeper-live-time.yml).
// Requires ESPN_S2/ESPN_SWID like every other ESPN-authenticated probe.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { espnGet } from './lib/providers.mjs';

const CONFIG_PATH = fileURLToPath(new URL('../config/leagues.json', import.meta.url));
const { leagues } = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));

const espnLeague = leagues.find((l) => l.provider === 'espn');
const sleeperLeague = leagues.find((l) => l.provider === 'sleeper');

console.log('=== 1. ESPN fantasy API: does a roster entry carry live game state? ===');
if (!espnLeague) {
  console.log('No ESPN league in config — skipping.');
} else {
  try {
    const data = await espnGet(espnLeague, 'view=mScoreboard&view=mTeam&view=mBoxscore&view=mLiveScoring&view=mRoster');
    const period = data.status?.currentMatchupPeriod;
    console.log(`league ${espnLeague.id}, currentMatchupPeriod=${period}`);
    const schedule = (data.schedule || []).filter((m) => m.matchupPeriodId === period);
    console.log(`schedule entries for this period: ${schedule.length}`);
    const first = schedule[0];
    if (first) {
      console.log('First matchup top-level keys:', Object.keys(first));
      for (const side of ['home', 'away']) {
        const team = first[side];
        if (!team) continue;
        console.log(`  ${side} team keys:`, Object.keys(team));
        const entries = team.rosterForCurrentScoringPeriod?.entries || team.rosterForMatchupPeriod?.entries;
        console.log(`  ${side} roster entries present: ${entries ? entries.length : 'none'}`);
        if (entries && entries[0]) {
          console.log(`  ${side} first entry full dump:`, JSON.stringify(entries[0], null, 2));
        }
      }
    } else {
      console.log('No schedule entry for the current period — league may be pre-draft/pre-season.');
    }
  } catch (err) {
    console.log(`ESPN fantasy API check failed: ${err.message}`);
  }
}

console.log('\n=== 2. Public ESPN site API: real NFL scoreboard (no auth) ===');
try {
  const res = await fetch('https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard');
  console.log(`status: ${res.status}`);
  if (res.ok) {
    const data = await res.json();
    const events = data.events || [];
    console.log(`events: ${events.length}`);
    const sample = events[0];
    if (sample) {
      const comp = sample.competitions?.[0];
      console.log('sample event top-level keys:', Object.keys(sample));
      console.log('sample competition status:', JSON.stringify(comp?.status, null, 2));
      console.log('sample competitors:', JSON.stringify(
        (comp?.competitors || []).map((c) => ({
          team: c.team?.abbreviation,
          homeAway: c.homeAway,
          score: c.score,
        })),
        null, 2
      ));
    }
  } else {
    console.log('body:', (await res.text()).slice(0, 500));
  }
} catch (err) {
  console.log(`Public ESPN scoreboard fetch failed: ${err.message}`);
}

console.log('\n=== 3. Sleeper API: anything live-game-shaped beyond what fetchSleeperScoring reads? ===');
if (!sleeperLeague) {
  console.log('No Sleeper league in config — skipping.');
} else {
  try {
    const stateRes = await fetch('https://api.sleeper.app/v1/state/nfl');
    const state = await stateRes.json();
    console.log('state/nfl:', JSON.stringify(state, null, 2));

    const week = state.week > 0 ? state.week : state.display_week;
    const matchupsRes = await fetch(`https://api.sleeper.app/v1/league/${sleeperLeague.id}/matchups/${week}`);
    const matchups = await matchupsRes.json();
    console.log(`\nmatchups[0] full dump:`, JSON.stringify(matchups?.[0], null, 2));
  } catch (err) {
    console.log(`Sleeper check failed: ${err.message}`);
  }
}

console.log('\n=== done ===');
