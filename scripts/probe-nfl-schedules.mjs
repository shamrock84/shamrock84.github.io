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
// RUN 1 (2026-10-15): HTTP 200 for weeks 1, 9 and 18, 16/15/16 events, every
// one parsed with a kickoff. competitors carry homeAway, team.abbreviation
// and a string score ("0" pregame); status.type has completed/state/detail.
// Week 9 has 15 games (two byes). Week 18 kickoffs are placeholders:
// date "2027-01-10T05:00Z" with detail "1/10 - TBD" — hence `tbd`.

// RUN 2 (2026-11-07): preseason (seasontype=1) has weeks 1-4 and week 5 is an
// empty 200. Week 1 is only the Hall of Fame game; MIN played wk 2 @NYG
// (2026-08-15T17:00Z), wk 3 vs BAL (08-22T17:00Z, noon CT) and wk 4 @DEN. Each
// event carries season {year, type:1, slug:'preseason'}. seasontype=3 answers
// 200 with games even though the 2026 playoffs can't be set yet, so it is NOT
// trusted for the Vikings page (could be last January's bracket).

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

// ---- Preseason (seasontype=1) and playoffs (seasontype=3) -------------------
// Asked for by vikings.html, which lists every Minnesota home game. The
// regular-season fetch above never touches these, and buildTeamSchedules'
// bye detection must NOT see preseason weeks (a team that sits out a
// preseason week is not on a bye). Prints Minnesota's games per week so the
// parse and the week numbering can be checked before any code relies on them.
const TEAM = process.env.PROBE_TEAM || 'MIN';
for (const [label, seasontype, weeks] of [['preseason', 1, [1, 2, 3, 4, 5]], ['playoffs', 3, [1, 2, 3, 4, 5]]]) {
  for (const week of weeks) {
    const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${SEASON}&seasontype=${seasontype}&week=${week}`;
    const res = await fetch(url);
    console.log(`\n${label} week ${week}: HTTP ${res.status} ${url}`);
    if (!res.ok) continue;
    const data = await res.json();
    const games = extractWeekGames(data);
    console.log(`  events: ${(data.events || []).length}, parsed: ${games.length}, season echoed: ${JSON.stringify(data.season)}, week echoed: ${JSON.stringify(data.week)}`);
    for (const g of games.filter((x) => x.home === TEAM || x.away === TEAM)) console.log(`  ${TEAM}:`, JSON.stringify(g));
    const raw = (data.events || []).find((e) => JSON.stringify(e).includes(`"abbreviation":"${TEAM}"`));
    if (raw) console.log('  raw status.type:', JSON.stringify(raw.status?.type), '| name:', raw.name, '| season:', JSON.stringify(raw.season));
  }
}
