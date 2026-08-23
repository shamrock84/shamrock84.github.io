// Asks each provider what it actually exposes about a PAST, fully-completed
// season: how far back a league's history goes, and whether anything in the
// response carries a final standing/placement (as opposed to the live
// in-season W-L order fetchStandings/fetchEspnStandings/fetchSleeperStandings
// already read). Nothing today parses a rank/place field for any provider —
// this is step one of building the History tab's Results card, which needs
// exactly that, and myfantasyleague.com/ESPN/Sleeper are all unreachable from
// the sandbox this repo is normally edited from.
//
// Read-only throughout. Three separate questions, one per provider, since
// each keeps history a different way:
//
//   MFL keeps the same league id forever — TYPE=league?YEAR=<y> either
//   answers or 404s (see mflLeagueExists) — so "how far back does this go" is
//   a walk-back over existing plumbing. The open question is what
//   TYPE=leagueStandings and TYPE=playoffBracket return for a year that's
//   fully over: does the standings order already reflect the playoff bracket,
//   or is there a separate field/endpoint for final placement?
//
//   ESPN also keeps the same league id, so the same walk-back applies via
//   espnLeagueExists. The open question is whether mTeam/mStandings carries a
//   final rank field (e.g. a calculated standing) once the season is done.
//
//   Sleeper mints a NEW league id every season, chained backward via
//   `previous_league_id` on the league object — a completely different
//   mechanism, unexplored anywhere in this codebase. The open question is
//   whether that chain is real and how many hops it survives, plus whether
//   winners_bracket/losers_bracket carries a placement field for the
//   championship/3rd-place/etc. matches (commonly `p` in Sleeper's public
//   API elsewhere, but unconfirmed for this project).
//
// Run from the Actions tab (probe-league-history.yml). Every fetch is wrapped
// so one provider's failure (a stale ESPN cookie, a league with no Sleeper
// history) doesn't stop the others from reporting.

import { mflLogin, mflGet, mflLeagueExists, espnGet, espnLeagueExists, YEAR } from './lib/providers.mjs';

const MFL_LEAGUE_ID = process.env.PROBE_MFL_LEAGUE_ID;
const ESPN_LEAGUE_ID = process.env.PROBE_ESPN_LEAGUE_ID;
const SLEEPER_LEAGUE_ID = process.env.PROBE_SLEEPER_LEAGUE_ID;
const TARGET_YEAR = Number(process.env.PROBE_PAST_YEAR || Number(YEAR) - 1);
const LOOKBACK_YEARS = Number(process.env.PROBE_LOOKBACK_YEARS || 8);

function dumpFields(label, obj) {
  console.log(`  --- ${label} ---`);
  if (obj === null || obj === undefined) {
    console.log('    (null/undefined)');
    return;
  }
  for (const [k, v] of Object.entries(obj)) {
    const shown = typeof v === 'object' && v !== null ? JSON.stringify(v).slice(0, 200) : String(v);
    console.log(`    ${k}: ${shown}`);
  }
}

// ---- MFL -------------------------------------------------------------

if (MFL_LEAGUE_ID) {
  console.log(`\n=== MFL league ${MFL_LEAGUE_ID} ===\n`);
  const cookie = await mflLogin(process.env.MFL_USERNAME, process.env.MFL_PASSWORD);

  console.log(`--- existence walk-back from ${TARGET_YEAR} (${LOOKBACK_YEARS} years) ---`);
  const mflYears = [];
  for (let y = TARGET_YEAR; y > TARGET_YEAR - LOOKBACK_YEARS; y--) {
    const exists = await mflLeagueExists({ id: MFL_LEAGUE_ID }, cookie, String(y));
    console.log(`  ${y}: ${exists}`);
    if (exists) mflYears.push(y);
  }

  const probeYear = mflYears.includes(TARGET_YEAR) ? TARGET_YEAR : mflYears[0];
  if (probeYear === undefined) {
    console.log(`  No year in range existed for this league — skipping standings/bracket probes.`);
  } else {
    console.log(`\n--- TYPE=leagueStandings, year ${probeYear} ---`);
    try {
      const data = await mflGet(`/export?TYPE=leagueStandings&L=${MFL_LEAGUE_ID}&JSON=1`, cookie, String(probeYear));
      const rows = data?.leagueStandings?.franchise;
      const rowList = Array.isArray(rows) ? rows : rows ? [rows] : [];
      console.log(`  franchise rows: ${rowList.length}`);
      if (rowList.length) dumpFields('first row, every field', rowList[0]);
    } catch (err) {
      console.log(`  threw — ${err.message}`);
    }

    console.log(`\n--- TYPE=playoffBracket, year ${probeYear} ---`);
    try {
      const data = await mflGet(`/export?TYPE=playoffBracket&L=${MFL_LEAGUE_ID}&JSON=1`, cookie, String(probeYear));
      console.log(`  top-level keys: ${JSON.stringify(Object.keys(data || {}))}`);
      console.log(`  body (first 1000 chars): ${JSON.stringify(data).slice(0, 1000)}`);
    } catch (err) {
      console.log(`  threw — ${err.message}`);
    }
  }
} else {
  console.log('\n(no PROBE_MFL_LEAGUE_ID — skipping MFL)');
}

