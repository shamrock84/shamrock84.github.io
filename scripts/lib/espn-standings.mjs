// NFL standings (wins/losses/ties, points for/against, streak, playoff
// seed) read from ESPN's PUBLIC site API — the same unauthenticated, no-key
// host espn-depth-chart.mjs and providers.mjs' fetchNflGames already read,
// and nothing to do with the cookie-gated fantasy API. NFL-wide, one
// request per sync, never competing with MFL's rate limit.
//
// Note the path is /apis/v2/..., not /apis/site/v2/... like every other
// ESPN public read in this project — the site/v2 standings path returns a
// stub pointing elsewhere. The shape parsed below is the commonly
// reverse-engineered one (a tree of `children` groups, each carrying
// `standings.entries[]` of `{ team, stats: [{ name, type, value,
// displayValue }] }`); probe-nfl-standings.mjs is what confirms it against
// the real endpoint, since this host is unreachable from the sandbox this
// repo is edited from. Read that probe's header before changing the parse.
//
// Deliberately NOT relying on how deep the tree goes: by default the
// endpoint groups by conference, with a `level` parameter for divisions,
// and which one comes back is exactly the kind of thing that changes
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
      // Division record carries no stable `name` across the variants seen
      // reported; its `type` ('vsdiv') is the steadier handle. Only a real
      // "W-L" / "W-L-T" string is accepted, anything else is left null.
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
