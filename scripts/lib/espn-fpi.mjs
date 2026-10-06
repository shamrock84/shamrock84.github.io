// NFL Power Index for the NFL tab, taken from ESPN's Football Power Index
// (FPI) — the model behind espn.com/nfl/fpi. ESPN publishes no structured
// "power rankings" feed (its weekly ones are editorial articles), and FPI is
// the closest team-strength number it does serve. Read from ESPN's PUBLIC
// site API, no key and no cookies, one request per sync, never competing with
// MFL's rate limit. Nothing to do with the cookie-gated fantasy API or with
// the homegrown fantasy power ranks in fantasypros.mjs.
//
// Shape, as probe-espn-fpi.mjs RUN 1 found it (this host is unreachable from
// the sandbox this repo is edited from, so read that probe's header before
// changing the parse): `teams[]`, all 32 in one response, each
// `{ team: { abbreviation, displayName, ... }, categories: [{ name, values }] }`.
// The values are POSITIONAL — the matching top-level `categories[].names`
// array says what each slot is — so extractPowerRankings zips the two by
// name rather than trusting an index, which ESPN is free to reorder. Three
// categories: `fpi` (fpi, fpirank, numwins/numlosses/numties, ...),
// `projections` (projectedw/l, probmakeplayoffs, ...) and `efficiencies`
// (offefficiency / defefficiency / stefficiency on a 0-100 scale).
//
// Two traps in the values:
//   * A rank of 0 is ESPN's "-" (display "-"), never a real rank: rankOf
//     turns it into null. A genuine 0 elsewhere (wins in week 1, a 0%
//     chance) is real and stays 0.
//   * Floats arrive unrounded (78.60000000000001), and every number rides
//     the snapshot, so they are rounded to one decimal here.
//
// `rankchange7days` is deliberately NOT read: it came back 0 with a "-"
// display and the probe could not tell "no change" from "unknown", nor
// which sign means improved.
//
// Degrades like everything else in the sync: fetchNflPowerRankings throws on
// an HTTP failure or an unparseable body (no team with an FPI), and the
// caller in fetch-rosters.mjs falls back to the previous run's value.

const FPI_URL = 'https://site.web.api.espn.com/apis/fitt/v3/sports/football/nfl/powerindex';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round1 = (v) => {
  const n = num(v);
  return n === null ? null : Math.round(n * 10) / 10;
};
// 0 is ESPN's placeholder for an unranked slot, not a rank.
const rankOf = (v) => {
  const n = num(v);
  return n !== null && n >= 1 ? n : null;
};

// Pure and separately tested (test-nfl-power-rankings.mjs). `order` is the
// entry's position in ESPN's own response (sorted by FPI, descending), kept
// as the last-resort tiebreak for the page.
export function extractPowerRankings(data) {
  const layout = new Map();
  for (const cat of data?.categories || []) {
    if (cat?.name && Array.isArray(cat.names)) layout.set(cat.name, cat.names);
  }
  const teams = {};
  let order = 0;
  for (const entry of data?.teams || []) {
    const abbr = entry?.team?.abbreviation;
    if (!abbr || teams[abbr]) continue;
    const stat = new Map();
    for (const cat of entry.categories || []) {
      const names = layout.get(cat?.name);
      if (!names || !Array.isArray(cat.values)) continue;
      names.forEach((name, i) => stat.set(name, cat.values[i]));
    }
    const fpi = round1(stat.get('fpi'));
    if (fpi === null) continue;
    teams[abbr] = {
      name: entry.team.displayName || entry.team.name || abbr,
      rank: rankOf(stat.get('fpirank')),
      fpi,
      off: round1(stat.get('offefficiency')),
      def: round1(stat.get('defefficiency')),
      st: round1(stat.get('stefficiency')),
      w: num(stat.get('numwins')),
      l: num(stat.get('numlosses')),
      t: num(stat.get('numties')),
      projW: round1(stat.get('projectedw')),
      projL: round1(stat.get('projectedl')),
      playoffs: round1(stat.get('probmakeplayoffs')),
      order: order++,
    };
  }
  return teams;
}

export async function fetchNflPowerRankings({ season }) {
  const url = `${FPI_URL}?region=us&lang=en&season=${encodeURIComponent(season)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} at ${url}`);
  const data = await res.json();
  const teams = extractPowerRankings(data);
  if (Object.keys(teams).length === 0) {
    throw new Error('power index response carried no team with an FPI — shape changed? re-run probe-espn-fpi.yml');
  }
  return {
    generatedAt: new Date().toISOString(),
    season: String(season),
    // ESPN's own run time for the model, e.g. "2026-10-06T06:00Z".
    updated: typeof data.lastUpdated === 'string' ? data.lastUpdated : null,
    teams,
  };
}