// ---- ESPN --------------------------------------------------------------

if (ESPN_LEAGUE_ID) {
  console.log(`\n=== ESPN league ${ESPN_LEAGUE_ID} ===\n`);
  const haveCookies = Boolean(process.env.ESPN_S2 && process.env.ESPN_SWID);
  console.log(`  espn_s2/SWID present: ${haveCookies}`);

  console.log(`--- existence walk-back from ${TARGET_YEAR} (${LOOKBACK_YEARS} years) ---`);
  const espnYears = [];
  for (let y = TARGET_YEAR; y > TARGET_YEAR - LOOKBACK_YEARS; y--) {
    const exists = await espnLeagueExists({ id: ESPN_LEAGUE_ID, provider: 'espn' }, String(y));
    console.log(`  ${y}: ${exists}`);
    if (exists) espnYears.push(y);
  }

  const probeYear = espnYears.includes(TARGET_YEAR) ? TARGET_YEAR : espnYears[0];
  if (probeYear === undefined) {
    console.log(`  No year in range existed for this league — skipping team/standings probe.`);
  } else {
    console.log(`\n--- view=mTeam&view=mStandings, year ${probeYear} ---`);
    try {
      const data = await espnGet(
        { id: ESPN_LEAGUE_ID, provider: 'espn', season: String(probeYear) },
        'view=mTeam&view=mStandings'
      );
      const teams = data?.teams || [];
      console.log(`  teams: ${teams.length}`);
      if (teams.length) dumpFields('first team, every field', teams[0]);
      if (teams[0]?.record) dumpFields('first team record', teams[0].record);
    } catch (err) {
      console.log(`  threw — ${err.message}`);
    }
  }
} else {
  console.log('\n(no PROBE_ESPN_LEAGUE_ID — skipping ESPN)');
}

// ---- Sleeper -------------------------------------------------------------

const SLEEPER_BASE = 'https://api.sleeper.app/v1';
async function sleeperGetRaw(path) {
  const res = await fetch(`${SLEEPER_BASE}${path}`);
  if (!res.ok) {
    const err = new Error(`Sleeper request failed (${res.status}): ${path}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

if (SLEEPER_LEAGUE_ID) {
  console.log(`\n=== Sleeper league ${SLEEPER_LEAGUE_ID} ===\n`);

  console.log(`--- previous_league_id chain, up to ${LOOKBACK_YEARS} hops ---`);
  const chain = [];
  let currentId = SLEEPER_LEAGUE_ID;
  for (let hop = 0; hop < LOOKBACK_YEARS && currentId; hop++) {
    try {
      const data = await sleeperGetRaw(`/league/${currentId}`);
      console.log(
        `  hop ${hop}: id=${data.league_id} season=${data.season} status=${data.status} previous_league_id=${data.previous_league_id}`
      );
      chain.push(data);
      currentId = data.previous_league_id || null;
    } catch (err) {
      console.log(`  hop ${hop}: threw — ${err.message}`);
      break;
    }
  }

  const target = chain.find((l) => String(l.season) === String(TARGET_YEAR)) || chain[chain.length - 1];
  if (!target) {
    console.log('  No league in the chain to probe brackets for.');
  } else {
    console.log(`\n--- winners_bracket, league ${target.league_id} (season ${target.season}) ---`);
    try {
      const bracket = await sleeperGetRaw(`/league/${target.league_id}/winners_bracket`);
      console.log(`  matches: ${bracket.length}`);
      console.log(`  raw (first 1500 chars): ${JSON.stringify(bracket).slice(0, 1500)}`);
    } catch (err) {
      console.log(`  threw — ${err.message}`);
    }

    console.log(`\n--- losers_bracket, league ${target.league_id} (season ${target.season}) ---`);
    try {
      const bracket = await sleeperGetRaw(`/league/${target.league_id}/losers_bracket`);
      console.log(`  matches: ${bracket.length}`);
      console.log(`  raw (first 1500 chars): ${JSON.stringify(bracket).slice(0, 1500)}`);
    } catch (err) {
      console.log(`  threw — ${err.message}`);
    }
  }
} else {
  console.log('\n(no PROBE_SLEEPER_LEAGUE_ID — skipping Sleeper)');
}

console.log('\n=== done ===');
