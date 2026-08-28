// Follow-up to probe-espn-depth-chart.mjs, which found that ESPN's public
// core API (sports.core.api.espn.com) DOES expose depth charts, but every
// player on them comes back as an athlete `$ref` link rather than an
// embedded name — e.g. {"slot":1,"athlete":{"$ref":"http://sports.core.api
// .espn.com/.../athletes/4912218?lang=en&region=us"}}. Naively resolving
// every one of those with its own GET would be the same shape of mistake
// availabilityIsFresh/fetchMflRosteredNames exists to avoid on the MFL side
// (see fetch-rosters.mjs) — a "free-looking" per-player fetch that adds up
// to hundreds of requests across 32 teams.
//
// The cheaper path this probe tests: the athlete `$ref` URL's own numeric id
// (4912218 above) is plausibly ESPN's universal athlete id — the SAME id the
// site API's team roster endpoint returns per player (confirmed reachable
// and already dumped by probe-espn-depth-chart.mjs). If so, a name join
// needs zero athlete-ref fetches at all: one roster fetch + one depth-chart
// fetch per team, then a local id lookup. This probe checks whether that's
// actually true, and separately resolves ONE athlete `$ref` for real so the
// shape of a direct resolution is known too, in case the roster join turns
// out incomplete (e.g. a practice-squad or IR player who's on the depth
// chart but not the active roster response).
//
// No API key, no cookies: this host is unreachable from the sandbox this
// repo is normally edited from, so a workflow run is the only place to ask.
// Read-only: a small, bounded number of GETs — one roster fetch, one
// depth-chart fetch, and one single athlete-ref resolution, all for one
// sample team.
//
// What it reports:
//   - how many distinct athlete ids the depth chart response actually
//     references for one team, since that (times 32 teams) is the real
//     question if per-athlete fetches turn out to be necessary;
//   - what fraction of those ids are found in that same team's roster
//     response, by id;
//   - the full shape of one resolved athlete `$ref`, so a fallback fetch
//     (for whatever doesn't join) is at least a known cost rather than a
//     guess.
//
// First run, 2026-08 (workflow run 33213351656, team 12 / Kansas City):
// 105 total athlete slots across 3 depth charts (offense/defense/special
// teams presumably), deduping to 95 distinct athlete ids — the same starter
// shows up in more than one formation. ALL 95 matched the team roster
// response by id: a 100% join rate, zero fallback fetches needed. The one
// directly-resolved athlete confirmed the same shape the roster join
// already gives (displayName, position.abbreviation) as a sanity check —
// it also carries an `injuries` field, unused here since this project's
// existing convention (see attachInjuryDetail) is to source designations
// from MFL/ESPN's own roster data rather than reach for a second source.
// Conclusion: a Depth Charts sync costs exactly 2 requests per team (roster
// + depthcharts) x 32 teams = 64 total requests, with NO per-athlete fetch
// needed — the athlete `$ref`'s numeric id is ESPN's universal athlete id
// and joins directly against the site API roster response.

const SITE_BASE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const CORE_BASE = 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl';
const SAMPLE_TEAM_ABBR = 'kc';
const SAMPLE_TEAM_ID = 12; // Kansas City Chiefs, ESPN's numeric team id — same id used by probe-espn-depth-chart.mjs
const SEASON = new Date().getUTCFullYear();

async function getJson(label, url) {
  console.log(`\n--- ${label} ---`);
  console.log(`GET ${url}`);
  const res = await fetch(url);
  const body = await res.text();
  console.log(`HTTP ${res.status}  content-type: ${res.headers.get('content-type') ?? '—'}  bytes: ${body.length}`);
  if (!res.ok) {
    console.log(body.slice(0, 400));
    return null;
  }
  try {
    return JSON.parse(body);
  } catch (err) {
    console.log(`(not JSON) ${err.message}`);
    return null;
  }
}

