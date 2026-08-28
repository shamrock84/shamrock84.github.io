// Settles the one open question the Depth Charts tab design actually rests
// on: what does ESPN's core-API data actually encode as depth order?
//
// FIRST RUN (see below) already answered part of this and disproved the
// original premise: `slot` is NOT depth rank. It's a fixed formation-role
// code — every QB entry on every team is slot 9, every RB is slot 11, every
// TE is slot 10, and WR splits into three role slots (1/2/8, almost
// certainly outside-X / outside-Z / slot receiver). That's why the first
// version of this probe (which tested `slot` for a dense 1..N ladder) found
// nothing dense anywhere — it was testing the wrong field.
//
// The real signal was sitting on every entry the whole time, just not
// dumped by the first run: a `rank` field, e.g.
// {"slot":9,"athlete":{...},"rank":1}. The first athlete in every group
// checked was rank 1, and array order matched real-world depth for all 16
// team/position samples (Mahomes/Fields/Nussmeier/Oladokun at KC QB, Josh
// Allen/Kyle Allen/Buechele at BUF QB, etc.) — but that first run only
// dumped ONE entry's raw fields per group, so "rank forms a clean sequence"
// was confirmed for rank 1 only, not verified across a whole group. THIS
// run checks `rank` densely (1, 2, 3, ... no gaps or repeats) across every
// entry, grouped by `slot` since that's a real dimension (WR's three roles
// each need their own depth ladder, not one combined into WR1..WR14).
//
// Also confirmed by the first run and worth restating: a roster item DOES
// carry its own `injuries` field (San Francisco's roster had a real,
// non-empty one) — so injury status rides free on the same roster fetch
// already required for the id join, no separate request needed. That part
// of probe-espn-depth-chart-athletes.mjs's open question is settled; this
// run's roster-item check is left in only as a sanity re-confirmation.
//
// No API key, no cookies: unreachable from the sandbox this repo is
// normally edited from, so a workflow run is the only place to ask.
// Read-only: two GETs per sample team (depth chart + roster).

const SITE_BASE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const CORE_BASE = 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl';
const SEASON = new Date().getUTCFullYear();

// A handful of teams, not just the one probe-espn-depth-chart-athletes.mjs
// already looked at — a pattern seen on only one team could be that team's
// quirk (e.g. a QB competition) rather than the field's general meaning.
// Per-team failure doesn't stop the others; ids that turn out wrong just
// report a failure line rather than crashing the run.
const SAMPLE_TEAMS = [
  { id: 12, abbr: 'kc', name: 'Kansas City' },
  { id: 2, abbr: 'buf', name: 'Buffalo' },
  { id: 21, abbr: 'phi', name: 'Philadelphia' },
  { id: 25, abbr: 'sf', name: 'San Francisco' },
];

// The positions this project's leagues actually roster (see
// POWER_POSITIONS / POSITION_ORDER) — QB is the primary test since it's the
// cleanest case, the others are a secondary look at whether the same
// pattern holds for skill positions generally.
const POSITIONS_OF_INTEREST = ['qb', 'rb', 'wr', 'te'];

async function getJson(label, url) {
  console.log(`\n--- ${label} ---`);
  console.log(`GET ${url}`);
  try {
    const res = await fetch(url);
    const body = await res.text();
    console.log(`HTTP ${res.status}  bytes: ${body.length}`);
    if (!res.ok) {
      console.log(body.slice(0, 300));
      return null;
    }
    return JSON.parse(body);
  } catch (err) {
    console.log(`request failed: ${err.message}`);
    return null;
  }
}

const ID_FROM_REF = /\/athletes\/(\d+)\?/;
const overallFindings = [];

