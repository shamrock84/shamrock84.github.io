// Asks ESPN's PUBLIC scoreboard what it returns for a given regular-season
// week, since scripts/lib/espn-schedules.mjs was written against the
// shape fetchNflGames already reads, not against a real
// `?dates=YYYY&seasontype=2&week=N` response — site.api.espn.com is
// unreachable from the sandbox this repo is edited from, same reason every
// other probe here exists. No key, no cookies, read-only GETs.
//
// Reports, for weeks 1, 9 and 18: HTTP status, event count, one event's
// competitor fields (homeAway, team.abbreviation, score, winner) and status
// type, and what extractWeekGames makes of it (games parsed, any with no
// kickoff). Week 9 is the usual first bye window, so buildTeamSchedules'
// bye detection can be eyeballed too.
//
// RUN 1: not yet run — dispatch probe-nfl-schedules.yml and record the
// result here before trusting the parse.

import { extractWeekGames } from './lib/espn-schedules.mjs';

const SEASON = process.env.MFL_YEAR || String(new Date().getFullYear());
for (const week of [1, 9, 18]) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${SEASON}&seasontype=2&week=${week}`;
  const res = await fetch(url);
  console.log(`\nweek ${week}: HTTP ${res.status} ${url}`);
  if (!res.ok) continue;
  const data = await res.json();
  console.log(`  events: ${(data.events || []).length}`);
  const sample = data.events?.[0];
  if (sample) {
    const comp = sample.competitions?.[0];
    console.log('  date:', sample.date, 'status.type:', JSON.stringify(sample.status?.type));
    for (const c of comp?.competitors || []) {
      console.log('  competitor:', JSON.stringify({ homeAway: c.homeAway, abbr: c.team?.abbreviation, score: c.score, winner: c.winner }));
    }
  }
  const games = extractWeekGames(data);
  console.log(`  extractWeekGames: ${games.length} game(s), ${games.filter((g) => !g.at).length} without a kickoff`);
}
