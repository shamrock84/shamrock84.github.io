// NFL team depth charts (starter/backup ordering per position), read from
// ESPN's PUBLIC site API — a completely different, unauthenticated surface
// from the cookie-gated fantasy-league API providers.mjs talks to, and from
// the FantasyPros partner API fantasypros.mjs talks to. No API key, no
// cookies, and NFL-wide rather than scoped to any one league: fetched once
// per sync regardless of how many leagues are configured.
//
// This exists because probe-fantasypros-depth-charts.mjs confirmed the
// FantasyPros partner API has no depth-chart data at all (every candidate
// endpoint 403'd), and probe-espn-depth-chart.mjs then confirmed ESPN's
// public core API does — followed by probe-espn-depth-chart-athletes.mjs
// (the athlete-id-to-roster join is free, no per-player fetch needed) and
// probe-espn-depth-chart-slot.mjs (the real depth signal is a `rank` field,
// not `slot`, which is actually a WR-only alignment-role code). Read those
// probes' headers before changing anything about how a response here is
// parsed — this whole module rests on behavior of an UNDOCUMENTED,
// unofficial endpoint, confirmed empirically rather than from any spec.
//
// Budget: 1 request for the team list, then 2 per team (depth chart +
// roster) x 32 teams = 65 requests a sync. A completely different host from
// MFL/ESPN's fantasy APIs, so this never competes with their rate limits —
// unlike the availability pass, this runs every sync, no once-a-day
// throttling needed.
//
// Degrades like everything else in this sync: a team whose fetch fails is
// skipped (logged, not thrown), so one bad team never blanks out the other
// 31. If the team list itself can't be fetched, fetchAllDepthCharts throws
// and the caller in fetch-rosters.mjs falls back to the previous run's
// data/rosters.json entry, exactly like FantasyPros rankings do.

const SITE_BASE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const CORE_BASE = 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl';

// The positions this project's leagues actually roster (see
// POWER_POSITIONS/POSITION_ORDER in myffl.html and providers.mjs) — nothing
// here rosters an individual defensive lineman, so the sync doesn't store
// ESPN's DL/LB/DB groups at all. Confirmed present as exactly these lowercase
// keys under a chart's `positions` object by probe-espn-depth-chart-slot.mjs.
export const DEPTH_CHART_POSITIONS = ['qb', 'rb', 'wr', 'te'];

// WR is the one position ESPN splits into alignment roles rather than one
// straight depth ladder — confirmed by probe-espn-depth-chart-slot.mjs
// across 4 sample teams, every one sharing a "3WR 1TE" personnel package
// (3 WR roles + 1 TE, matching exactly the 3 distinct `slot` values found).
// `rank` still forms one clean 1..N ladder across all three roles combined
// (they interleave X/Z/S/X/Z/S/...) — this mapping is purely a display tag,
// never used for ordering. Not confirmed by any ESPN field name, only by
// the personnel-package name and standard football terminology; low risk to
// have swapped X and Z, very safe on S given `slot` itself is presumably
// named after "slot receiver".
const WR_ROLE_BY_SLOT = { 1: 'X', 2: 'Z', 8: 'S' };