// --- 1. the depth chart, same endpoint probe-espn-depth-chart.mjs hit ---
const depthChart = await getJson(
  'depth chart (season-scoped, core API)',
  `${CORE_BASE}/seasons/${SEASON}/teams/${SAMPLE_TEAM_ID}/depthcharts`
);
if (!depthChart) {
  console.error('\nCould not fetch the depth chart at all — nothing to test a join against.');
  process.exit(1);
}

// Walk every chart -> position -> athlete slot and pull the numeric id out
// of each $ref, deduping since the same starter shows up in more than one
// formation (e.g. a WR listed in both a base and a nickel package).
const ID_FROM_REF = /\/athletes\/(\d+)\?/;
const athleteIds = new Set();
const slots = [];
for (const chart of depthChart.items || []) {
  for (const [posKey, posVal] of Object.entries(chart.positions || {})) {
    for (const entry of posVal.athletes || []) {
      const ref = entry.athlete?.$ref || '';
      const m = ref.match(ID_FROM_REF);
      if (m) {
        athleteIds.add(m[1]);
        slots.push({ chart: chart.name, position: posKey, slot: entry.slot, id: m[1] });
      }
    }
  }
}
console.log(`\n${depthChart.items?.length ?? 0} depth chart(s) (formations/packages) for team ${SAMPLE_TEAM_ID}.`);
console.log(`${slots.length} total athlete slots across all of them, ${athleteIds.size} DISTINCT athlete ids.`);
console.log('First 10 slots:');
for (const s of slots.slice(0, 10)) {
  console.log(`  ${s.chart} / ${s.position} slot ${s.slot} -> athlete ${s.id}`);
}

// --- 2. the team roster, the candidate join target ---
const roster = await getJson('team roster (site API, same team)', `${SITE_BASE}/teams/${SAMPLE_TEAM_ABBR}/roster`);
const rosterById = new Map();
if (roster) {
  for (const group of roster.athletes || []) {
    for (const item of group.items || []) {
      if (item.id) rosterById.set(String(item.id), item);
    }
  }
}
console.log(`\nRoster carries ${rosterById.size} players (across offense/defense/specialTeams groups).`);

const matched = [...athleteIds].filter((id) => rosterById.has(id));
const unmatched = [...athleteIds].filter((id) => !rosterById.has(id));
console.log(`\nJoin result: ${matched.length}/${athleteIds.size} depth-chart athlete ids found in the roster by id.`);
if (matched.length) {
  const sample = rosterById.get(matched[0]);
  console.log(`Sample matched player: id=${matched[0]} -> ${sample?.displayName} (${sample?.position?.abbreviation ?? '—'})`);
}
if (unmatched.length) {
  console.log(`Unmatched ids (would need a fallback fetch): ${unmatched.slice(0, 10).join(', ')}${unmatched.length > 10 ? '…' : ''}`);
}

// --- 3. resolve exactly one athlete $ref directly, so the fallback cost is
// a known shape rather than a guess if the join above isn't 100%. ---
if (slots.length) {
  const sampleRef = (depthChart.items[0].positions[Object.keys(depthChart.items[0].positions)[0]].athletes[0]).athlete.$ref;
  const resolved = await getJson('resolve ONE athlete $ref directly', sampleRef);
  if (resolved) {
    console.log(`\nFields on a directly-resolved athlete: ${Object.keys(resolved).join(', ')}`);
    console.log(`  displayName=${resolved.displayName}  position=${resolved.position?.abbreviation ?? resolved.position?.$ref ?? '—'}`);
  }
}

console.log(
  `\n=== SUMMARY: one team costs 2 requests (roster + depthcharts) plus ${unmatched.length} fallback fetch(es) for ids the roster join misses. ` +
    `Extrapolated to 32 teams with this team's join rate: ~${32 * 2} base requests + ~${32 * unmatched.length} fallback fetches if every team's miss rate matches this one. ===`
);
