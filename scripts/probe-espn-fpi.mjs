// Asks ESPN's PUBLIC endpoints whether they serve the NFL Football Power
// Index (FPI) — the model behind espn.com/nfl/fpi — and in what shape, so the
// NFL tab's Power Rankings card can be written against a real response
// instead of a guessed one. site.api.espn.com and friends are unreachable
// from the sandbox this repo is edited from (the egress proxy 403s them),
// same reason every other probe here exists. No key, no cookies, read-only
// GETs.
//
// For each candidate URL it reports: HTTP status, content type, top-level
// keys, a depth-limited outline of the JSON (array lengths, first element),
// and a trimmed head of the body. For the core API's `$ref` lists it also
// follows the first ref one level. Candidates are guesses from the commonly
// reverse-engineered ESPN surface; a 404 on one is information, not failure.
//
// RUN 1 (2026-10-06, week 4 of the 2026 season): FPI exists, in two shapes.
//   * USE THIS ONE — site.web.api.espn.com/apis/fitt/v3/sports/football/nfl/
//     powerindex?region=us&lang=en&season=YYYY (site.api.espn.com answers
//     the same, with or without params; `seasontype` is accepted and
//     ignored). HTTP 200, all 32 teams in one response (`limit` defaults to
//     1000), already sorted by FPI descending. Top-level `categories[]`
//     (fpi / projections / efficiencies) carry `names[]` + `labels[]`; each
//     team's `categories[].values[]` line up with them POSITIONALLY. Read
//     by name: fpi, fpirank, numwins/numlosses/numties, projectedw/l,
//     probmakeplayoffs, offefficiency/defefficiency/stefficiency (0-100).
//     `team` carries abbreviation, displayName and `group` (division, with
//     a conference `parent`).
//   * sports.core.api.espn.com/v2/.../seasons/YYYY/powerindex also answers,
//     with named `predictives[]`/`efficiencies[]` but `team` as a `$ref` URL
//     and pages of 25 (`?limit=50` returns all 32). Not used.
//   * Traps: a rank of 0 with display "-" is "unknown", not a rank
//     (accomplishmentrank, gamecontrolrank, rankchange7days came back that
//     way). `rankchange7days` was 0 for the sampled team and its sign
//     convention is unknown, so the card doesn't use it. Floats arrive
//     unrounded (78.60000000000001).
//   * 404 on: /apis/v2/.../powerindex, /apis/site/v2/.../powerindex, core
//     .../types/2/powerindex, and the per-team powerindex/ranks routes.
//     /powerindex/leaders is 200 but empty.
//   * `lastUpdated` is ESPN's own model run time ("2026-10-06T06:00Z").

const season = process.env.SEASON || String(new Date().getFullYear());
const HEAD_CHARS = Number(process.env.HEAD_CHARS || 1800);

const CANDIDATES = [
  `https://site.web.api.espn.com/apis/fitt/v3/sports/football/nfl/powerindex?region=us&lang=en`,
  `https://site.web.api.espn.com/apis/fitt/v3/sports/football/nfl/powerindex?region=us&lang=en&season=${season}`,
  `https://site.web.api.espn.com/apis/fitt/v3/sports/football/nfl/powerindex?region=us&lang=en&season=${season}&seasontype=2`,
  `https://site.api.espn.com/apis/fitt/v3/sports/football/nfl/powerindex`,
  `https://site.web.api.espn.com/apis/v2/sports/football/nfl/powerindex`,
  `https://site.api.espn.com/apis/v2/sports/football/nfl/powerindex`,
  `https://site.api.espn.com/apis/site/v2/sports/football/nfl/powerindex`,
  `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${season}/powerindex`,
  `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${season}/types/2/powerindex`,
  `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${season}/powerindex/leaders`,
  `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${season}/teams/12/powerindex`,
  `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${season}/types/2/teams/12/powerindex`,
  `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${season}/types/2/teams/12/ranks`,
  `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/12`,
  `https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams`,
];

