// NFL standings (wins/losses/ties, points for/against, streak, playoff
// seed) read from ESPN's PUBLIC site API — the same unauthenticated, no-key
// host espn-depth-chart.mjs and providers.mjs' fetchNflGames already read,
// and nothing to do with the cookie-gated fantasy API. NFL-wide, one
// request per sync, never competing with MFL's rate limit.
//
// Note the path is /apis/v2/..., not /apis/site/v2/... like every other
// ESPN public read in this project; /apis/v2/ is the path
// probe-nfl-standings.mjs confirmed (RUN 1). The /site/v2/ variant has never
// been tried here. The response is a tree of `children` groups, each
// carrying `standings.entries[]` of `{ team, stats: [{ name, type, value,
// displayValue }] }` — every stat name read below was confirmed present
// for all 32 teams by that probe. This host is unreachable from the sandbox
// this repo is edited from, so read the probe's header before changing the
// parse.
//
// Deliberately NOT relying on how deep the tree goes: RUN 1 confirmed the
// endpoint groups by conference by default and by division with `level=3`,
// and which one comes back is exactly the kind of thing that could change
// without notice. extractStandings walks the whole tree and collects every
// entry wherever it sits; the page groups teams into divisions itself from
// its own DEPTH_CHART_DIVISIONS map rather than trusting ESPN's grouping.
//
// Degrades like everything else in the sync: fetchNflStandings throws on
// an HTTP failure or an unparseable body (zero teams), and the caller in
// fetch-rosters.mjs falls back to the previous run's `nflStandings`.

const STANDINGS_URL = 'https://site.api.espn.com/apis/v2/sports/football/nfl/standings';

// Returns the stat's numeric value, or null when absent — a missing stat
// must render as a dash on the page, never as a confident 0.
function statValue(statsByName, name) {
  const v = statsByName.get(name)?.value;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// Pure and separately tested (test-nfl-standings.mjs). `order` is the
// entry's position in ESPN's own response, kept as the last-resort
// tiebreak: ESPN applies the real NFL tiebreakers, this project doesn't.
export function extractStandings(data) {
  const teams = {};
  let order = 0;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const entry of node.standings?.entries || []) {
      const abbr = entry?.team?.abbreviation;
      if (!abbr || teams[abbr]) continue;
      const statsByName = new Map();
      for (const s of entry.stats || []) {
        if (s?.name) statsByName.set(s.name, s);
      }
      // ESPN sends the division record twice — `type: 'vsdiv'` (name
      // "vs. Div.") and `name: 'divisionRecord'` — with the same
      // displayValue on every team probe-nfl-standings.mjs RUN 1 saw, so
      // either one matching is fine. Only a real "W-L" / "W-L-T" string is
      // accepted, anything else is left null.
      const divStat = (entry.stats || []).find((s) => s?.type === 'vsdiv' || s?.name === 'divisionRecord');
      const div = /^\d+-\d+(-\d+)?$/.test(divStat?.displayValue || '') ? divStat.displayValue : null;
      const streak = statsByName.get('streak')?.displayValue || null;
      teams[abbr] = {
        name: entry.team.displayName || entry.team.name || abbr,
        w: statValue(statsByName, 'wins'),
        l: statValue(statsByName, 'losses'),
        t: statValue(statsByName, 'ties'),
        pf: statValue(statsByName, 'pointsFor'),
        pa: statValue(statsByName, 'pointsAgainst'),
        streak,
        seed: statValue(statsByName, 'playoffSeed'),
        div,
        order: order++,
      };
    }
    for (const child of node.children || []) walk(child);
  };
  walk(data);
  return teams;
}

export async function fetchNflStandings({ season }) {
  const url = `${STANDINGS_URL}?season=${encodeURIComponent(season)}&seasontype=2`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} at ${url}`);
  const teams = extractStandings(await res.json());
  if (Object.keys(teams).length === 0) {
    throw new Error('standings response carried no team entries — shape changed? re-run probe-nfl-standings.yml');
  }
  return { generatedAt: new Date().toISOString(), season: String(season), teams };
}
