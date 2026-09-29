// Asks ESPN's PUBLIC standings endpoint what it actually returns, since
// scripts/lib/espn-standings.mjs was written against the commonly
// reverse-engineered shape without this project ever having seen a real
// response — site.api.espn.com is unreachable from the sandbox this repo is
// edited from (a direct curl is rejected by the egress proxy), same reason
// every other probe here exists. No key, no cookies, read-only GETs.
//
// What it reports, for the exact URL the sync uses and for `level=3`
// (the division-grouped variant):
//   - HTTP status and the tree shape (children names, depth, entry counts);
//   - one full entry's stat list (name / type / value / displayValue), which
//     is what confirms or refutes the stat names extractStandings reads —
//     wins, losses, ties, pointsFor, pointsAgainst, streak, playoffSeed, and
//     the division record's `type: 'vsdiv'`;
//   - what extractStandings itself makes of the response: team count, any
//     abbreviation myffl.html's DEPTH_CHART_DIVISIONS wouldn't recognise,
//     and which fields came back null for every team (a wrong stat name).
//
// RUN 1: not yet run. Record results here.

import { extractStandings } from './lib/espn-standings.mjs';

const BASE = 'https://site.api.espn.com/apis/v2/sports/football/nfl/standings';
const season = process.env.SEASON || String(new Date().getFullYear());
const KNOWN = new Set(['BUF', 'MIA', 'NE', 'NYJ', 'BAL', 'CIN', 'CLE', 'PIT', 'HOU', 'IND', 'JAX', 'TEN', 'DEN', 'KC', 'LV', 'LAC',
  'DAL', 'NYG', 'PHI', 'WSH', 'CHI', 'DET', 'GB', 'MIN', 'ATL', 'CAR', 'NO', 'TB', 'ARI', 'LAR', 'SF', 'SEA']);

function describeTree(node, depth = 0, out = []) {
  const entries = node?.standings?.entries?.length ?? 0;
  out.push(`${'  '.repeat(depth)}- ${node?.name || node?.abbreviation || '(root)'}  entries=${entries}`);
  for (const child of node?.children || []) describeTree(child, depth + 1, out);
  return out;
}
function firstEntry(node) {
  if (node?.standings?.entries?.length) return node.standings.entries[0];
  for (const child of node?.children || []) {
    const e = firstEntry(child);
    if (e) return e;
  }
  return null;
}

for (const url of [`${BASE}?season=${season}&seasontype=2`, `${BASE}?season=${season}&seasontype=2&level=3`]) {
  console.log(`\n=== ${url}`);
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    console.log(`fetch failed: ${err.message}`);
    continue;
  }
  console.log(`HTTP ${res.status} ${res.headers.get('content-type')}`);
  const body = await res.text();
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    console.log(body.slice(0, 800));
    continue;
  }
  console.log(`top-level keys: ${Object.keys(data).join(', ')}`);
  console.log(describeTree(data).join('\n'));
  const e = firstEntry(data);
  if (e) {
    console.log(`\nfirst entry team: ${JSON.stringify(e.team && { abbreviation: e.team.abbreviation, displayName: e.team.displayName, id: e.team.id })}`);
    for (const s of e.stats || []) {
      console.log(`  name=${s.name} type=${s.type} value=${s.value} displayValue=${s.displayValue}`);
    }
  }
  const teams = extractStandings(data);
  const abbrs = Object.keys(teams);
  console.log(`\nextractStandings: ${abbrs.length} team(s)`);
  const unknown = abbrs.filter((a) => !KNOWN.has(a));
  console.log(`abbreviations outside DEPTH_CHART_DIVISIONS: ${unknown.length ? unknown.join(', ') : 'none'}`);
  for (const field of ['w', 'l', 't', 'pf', 'pa', 'streak', 'seed', 'div']) {
    const nulls = abbrs.filter((a) => teams[a][field] == null).length;
    console.log(`  ${field}: null for ${nulls}/${abbrs.length}`);
  }
  if (abbrs[0]) console.log(`sample: ${JSON.stringify(teams[abbrs[0]])}`);
}
