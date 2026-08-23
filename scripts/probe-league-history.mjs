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
//
// First run, 2026-08 (league 26696 MFL / 1966972 ESPN / 1367867592919760896
// Sleeper, year 2025): MFL's league goes back at least 8 years (2018-2025 all
// existed) but TYPE=leagueStandings carries no rank field at all — the same
// h2hw/h2hl/pf/pa shape the live sync already reads — so whether the row
// order reflects the playoff bracket or just the regular-season record is
// still unconfirmed; TYPE=playoffBracket exists but requires an ID this run
// didn't supply ("Invalid or missing playoff bracket id"), now probed below.
// ESPN's mTeam/mStandings DOES carry what looks like the answer:
// rankCalculatedFinal (populated even for a non-playoff team, e.g. 6th of 10)
// and a separate rankFinal that was 0 for that same team — now checked across
// every team below to see whether rankCalculatedFinal forms a clean 1..N
// permutation and which teams (if any) get a non-zero rankFinal. Sleeper's
// one configured league had no history yet (previous_league_id was null, a
// brand-new league) and its brackets returned null (mid-season, not yet
// generated) — nothing there to confirm the placement field with, and out of
// scope for now by request.
//
// Second run, 2026-08 (MFL/ESPN only, Sleeper out of scope by request): MFL's
// TYPE=league carries a `history.league[]` field — {year, url} for every
// season on record, with that year's league id embedded in the url — so this
// league (26696) actually goes back to 2006, through several earlier ids
// (80522 in 2006, 46820 in 2008, ...) before settling on 26696 in 2016. Much
// better than a walk-back: one call gives the whole year->id map, even across
// an id change. Confirmed leagueStandings is regular-season-only: the top
// row's h2hwlt (13-1-0, 14 games) exactly equals lastRegularSeasonWeek (14),
// with endWeek 18 — so playoff weeks 15-18 are NOT folded into h2hw/h2hl.
// TYPE=playoffBracket&ID=1 and &ID=2 both still failed with the same "Invalid
// or missing playoff bracket id", and no bracket-id field turned up anywhere
// searched so far — now searched exhaustively (every nested key, not just
// top-level) below, plus a plural TYPE=playoffBrackets listing attempt and a
// weeklyResults pull for the actual playoff weeks as a derivation fallback.
// ESPN is settled: rankCalculatedFinal formed a clean 1..10 permutation
// across all 10 teams (not just a mirror of playoffSeed — e.g. seed 9 finished
// rankCalculatedFinal 8, seed 7 finished 9), and rankFinal was 0 for every
// team, so that field is unused here. rankCalculatedFinal is the answer for
// ESPN; no further ESPN investigation needed.
//
// Third run, 2026-08: the recursive search found nothing in leagueStandings
// or TYPE=league (confirmed dead ends). But TYPE=playoffBrackets (PLURAL —
// note the s) is real and lists every bracket the league ran that year:
// {id, name, bracketWinnerTitle, startWeek, teamsInvolved} — for league
// 26696/2025, four brackets (Fantasy Bowl id=1 "Fantasy Bowl Champion" 5
// teams from week 15; Fantasy Bowl Consolation id=2 "3rd Place" 2 teams from
// week 17; Toilet Bowl id=3 "Toilet Bowl Winner" 5 teams from week 15; Toilet
// Bowl Consolation id=4 "8th Place" 2 teams from week 17) — the titles
// themselves spell out placement labels. Oddly, TYPE=playoffBracket
// (singular) STILL rejected ID=1 with the identical error even though the
// listing just confirmed 1 is real for this league+year — something about
// how the singular endpoint wants its id is still wrong, now tried with a
// few parameter-name variants below. Bracket LISTING alone isn't enough on
// its own regardless: it names the brackets and their winner titles but not
// which franchise ended up holding each title, so either the singular
// endpoint needs to actually work, or final placement has to be derived by
// hand from the playoff weeks' matchup results (weeklyResults) — which this
// round also reworks to summarize matchups by franchise id + score instead
// of a raw player-level dump that got cut off before anything useful.

