// Settles the one open question the Depth Charts tab design actually rests
// on: does ESPN's core-API `slot` field mean depth rank (1 = starter, 2 =
// backup, ...), or something else entirely?
//
// probe-espn-depth-chart-athletes.mjs dumped team 12's (Kansas City) full
// depth chart and the raw output was suspicious for this: the defensive
// line position "lde" carried SIX entries all at slot 1, which doesn't fit
// a starter/backup/third-string ladder at all. That probe wasn't looking at
// this question, so it wasn't investigated further at the time. It matters
// now because the tab's whole reason to exist over an ECR-sorted list is
// that its player ORDER comes from the real depth chart, not from rank —
// if `slot` isn't actually depth order, that promise is false.
//
// QB is the position to test it on: nobody splits QB reps across a
// personnel-package rotation the way a defensive line does, so if `slot`
// means depth rank anywhere, it means it there. This checks QB (and, as a
// second look, RB/WR/TE — the other positions this project's leages
// actually roster) across several teams, for:
//   - are slot numbers within one position UNIQUE and DENSE (1, 2, 3, ...
//     no gaps, no repeats)?
//   - does the position appear on exactly one of the team's depth charts
//     (an "Offense" chart), not scattered across several the way "lde" was?
//   - does the FULL raw entry carry any field besides {slot, athlete} that
//     might be the real depth indicator instead?
//
// As a free side-check (already paid for by the roster fetch this needs for
// readable names anyway): whether a roster item carries its own injury
// field, which would answer probe-espn-depth-chart-athletes.mjs's other
// open question — whether injury status can ride along on the same request
// that's already required for the name join, or needs its own fetch.
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
      const slots = athletes.map((a) => a.slot);
      const uniqueSlots = new Set(slots);
      const isDenseLadder =
        uniqueSlots.size === slots.length && [...uniqueSlots].sort((a, b) => a - b).every((s, i) => s === i + 1);
      console.log(
        `    [${chartName}] ${athletes.length} athlete(s), slots=[${slots.join(',')}] ${
          isDenseLadder ? '-> DENSE 1..N LADDER (looks like real depth order)' : '-> NOT a dense ladder (duplicates or gaps)'
        }`
      );
      // Full raw shape of the first entry, unfiltered — in case there's a
      // field besides {slot, athlete} that's the real depth signal.
      if (athletes[0]) {
        console.log(`    first entry, full raw fields: ${JSON.stringify(athletes[0])}`);
      }
      // Readable names in slot order, so a human can eyeball plausibility.
      const named = athletes
        .map((a) => {
          const m = (a.athlete?.$ref || '').match(ID_FROM_REF);
          const player = m ? rosterById.get(m[1]) : null;
          return `slot ${a.slot}: ${player?.displayName ?? `(unmatched id ${m?.[1] ?? '?'})`}`;
        })
        .join('  |  ');
      console.log(`    ${named}`);

      overallFindings.push({ team: team.name, position: posKey, chart: chartName, count: athletes.length, isDenseLadder });
    }
  }
}

console.log('\n\n=== SUMMARY ===');
for (const f of overallFindings) {
  console.log(`  ${f.team.padEnd(14)} ${f.position.padEnd(4)} [${f.chart}] n=${f.count} ${f.isDenseLadder ? 'DENSE' : 'NOT DENSE'}`);
}
const denseCount = overallFindings.filter((f) => f.isDenseLadder).length;
console.log(
  `\n${denseCount}/${overallFindings.length} position-occurrences form a dense 1..N slot ladder. ` +
    (denseCount === overallFindings.length
      ? 'Every one does — `slot` looks safe to treat as depth order for these positions.'
      : 'Not all of them do — `slot` cannot be trusted as depth order without more work; see which rows say NOT DENSE above.')
);