const ATHLETE_ID_FROM_REF = /\/athletes\/(\d+)\?/;

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} at ${url}`);
  }
  return res.json();
}

// The full 32-team list, fetched fresh every sync rather than hand-
// maintained here — a wrong hardcoded id would silently 404 forever, where
// deriving it from ESPN's own listing can't drift. Costs one extra request
// against a completely separate rate-limit budget from MFL/ESPN-fantasy.
export async function fetchTeamList() {
  const data = await fetchJson(`${SITE_BASE}/teams`);
  const teams = [];
  for (const sport of data?.sports || []) {
    for (const league of sport.leagues || []) {
      for (const entry of league.teams || []) {
        const team = entry?.team;
        if (!team?.id || !team?.abbreviation) continue;
        teams.push({ id: team.id, abbr: team.abbreviation, name: team.displayName || team.abbreviation });
      }
    }
  }
  return teams;
}

// A team's roster, keyed by ESPN's own numeric athlete id — the SAME id
// space the depth chart's athlete `$ref` carries, confirmed by
// probe-espn-depth-chart-athletes.mjs to join at 100% with zero fallback
// fetches needed. `injuryStatus` is the roster response's own `injuries`
// field (confirmed present, e.g. `{"status":"Out","date":"..."}`, by that
// same probe) — free on this one request, no separate injury fetch.
function buildRosterIndex(rosterData) {
  const byId = new Map();
  for (const group of rosterData?.athletes || []) {
    for (const item of group.items || []) {
      if (!item?.id) continue;
      const injuries = Array.isArray(item.injuries) ? item.injuries : [];
      byId.set(String(item.id), {
        name: item.displayName || item.fullName || null,
        injuryStatus: injuries[0]?.status || null,
      });
    }
  }
  return byId;
}

// Pure and separately tested (see test-espn-depth-chart.mjs) against fixture
// JSON shaped exactly like the real probe output, since this is where every
// assumption about the undocumented shape actually gets applied.
//
// Walks every chart on the team (not just one assumed "offense" chart —
// probe-espn-depth-chart-slot.mjs found the position lives on whichever
// chart is named "3WR 1TE", which varies in name by team's base defensive
// scheme, e.g. "Base 4-3 D" vs "Base 3-4 D"), pulls the athlete id out of
// each entry's `$ref`, joins it against the roster index, and sorts by
// `rank` — never by `slot`, which is the WR-only role tag, not depth order.
// An entry with no rank, no resolvable id, or no roster match is dropped
// rather than guessed at, matching buildRankingList's same `rank != null`
// principle for FantasyPros' own lists.
export function extractDepthChartEntries(depthChartData, posKey, rosterById) {
  const entries = [];
  for (const chart of depthChartData?.items || []) {
    const posVal = chart?.positions?.[posKey];
    if (!posVal) continue;
    for (const a of posVal.athletes || []) {
      const rank = Number(a?.rank);
      if (!(rank > 0)) continue;
      const ref = a?.athlete?.$ref || '';
      const match = ref.match(ATHLETE_ID_FROM_REF);
      if (!match) continue;
      const id = match[1];
      const player = rosterById.get(id);
      if (!player || !player.name) continue;
      entries.push({
        id,
        name: player.name,
        rank,
        role: posKey === 'wr' ? WR_ROLE_BY_SLOT[a.slot] || null : null,
        injuryStatus: player.injuryStatus,
      });
    }
  }
  return entries.sort((a, b) => a.rank - b.rank);
}

// One team's depth chart across DEPTH_CHART_POSITIONS, {QB: [...], RB:
// [...], ...} with a position omitted entirely rather than an empty array
// when the chart carries nothing for it — the page treats "no key" and
// "nothing here" the same way every other omitted field in this project
// does. Throws on either request failing; the caller in fetchAllDepthCharts
// catches per-team so one team's ESPN hiccup doesn't blank the other 31.
export async function fetchTeamDepthChart(team, season) {
  const [depthChart, roster] = await Promise.all([
    fetchJson(`${CORE_BASE}/seasons/${season}/teams/${team.id}/depthcharts`),
    fetchJson(`${SITE_BASE}/teams/${team.abbr.toLowerCase()}/roster`),
  ]);
  const rosterById = buildRosterIndex(roster);
  const positions = {};
  for (const posKey of DEPTH_CHART_POSITIONS) {
    const entries = extractDepthChartEntries(depthChart, posKey, rosterById);
    if (entries.length > 0) positions[posKey.toUpperCase()] = entries;
  }
  return positions;
}

// Orchestrates the whole pass: the team list, then every team's depth
// chart, one team's failure logged and skipped rather than thrown. Throws
// only if the team list itself can't be fetched — at that point there is
// nothing to iterate, and the caller falls back to the previous run's data
// entirely rather than writing an empty `teams: {}`.
export async function fetchAllDepthCharts({ season }) {
  const teamList = await fetchTeamList();
  const teams = {};
  let failures = 0;
  for (const team of teamList) {
    try {
      const positions = await fetchTeamDepthChart(team, season);
      teams[team.abbr] = { name: team.name, ...positions };
    } catch (err) {
      failures++;
      console.error(`Depth chart failed for ${team.name} (${team.abbr}): ${err.message}`);
    }
  }
  return { generatedAt: new Date().toISOString(), teams, teamCount: teamList.length, failureCount: failures };
}