import { mflLogin, mflGet, mflLeagueExists, espnGet, espnLeagueExists, YEAR, fetchMflLeagueHistory } from './lib/providers.mjs';

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

// Walks the WHOLE parsed body — not just top-level fields, which dumpFields
// showed truncated to 200 chars each and could easily hide a bracket
// reference nested inside e.g. `franchises` — looking for any key whose name
// contains `needle` (case-insensitive). Reports the path so a hit is
// unambiguous about where it lives.
function findKeysContaining(obj, needle, path = '') {
  if (obj === null || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    const here = path ? `${path}.${k}` : k;
    if (k.toLowerCase().includes(needle)) {
      const shown = typeof v === 'object' && v !== null ? JSON.stringify(v).slice(0, 300) : String(v);
      console.log(`    MATCH ${here}: ${shown}`);
    }
    if (v && typeof v === 'object') findKeysContaining(v, needle, here);
  }
}

// ---- MFL -------------------------------------------------------------

if (MFL_LEAGUE_ID) {
  console.log(`\n=== MFL league ${MFL_LEAGUE_ID} ===\n`);
  const cookie = await mflLogin(process.env.MFL_USERNAME, process.env.MFL_PASSWORD);

  // Fourth run: diagnosing why Iron Bank's earliest backfilled years
  // (2012-2014) came back guessed. history.league[] answers the same
  // regardless of which season you ask it in (see fetchMflLeagueHistory in
  // providers.mjs), so this just needs SOME valid season for MFL_LEAGUE_ID
  // — dumps the whole year->id map so a follow-up run can target an old
  // year's OWN id directly, the same way backfillLeagueHistory does.
  console.log(`--- history.league[] year->id map (via TYPE=league) ---`);
  try {
    const historyYears = await fetchMflLeagueHistory({ id: MFL_LEAGUE_ID }, cookie, String(TARGET_YEAR));
    for (const h of historyYears) console.log(`  ${h.year}: id=${h.id}`);
  } catch (err) {
    console.log(`  threw — ${err.message}`);
  }

  console.log(`\n--- existence walk-back from ${TARGET_YEAR} (${LOOKBACK_YEARS} years) ---`);
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
    let standingsData = null;
    try {
      standingsData = await mflGet(`/export?TYPE=leagueStandings&L=${MFL_LEAGUE_ID}&JSON=1`, cookie, String(probeYear));
      const rows = standingsData?.leagueStandings?.franchise;
      const rowList = Array.isArray(rows) ? rows : rows ? [rows] : [];
      console.log(`  franchise rows: ${rowList.length}`);
      if (rowList.length) dumpFields('first row, every field', rowList[0]);
      console.log('  --- searching leagueStandings for anything named *bracket*/*place*/*final*/*rank* ---');
      findKeysContaining(standingsData, 'bracket');
      findKeysContaining(standingsData, 'place');
      findKeysContaining(standingsData, 'final');
      findKeysContaining(standingsData, 'rank');
    } catch (err) {
      console.log(`  threw — ${err.message}`);
    }

    // Round 2 confirmed the games-played arithmetic (h2hwlt totals ==
    // lastRegularSeasonWeek exactly) — leagueStandings is regular-season
    // seeding only, not adjusted for who actually won the bracket. This
    // round: search the FULL TYPE=league body (not just its top-level
    // fields, which dumpFields truncates at 200 chars each and could hide a
    // bracket reference nested inside e.g. `franchises`) for anything named
    // *bracket*, try the plural listing endpoint, and — since the league's
    // own playoff window is now known (lastRegularSeasonWeek+1..endWeek) —
    // pull the actual head-to-head matchups for those weeks as a fallback:
    // even with no explicit placement field, who-beat-whom in the final
    // week's matchups is enough to derive the bracket by hand.
    console.log(`\n--- TYPE=league, year ${probeYear} (searching full body for bracket/playoff fields) ---`);
    let lastRegWeek = null;
    let endWeek = null;
    try {
      const data = await mflGet(`/export?TYPE=league&L=${MFL_LEAGUE_ID}&JSON=1`, cookie, String(probeYear));
      lastRegWeek = Number(data?.league?.lastRegularSeasonWeek);
      endWeek = Number(data?.league?.endWeek);
      console.log(`  lastRegularSeasonWeek=${lastRegWeek} endWeek=${endWeek}`);
      console.log('  --- searching for anything named *bracket*/*playoff* ---');
      findKeysContaining(data, 'bracket');
      findKeysContaining(data, 'playoff');
    } catch (err) {
      console.log(`  threw — ${err.message}`);
    }

    console.log(`\n--- TYPE=playoffBrackets (plural, listing), year ${probeYear} ---`);
    let bracketList = [];
    try {
      const data = await mflGet(`/export?TYPE=playoffBrackets&L=${MFL_LEAGUE_ID}&JSON=1`, cookie, String(probeYear));
      console.log(`  top-level keys: ${JSON.stringify(Object.keys(data || {}))}`);
      console.log(`  body (first 1500 chars): ${JSON.stringify(data).slice(0, 1500)}`);
      const raw = data?.playoffBrackets?.playoffBracket;
      bracketList = Array.isArray(raw) ? raw : raw ? [raw] : [];
    } catch (err) {
      console.log(`  threw — ${err.message}`);
    }

    // Fetch every bracket the listing named, not just id 1 — a league whose
    // bracket names don't match the "Consolation"/"Toilet" keyword scheme
    // (e.g. Iron Bank 2020: "Fantasy Bowl", "3rd Place Game", "7/8 position",
    // "Toilet Bowl") needs its OTHER brackets' actual game trees to diagnose
    // why computeMflSeasonPlacements fell back to a guess for a team that
    // really did have a determinable placement.
    for (const b of bracketList) {
      console.log(`\n--- TYPE=playoffBracket&BRACKET_ID=${b.id} ("${b.name}", ${b.teamsInvolved} teams), year ${probeYear} ---`);
      try {
        const data = await mflGet(
          `/export?TYPE=playoffBracket&L=${MFL_LEAGUE_ID}&BRACKET_ID=${b.id}&JSON=1`,
          cookie,
          String(probeYear)
        );
        console.log(`  body: ${JSON.stringify(data)}`);
      } catch (err) {
        console.log(`  threw — ${err.message}`);
      }
    }

    // The plural listing worked and confirmed ids 1/2/3/4 are real for this
    // league+year, yet the singular endpoint rejected ID=1 and ID=2 with the
    // exact same error — so the id itself isn't the problem, something about
    // how it's being passed is. Try a handful of plausible parameter-name
    // variants for bracket id 1 (the real championship bracket) before
    // giving up on this endpoint.
    for (const [label, params] of [
      ['ID=1', `ID=1`],
      ['BRACKET_ID=1', `BRACKET_ID=1`],
      ['bracket_id=1', `bracket_id=1`],
      ['bracketId=1', `bracketId=1`],
      ['ID=1&W=15', `ID=1&W=15`],
    ]) {
      console.log(`\n--- TYPE=playoffBracket&${label}, year ${probeYear} ---`);
      try {
        const data = await mflGet(
          `/export?TYPE=playoffBracket&L=${MFL_LEAGUE_ID}&${params}&JSON=1`,
          cookie,
          String(probeYear)
        );
        console.log(`  top-level keys: ${JSON.stringify(Object.keys(data || {}))}`);
        console.log(`  body (first 1500 chars): ${JSON.stringify(data).slice(0, 1500)}`);
      } catch (err) {
        console.log(`  threw — ${err.message}`);
      }
    }

    // Fallback path if the bracket endpoint never cooperates: summarize each
    // playoff week's matchups down to franchise id + total score (the first
    // run's raw dump was dominated by player-level detail and got cut off
    // before showing whether a franchise-level total score field exists at
    // all) — enough to derive who beat whom by hand, and to check whether a
    // franchise-level `score` field exists to read directly rather than
    // summing starters.
    if (Number.isFinite(lastRegWeek) && Number.isFinite(endWeek)) {
      for (let week = lastRegWeek + 1; week <= endWeek; week++) {
        console.log(`\n--- TYPE=weeklyResults&W=${week} (playoff week), year ${probeYear} ---`);
        try {
          const data = await mflGet(
            `/export?TYPE=weeklyResults&L=${MFL_LEAGUE_ID}&W=${week}&JSON=1`,
            cookie,
            String(probeYear)
          );
          const matchups = data?.weeklyResults?.matchup;
          const matchupList = Array.isArray(matchups) ? matchups : matchups ? [matchups] : [];
          console.log(`  matchups: ${matchupList.length}, regularSeason flag(s): ${JSON.stringify(matchupList.map((m) => m.regularSeason))}`);
          for (const m of matchupList) {
            const franchises = Array.isArray(m.franchise) ? m.franchise : m.franchise ? [m.franchise] : [];
            const summary = franchises.map((f) => {
              const players = Array.isArray(f.player) ? f.player : f.player ? [f.player] : [];
              const starterSum = players
                .filter((p) => p.shouldStart === '1' || p.status === 'starter')
                .reduce((sum, p) => sum + (Number(p.score) || 0), 0);
              return `id=${f.id} own-score-field=${f.score ?? '(none)'} summed-starters=${starterSum.toFixed(1)}`;
            });
            console.log(`    matchup: ${summary.join('  vs  ')}`);
          }
          // No matchup array at all (week 17's first run) — dump top-level
          // shape directly so it's clear whether that's a truncation
          // artifact or a genuinely different structure for that week.
          if (matchupList.length === 0) {
            console.log(`  no matchup array — top-level weeklyResults keys: ${JSON.stringify(Object.keys(data?.weeklyResults || {}))}`);
          }
        } catch (err) {
          console.log(`  threw — ${err.message}`);
        }
      }
    } else {
      console.log('\n  (lastRegularSeasonWeek/endWeek not resolved — skipping weeklyResults)');
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

      // The first run only showed one non-playoff team. What actually
      // decides "3rd place" is whether rankCalculatedFinal forms a clean
      // 1..N permutation across every team (including the ones that made
      // the playoffs), and whether rankFinal is ever non-zero — if so, for
      // which teams, since a field only set for the top few would mean a
      // different source for the rest.
      console.log('\n  --- rank fields across every team ---');
      for (const t of teams) {
        console.log(
          `    id=${t.id} name=${JSON.stringify(t.name)} seed=${t.playoffSeed} ` +
            `rankCalculatedFinal=${t.rankCalculatedFinal} rankFinal=${t.rankFinal} ` +
            `overall=${JSON.stringify(t.record?.overall)}`
        );
      }
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
    for (const kind of ['winners_bracket', 'losers_bracket']) {
      console.log(`\n--- ${kind}, league ${target.league_id} (season ${target.season}) ---`);
      try {
        const bracket = await sleeperGetRaw(`/league/${target.league_id}/${kind}`);
        // Sleeper answers 200 with a null body before the bracket is
        // generated (e.g. mid-season, no playoffs yet) — a real absence,
        // not a request failure, so this is reported rather than thrown.
        if (bracket === null) {
          console.log('  null — no bracket yet for this league/season');
        } else {
          console.log(`  matches: ${bracket.length}`);
          console.log(`  raw (first 1500 chars): ${JSON.stringify(bracket).slice(0, 1500)}`);
        }
      } catch (err) {
        console.log(`  threw — ${err.message}`);
      }
    }
  }
} else {
  console.log('\n(no PROBE_SLEEPER_LEAGUE_ID — skipping Sleeper)');
}

console.log('\n=== done ===');