function outline(value, depth, maxDepth, indent = '  ') {
  if (Array.isArray(value)) {
    const first = value.length ? outline(value[0], depth + 1, maxDepth, indent) : '';
    return `[${value.length}]${first ? ` of ${first}` : ''}`;
  }
  if (value && typeof value === 'object') {
    if (depth >= maxDepth) return `{${Object.keys(value).slice(0, 12).join(',')}}`;
    const pad = indent.repeat(depth + 1);
    const lines = Object.entries(value).slice(0, 25).map(([k, v]) => `${pad}${k}: ${outline(v, depth + 1, maxDepth, indent)}`);
    return `{\n${lines.join('\n')}\n${indent.repeat(depth)}}`;
  }
  return typeof value === 'string' ? JSON.stringify(value.length > 60 ? `${value.slice(0, 60)}…` : value) : String(value);
}

async function get(url) {
  console.log(`\n=== ${url}`);
  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch (err) {
    console.log(`  transport error: ${err.message}`);
    return null;
  }
  const type = res.headers.get('content-type') || '';
  const text = await res.text();
  console.log(`  HTTP ${res.status}  ${type}  ${text.length} bytes`);
  if (!res.ok) {
    console.log(`  body: ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
    return null;
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.log(`  not JSON; head: ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
    return null;
  }
  console.log(`  outline:\n${outline(json, 0, 4, '    ')}`);
  console.log(`  head: ${text.slice(0, HEAD_CHARS)}`);
  return json;
}

// Mentions of power-index-ish names anywhere in a body, so a hit buried in an
// unrelated response (e.g. a team record's `ranks`) still gets noticed.
function mentionsFpi(json) {
  return /powerindex|fpi|"ranks"|powerrank/i.test(JSON.stringify(json));
}

for (const url of CANDIDATES) {
  const json = await get(url);
  if (!json) continue;
  console.log(`  mentions power index / ranks: ${mentionsFpi(json)}`);
  const ref = json.items?.[0]?.$ref;
  if (ref) await get(ref.replace(/^http:/, 'https:'));
}

// ---- Focused detail: the two shapes that answered with 200 in RUN 1 ----
// (fitt: one request, all 32 teams, positional category arrays; core: named
// `predictives`/`efficiencies`, paged at 25 with `team.$ref`.)
console.log('\n\n##### DETAIL #####');
const FITT = `https://site.api.espn.com/apis/fitt/v3/sports/football/nfl/powerindex?region=us&lang=en&season=${season}`;
const fitt = await (await fetch(FITT)).json();
console.log('\n-- fitt top-level categories (labels/names/displayNames):');
console.log(JSON.stringify(fitt.categories.map((c) => ({ name: c.name, displayName: c.displayName, names: c.names, labels: c.labels })), null, 1));
console.log('\n-- fitt glossary:');
console.log(JSON.stringify(fitt.glossary));
console.log('\n-- fitt teams[0] (team trimmed to id/abbr/group; categories in full):');
const t0 = fitt.teams[0];
console.log(JSON.stringify({ team: { id: t0.team.id, abbreviation: t0.team.abbreviation, displayName: t0.team.displayName, group: t0.team.group, ranks: t0.team.ranks }, categories: t0.categories }, null, 1));
console.log('\n-- fitt order check: abbreviations in response order (first 12):', fitt.teams.slice(0, 12).map((t) => t.team.abbreviation).join(' '));

const CORE = `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${season}/powerindex`;
for (const q of ['', '?limit=50']) {
  const core = await (await fetch(CORE + q)).json();
  console.log(`\n-- core ${CORE}${q}: count=${core.count} items=${core.items.length} pageSize=${core.pageSize} pageCount=${core.pageCount}`);
  if (q === '') {
    const it = core.items[0];
    console.log('team ref:', it.team.$ref, ' lastUpdated:', it.lastUpdated, ' runDateTimeKey:', it.runDateTimeKey);
    console.log('predictives:', JSON.stringify(it.predictives.map((p) => `${p.name}=${p.value} (${p.displayValue})`)));
    console.log('efficiencies:', JSON.stringify(it.efficiencies.map((p) => `${p.name}=${p.value} (${p.displayValue})`)));
  }
}
