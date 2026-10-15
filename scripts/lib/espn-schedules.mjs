// Season schedule for every NFL team (the NFL tab's Schedules card), built
// from ESPN's PUBLIC scoreboard — the same unauthenticated host
// providers.mjs' fetchNflGames reads, nothing to do with the cookie-gated
// fantasy API, never competing with MFL's rate limit.
//
// One request per regular-season week (18) rather than one per team (32):
// `scoreboard?dates=YYYY&seasontype=2&week=N` lists every game that week, and
// a team's bye is simply the week it is absent from a week that DID have
// games. extractWeekGames reads `events[].competitions[0].competitors[]`
// (`homeAway`, `team.abbreviation`, `score` as a string, `winner`) and the
// event's `date` and `status.type.{completed,state}` — the shape fetchNflGames
// already relies on. This host is unreachable from the sandbox this repo is
// edited from; probe-nfl-schedules.yml is how to re-check the shape from
// Actions before changing the parse.
//
// Wire shape per team: an array of week entries, in week order, kept short
// because every byte rides data/rosters.json:
//   game: { wk, opp, home, at, r, pf, pa }   bye: { wk, bye: true }
// `at` is ESPN's ISO kickoff (the page formats it in the browser's zone);
// `r` ('W'|'L'|'T') and the scores exist only once the game is final. A
// missing score is absent, never 0.
//
// Degrades like everything else in the sync: fetchNflSchedules throws when
// no week yields a game, and a single bad week is tolerated only if the
// rest are readable — a hole in the middle of a schedule would be mistaken
// for a bye, so any failed week fails the whole read and the caller falls back
// to the previous run's `nflSchedules`.

const SCOREBOARD_URL = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
export const REGULAR_SEASON_WEEKS = 18;

const numOrNull = (v) => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Pure and separately tested (test-nfl-schedules.mjs). Returns the week's
// games as { away, home, at, final, awayScore, homeScore }.
export function extractWeekGames(data) {
  const games = [];
  for (const event of data?.events || []) {
    const comp = event?.competitions?.[0];
    const home = comp?.competitors?.find((c) => c?.homeAway === 'home');
    const away = comp?.competitors?.find((c) => c?.homeAway === 'away');
    const homeAbbr = home?.team?.abbreviation;
    const awayAbbr = away?.team?.abbreviation;
    if (!homeAbbr || !awayAbbr) continue;
    const final = event.status?.type?.completed === true;
    games.push({
      away: awayAbbr,
      home: homeAbbr,
      at: typeof event.date === 'string' ? event.date : null,
      final,
      awayScore: final ? numOrNull(away.score) : null,
      homeScore: final ? numOrNull(home.score) : null,
    });
  }
  return games;
}

// weeks: [{ week, games }] in any order. Teams with no game in a week that
// had games get a bye entry; a week with no games at all adds nothing (not
// scheduled yet — never guess a bye from an empty week).
export function buildTeamSchedules(weeks) {
  const teams = {};
  const entries = (abbr) => (teams[abbr] ||= []);
  const sorted = [...weeks].sort((a, b) => a.week - b.week);
  for (const { week, games } of sorted) {
    for (const g of games) {
      for (const side of ['home', 'away']) {
        const isHome = side === 'home';
        const abbr = isHome ? g.home : g.away;
        const entry = { wk: week, opp: isHome ? g.away : g.home, home: isHome, at: g.at };
        const pf = isHome ? g.homeScore : g.awayScore;
        const pa = isHome ? g.awayScore : g.homeScore;
        if (g.final && pf !== null && pa !== null) {
          entry.r = pf > pa ? 'W' : pf < pa ? 'L' : 'T';
          entry.pf = pf;
          entry.pa = pa;
        }
        entries(abbr).push(entry);
      }
    }
  }
  const known = Object.keys(teams);
  for (const { week, games } of sorted) {
    if (games.length === 0) continue;
    const playing = new Set(games.flatMap((g) => [g.home, g.away]));
    for (const abbr of known) {
      if (!playing.has(abbr)) entries(abbr).push({ wk: week, bye: true });
    }
  }
  for (const abbr of known) teams[abbr].sort((a, b) => a.wk - b.wk);
  return teams;
}

export async function fetchNflSchedules({ season }) {
  const weeks = [];
  for (let week = 1; week <= REGULAR_SEASON_WEEKS; week++) {
    const url = `${SCOREBOARD_URL}?dates=${encodeURIComponent(season)}&seasontype=2&week=${week}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} at ${url}`);
    weeks.push({ week, games: extractWeekGames(await res.json()) });
  }
  const teams = buildTeamSchedules(weeks);
  if (Object.keys(teams).length === 0) {
    throw new Error('schedule responses carried no games — shape changed? re-run probe-nfl-schedules.yml');
  }
  return { generatedAt: new Date().toISOString(), season: String(season), teams };
}