for (const team of SAMPLE_TEAMS) {
  console.log(`\n\n=== ${team.name} (team ${team.id}) ===`);

  const depthChart = await getJson('depth chart', `${CORE_BASE}/seasons/${SEASON}/teams/${team.id}/depthcharts`);
  if (!depthChart) {
    console.log(`  SKIP — depth chart fetch failed for team ${team.id}.`);
    continue;
  }

  console.log(`  ${depthChart.items?.length ?? 0} chart(s): ${(depthChart.items || []).map((c) => c.name).join(', ')}`);

  const roster = await getJson('roster (for readable names)', `${SITE_BASE}/teams/${team.abbr}/roster`);
  const rosterById = new Map();
  let sampleRosterItem = null;
  if (roster) {
    for (const group of roster.athletes || []) {
      for (const item of group.items || []) {
        if (item.id) rosterById.set(String(item.id), item);
        if (!sampleRosterItem) sampleRosterItem = item;
      }
    }
  }
  if (sampleRosterItem) {
    console.log(`  roster item fields: ${Object.keys(sampleRosterItem).join(', ')}`);
    console.log(`  does a roster item carry its own injury field? ${'injuries' in sampleRosterItem ? `YES — ${JSON.stringify(sampleRosterItem.injuries).slice(0, 200)}` : 'no'}`);
  }

  // Find every occurrence of each position of interest across ALL charts on
  // this team (not assuming which chart is "the offense") — if a position
  // shows up on more than one chart, that alone says something about how to
  // read this data.
  for (const posKey of POSITIONS_OF_INTEREST) {
    const occurrences = [];
    for (const chart of depthChart.items || []) {
      const posVal = chart.positions?.[posKey];
      if (posVal) occurrences.push({ chartName: chart.name, posVal });
    }
    if (occurrences.length === 0) continue;

    console.log(`\n  position "${posKey}": appears on ${occurrences.length} chart(s) — ${occurrences.map((o) => o.chartName).join(', ')}`);
    for (const { chartName, posVal } of occurrences) {
      const athletes = posVal.athletes || [];

      // `slot` is a formation-role code (WR splits into 3 role slots), not
      // depth order — so `rank` density is checked WITHIN each role group,
      // which is what actually decides whether `rank` is usable as depth.
      const bySlot = new Map();
      for (const a of athletes) {
        if (!bySlot.has(a.slot)) bySlot.set(a.slot, []);
        bySlot.get(a.slot).push(a);
      }

      for (const [slotValue, group] of bySlot) {
        const ranks = group.map((a) => a.rank);
        const uniqueRanks = new Set(ranks);
        const isDenseLadder =
          uniqueRanks.size === ranks.length && [...uniqueRanks].sort((a, b) => a - b).every((r, i) => r === i + 1);
        console.log(
          `    [${chartName}] slot=${slotValue}: ${group.length} athlete(s), ranks=[${ranks.join(',')}] ${
            isDenseLadder ? '-> DENSE 1..N (rank looks like real depth order)' : '-> NOT dense (duplicates or gaps in rank)'
          }`
        );
        // Readable names in rank order, so a human can eyeball plausibility.
        const named = group
          .slice()
          .sort((a, b) => a.rank - b.rank)
          .map((a) => {
            const m = (a.athlete?.$ref || '').match(ID_FROM_REF);
            const player = m ? rosterById.get(m[1]) : null;
            return `rank ${a.rank}: ${player?.displayName ?? `(unmatched id ${m?.[1] ?? '?'})`}`;
          })
          .join('  |  ');
        console.log(`      ${named}`);

        overallFindings.push({
          team: team.name,
          position: posKey,
          chart: chartName,
          slot: slotValue,
          count: group.length,
          isDenseLadder,
        });
      }
    }
  }
}

console.log('\n\n=== SUMMARY ===');
for (const f of overallFindings) {
  console.log(`  ${f.team.padEnd(14)} ${f.position.padEnd(4)} slot=${String(f.slot).padEnd(2)} [${f.chart}] n=${f.count} ${f.isDenseLadder ? 'DENSE' : 'NOT DENSE'}`);
}
const denseCount = overallFindings.filter((f) => f.isDenseLadder).length;
console.log(
  `\n${denseCount}/${overallFindings.length} (position, role-slot) groups have a dense 1..N \`rank\` ladder. ` +
    (denseCount === overallFindings.length
      ? 'Every one does — `rank`, grouped by `slot` as the role dimension, is safe to treat as depth order.'
      : '`rank` cannot be trusted as depth order without more work; see which rows say NOT DENSE above.')
);
