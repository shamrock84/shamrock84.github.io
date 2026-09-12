// Answers the question behind the Scoring tab's per-matchup detail drawer:
// what does each provider carry at the PLAYER level on the live-scoring
// response we already fetch, and in particular does it carry that player's
// own points so far this week?
//
// This is the field the drawer is entirely about. The three `players[]`
// arrays fetchScoring/fetchEspnScoring/fetchSleeperScoring already build
// exist only to feed the win-probability model, so each carries the bare
// minimum that model needs and nothing a human would want to read:
//   MFL     -> { id, secondsRemaining }          (no name, no points)
//   ESPN    -> { name, secondsRemaining }        (no points)
//   Sleeper -> { name, secondsRemaining }        (no points)
// The drawer needs name + position + points per starter. The bet worth
// checking before writing any parsing is that all three are already sitting
// in responses we pay for anyway — which would make the whole feature cost
// zero extra per-league requests:
//
//   MFL      liveScoring franchise.players.player[] — does the entry carry
//            a `score`? (`id`, `status` and `gameSecondsRemaining` are
//            already known present, see mflLiveStarters.) Names are NOT
//            here regardless and must come from TYPE=players, which is one
//            global request the sync already makes via loadPlayerMap.
//   ESPN     schedule[].home/away.rosterForCurrentScoringPeriod.entries[] —
//            does playerPoolEntry carry `appliedStatTotal`, and does
//            player carry `defaultPositionId`? Both are community-
//            documented but neither has ever been probed against a real
//            league of ours. lineupSlotId is known present but only
//            bench(20)/IR(21) are known values — this dumps the full set so
//            the slot->label question can be answered off real data rather
//            than a community table.
//   Sleeper  matchups/{week}[] — is there a `players_points` map, and does
//            `starters` order line up with the league's roster_positions?
//
// Deliberately prints raw JSON for one franchise/team per provider rather
// than a summary: the point is to see the actual key set, including keys
// this file did not think to ask about.
//
// ===================================================================
// RUN 1 — 2026-09-10, week 1, ~00:48 UTC. The only game underway was
// SEA-NE (Thursday night), so most points read 0 legitimately. Every
// open question came back answered:
//
//   MFL (league 26696)   `score` IS on every players.player entry.
//     Union of player-entry keys: gameSecondsRemaining, id, score,
//     status, updatedStats. All nine starters read score "0.0" — none
//     of them were in the SEA-NE game, so 0 here is the real answer
//     rather than a missing field. franchise.score 0.0 equalled the
//     sum of its starters.
//     NOTE, and it contradicts mflLiveStarters' inherited comment:
//     this response carried ONLY starters — nine entries, zero
//     nonstarters, on a dynasty roster that certainly has a bench. The
//     status filter is still correct either way (it just no longer
//     removes anything here), but "players.player carries the WHOLE
//     roster" should not be relied on without re-checking.
//
//   ESPN (league 421871710)   playerPoolEntry.appliedStatTotal IS
//     present, and live: Jaxon Smith-Njigba (SEA, the one game in
//     progress) read 4.1 while every player yet to kick off read 0.
//     player.defaultPositionId is present too.
//     REAL DISCREPANCY WORTH KNOWING: that side's own totalPoints was
//     0 at the same moment its starters summed to 4.10. ESPN's
//     matchup-level total lags its own per-player numbers, so the
//     drawer's column can legitimately not add up to the team score in
//     the pill above it for an ESPN league mid-game. Not something
//     this project can fix — both numbers are ESPN's.
//     lineupSlotId histogram on a real 15-entry side:
//       0:1 (QB)  2:2 (RB)  5:2 (WR)  16:1 (D/ST)  17:1 (K)
//       20:7 (bench)  23:1 (FLEX)
//     That confirms 20=bench, and gives real values for the rest for
//     the first time — but the drawer still groups by `position`, since
//     MFL supplies no slot at all and Sleeper's slots here were all
//     FLEX (see below), so slots could not align the two sides anyway.
//
//   Sleeper (league 1367867592919760896)   BOTH players_points and
//     starters_points are present, and `starters` is ordered against
//     roster_positions. This particular league's roster_positions are
//     8x FLEX + 2x SUPER_FLEX, which is its own argument for grouping
//     the drawer by position rather than by slot: every slot label here
//     would read "FLEX".
//
//   NFL scoreboard   competitions[0].date and status.type.shortDetail
//     both present. TWO CORRECTIONS TO EARLIER GUESSES:
//     * shortDetail for a live game is "4:35 - 1st", NOT "Q3 5:22".
//       (detail is the longer "4:35 - 1st Quarter".) It is used
//       verbatim, so nothing broke, but any comment or fixture written
//       against the old guess was wrong.
//     * the date has NO SECONDS — "2026-09-10T00:20Z". new Date()
//       parses that fine (verified), so no special handling is needed.
//     Every abbreviation published, all 32:
//       ARI ATL BAL BUF CAR CHI CIN CLE DAL DEN DET GB HOU IND JAX KC
//       LAC LAR LV MIA MIN NE NO NYG NYJ PHI PIT SEA SF TB TEN WSH
//     NFL_TEAM_ALIASES in providers.mjs is confirmed COMPLETE against
//     the codes real MFL roster data uses: GBP JAC KCC LVR NEP NOS SFO
//     TBB all need their short form, and MFL's WAS needs the
//     scoreboard's WSH — which this run did publish, so that alias is
//     load-bearing, not defensive. ARZ never appeared (the scoreboard
//     said ARI, same as MFL); that alias is unused but harmless.
// ===================================================================
//
// ===================================================================
// RUN 2 — added to answer a follow-up question: does the live-scoring
// response carry enough to show a player's STAT breakdown ("7.4 points
// for 74 Receiving Yards"), not just his total? MFL's per-player entry
// carries an `updatedStats` key (see RUN 1) that read as an empty string
// on every starter then, because no game was underway. This run targets
// a week whose games have actually finished so at least some players
// carry real content there, and additionally dumps TYPE=rules so any
// event code updatedStats uses can be decoded against the league's own
// point values — the same rules endpoint fetchMflReceptionPoints already
// reads for the "CC" event.
//
// Fill in results here after running.
// ===================================================================
//
// Read-only. Run from the Actions tab (probe-live-scoring-players.yml).
import {
  mflLogin,
  mflGet,
  seasonOf,
  espnGet,
  loadSleeperPlayerMap,
} from './lib/providers.mjs';

const mflText = (v) => (v && typeof v === 'object' ? v.$t : v);
const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

// Sleeper needs no auth at all, so this probe hits it with plain fetch the
// same way probe-espn-sleeper-live-time.mjs does, rather than widening
// providers.mjs's exports (its own sleeperGet is module-private) just for a
// read-only probe.
const SLEEPER_BASE = 'https://api.sleeper.app/v1';
async function sleeperGet(path) {
  const res = await fetch(`${SLEEPER_BASE}${path}`);
  if (!res.ok) throw new Error(`Sleeper request failed (${res.status}): ${path}`);
  return res.json();
}

const MFL_LEAGUE_ID = process.env.PROBE_MFL_LEAGUE_ID;
const ESPN_LEAGUE_ID = process.env.PROBE_ESPN_LEAGUE_ID;
const SLEEPER_LEAGUE_ID = process.env.PROBE_SLEEPER_LEAGUE_ID;
const WEEK = process.env.PROBE_WEEK || '1';

function keysOf(obj) {
  return obj && typeof obj === 'object' ? Object.keys(obj).sort().join(', ') : '(not an object)';
}

// --- MFL ---
if (MFL_LEAGUE_ID) {
  const league = { id: MFL_LEAGUE_ID };
  const year = seasonOf(league);
  console.log(`\n=== MFL league ${MFL_LEAGUE_ID}, season ${year}, week ${WEEK} ===\n`);
  try {
    const cookie = await mflLogin(process.env.MFL_USERNAME, process.env.MFL_PASSWORD);
    const liveData = await mflGet(`/export?TYPE=liveScoring&L=${MFL_LEAGUE_ID}&W=${WEEK}&JSON=1`, cookie, year);
    const rawMatchups = liveData?.liveScoring?.matchup;
    const matchupList = Array.isArray(rawMatchups) ? rawMatchups : rawMatchups ? [rawMatchups] : [];
    const first = matchupList[0];
    const franchises = Array.isArray(first?.franchise) ? first.franchise : first?.franchise ? [first.franchise] : [];
    const f = franchises[0];
    if (!f) {
      console.log('  no franchise in the first matchup — nothing to inspect');
    } else {
      console.log(`franchise-level keys: ${keysOf(f)}`);
      const raw = f.players?.player;
      const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
      console.log(`players.player entries: ${list.length}`);
      // THE question: is there a per-player score field, and what is it called?
      const unionKeys = new Set();
      for (const p of list) for (const k of Object.keys(p || {})) unionKeys.add(k);
      console.log(`union of ALL player-entry keys: ${[...unionKeys].sort().join(', ')}`);
      const starters = list.filter((p) => String(p.status).toLowerCase() === 'starter');
      console.log(`\nfirst 4 STARTER entries verbatim:`);
      console.log(JSON.stringify(starters.slice(0, 4), null, 2));
      console.log(`\nfirst 2 NONSTARTER entries verbatim (do they carry the same keys?):`);
      console.log(JSON.stringify(list.filter((p) => String(p.status).toLowerCase() !== 'starter').slice(0, 2), null, 2));
      // Does the franchise score equal the sum of its starters' scores? If so
      // the per-player number is the real thing, not a stale or partial value.
      const sum = starters.reduce((acc, p) => acc + Number(p.score ?? 0), 0);
      console.log(`\nfranchise.score = ${f.score}; sum of starters' own .score = ${sum.toFixed(2)}`);
    }

    // RUN 2: updatedStats read as '' on every starter in RUN 1 because no
    // game had started yet. Scan EVERY franchise in EVERY matchup this time
    // for a player who has actually scored, and print that entry's
    // updatedStats verbatim rather than the possibly-still-empty first
    // franchise's.
    console.log(`\n--- RUN 2: hunting across all matchups for a scored player's updatedStats ---`);
    const allPlayers = [];
    for (const m of matchupList) {
      const fs = Array.isArray(m.franchise) ? m.franchise : m.franchise ? [m.franchise] : [];
      for (const fr of fs) {
        const raw2 = fr.players?.player;
        const list2 = Array.isArray(raw2) ? raw2 : raw2 ? [raw2] : [];
        for (const p of list2) allPlayers.push({ franchiseId: fr.id, ...p });
      }
    }
    const scored = allPlayers.filter((p) => Number(p.score) > 0);
    console.log(`players with score > 0 across the whole league: ${scored.length} of ${allPlayers.length}`);
    console.log(`first 6 scored players, full entry, so updatedStats' real shape is visible:`);
    console.log(JSON.stringify(scored.slice(0, 6), null, 2));

    // TYPE=rules — the decoder ring for whatever event codes updatedStats
    // turns out to use, the same endpoint fetchMflReceptionPoints already
    // reads for the "CC" (reception) event.
    console.log(`\n--- TYPE=rules for league ${MFL_LEAGUE_ID}, season ${year} ---`);
    const rulesData = await mflGet(`/export?TYPE=rules&L=${MFL_LEAGUE_ID}&JSON=1`, cookie, year);
    for (const group of asArray(rulesData?.rules?.positionRules)) {
      const positions = mflText(group?.positions);
      console.log(`positions: ${positions}`);
      for (const rule of asArray(group?.rule)) {
        console.log(`  event=${mflText(rule?.event)}  points=${mflText(rule?.points)}  range=${JSON.stringify(rule?.range) || '(none)'}`);
      }
    }
  } catch (err) {
    console.log(`  MFL probe failed: ${err.message}`);
  }
} else {
  console.log('\n=== MFL skipped (no PROBE_MFL_LEAGUE_ID) ===');
}

// --- ESPN ---
if (ESPN_LEAGUE_ID) {
  console.log(`\n\n=== ESPN league ${ESPN_LEAGUE_ID}, week ${WEEK} ===\n`);
  try {
    const league = { id: ESPN_LEAGUE_ID, provider: 'espn' };
    const data = await espnGet(league, 'view=mScoreboard&view=mTeam&view=mRoster');
    const currentPeriod = data.status?.currentMatchupPeriod;
    console.log(`currentMatchupPeriod: ${currentPeriod}`);
    const m = (data.schedule || []).filter((s) => s.matchupPeriodId === currentPeriod)[0];
    const side = m?.home || m?.away;
    const entries = side?.rosterForCurrentScoringPeriod?.entries || [];
    console.log(`entries on the first side: ${entries.length}`);
    // Every lineupSlotId actually in use, with how many entries sit in each —
    // the input to a real slot->label map (only 20/bench and 21/IR are known).
    const slotCounts = new Map();
    for (const e of entries) slotCounts.set(e.lineupSlotId, (slotCounts.get(e.lineupSlotId) || 0) + 1);
    console.log(`lineupSlotId -> count: ${[...slotCounts.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join(', ')}`);
    const e0 = entries[0];
    console.log(`\nentry-level keys: ${keysOf(e0)}`);
    console.log(`playerPoolEntry keys: ${keysOf(e0?.playerPoolEntry)}`);
    console.log(`playerPoolEntry.player keys: ${keysOf(e0?.playerPoolEntry?.player)}`);
    console.log(`\nfirst 3 entries, trimmed to the fields the drawer wants:`);
    console.log(JSON.stringify(entries.slice(0, 3).map((e) => ({
      lineupSlotId: e.lineupSlotId,
      // The candidate points fields, all of them, so the real one is obvious.
      'playerPoolEntry.appliedStatTotal': e.playerPoolEntry?.appliedStatTotal,
      'entry.appliedStatTotal': e.appliedStatTotal,
      fullName: e.playerPoolEntry?.player?.fullName,
      defaultPositionId: e.playerPoolEntry?.player?.defaultPositionId,
      proTeamId: e.playerPoolEntry?.player?.proTeamId,
      injuryStatus: e.playerPoolEntry?.player?.injuryStatus,
    })), null, 2));
    console.log(`\nside.totalPoints = ${side?.totalPoints}; sum of non-bench/IR appliedStatTotal = ${
      entries
        .filter((e) => e.lineupSlotId !== 20 && e.lineupSlotId !== 21)
        .reduce((acc, e) => acc + Number(e.playerPoolEntry?.appliedStatTotal ?? 0), 0)
        .toFixed(2)
    }`);

    // RUN 2: does this response carry a per-CATEGORY breakdown (raw stat id
    // -> value, and points per stat id), or only the single appliedStatTotal
    // number? Search every side's entries — not just the first — for a
    // player who has actually scored, and dump that stat entry's full shape.
    // fetchEspnLeagueRoster already reads player.stats[] filtered to
    // statSourceId 0 / statSplitTypeId 0 (season-to-date) for `appliedTotal`
    // only; this looks for whether the SAME array (or a live-scoped sibling)
    // carries the individual `stats` (raw) and `appliedStats` (points per
    // stat id) maps this drawer would need.
    console.log(`\n--- RUN 2: hunting for a scored player's per-category stats ---`);
    const allSides = (data.schedule || []).filter((m) => m.matchupPeriodId === currentPeriod)
      .flatMap((m) => [m.home, m.away].filter(Boolean));
    const allEntries = allSides.flatMap((s) => s?.rosterForCurrentScoringPeriod?.entries || []);
    const scoredEntries = allEntries.filter((e) => Number(e.playerPoolEntry?.appliedStatTotal) > 0);
    console.log(`entries with appliedStatTotal > 0: ${scoredEntries.length} of ${allEntries.length}`);
    console.log(`first 3, with the player's FULL stats[] array (not just the season-total filter fetchEspnLeagueRoster applies):`);
    console.log(JSON.stringify(scoredEntries.slice(0, 3).map((e) => ({
      name: e.playerPoolEntry?.player?.fullName,
      appliedStatTotal: e.playerPoolEntry?.appliedStatTotal,
      statsArray: e.playerPoolEntry?.player?.stats,
    })), null, 2));
  } catch (err) {
    console.log(`  ESPN probe failed: ${err.message}`);
  }
} else {
  console.log('\n\n=== ESPN skipped (no PROBE_ESPN_LEAGUE_ID) ===');
}

// --- Sleeper ---
if (SLEEPER_LEAGUE_ID) {
  console.log(`\n\n=== Sleeper league ${SLEEPER_LEAGUE_ID}, week ${WEEK} ===\n`);
  try {
    const leagueData = await sleeperGet(`/league/${SLEEPER_LEAGUE_ID}`);
    console.log(`roster_positions: ${JSON.stringify(leagueData?.roster_positions)}`);
    const matchups = await sleeperGet(`/league/${SLEEPER_LEAGUE_ID}/matchups/${WEEK}`);
    const m = (matchups || [])[0];
    if (!m) {
      console.log('  no matchup entries returned');
    } else {
      console.log(`matchup-entry keys: ${keysOf(m)}`);
      console.log(`starters: ${JSON.stringify(m.starters)}`);
      // The bet: a per-player points map keyed by the same ids `starters` holds.
      console.log(`players_points present: ${m.players_points ? 'YES' : 'no'}`);
      console.log(`starters_points present: ${m.starters_points ? 'YES' : 'no'}`);
      if (m.players_points) {
        console.log(`starters' own points, in starters[] order:`);
        const playerMap = await loadSleeperPlayerMap();
        m.starters.forEach((id, i) => {
          const info = playerMap.get(String(id));
          console.log(`  slot ${i} (${leagueData?.roster_positions?.[i] ?? '?'}): ${id} ${info?.name ?? '(unresolved)'} ${info?.position ?? ''} ${info?.team ?? ''} -> ${m.players_points[String(id)]}`);
        });
      }
      console.log(`\nm.points = ${m.points}; sum of starters' players_points = ${
        (m.starters || []).reduce((acc, id) => acc + Number(m.players_points?.[String(id)] ?? 0), 0).toFixed(2)
      }`);

      // RUN 2: players_points/starters_points give only the FINAL number per
      // player, same as MFL's franchise-level score. Sleeper separately
      // publishes a public per-player raw-stat-category endpoint
      // (undocumented; community-referenced as /stats/nfl/<season_type>/
      // <season>/<week>) — this checks whether it's real, and whether it
      // carries the receiving-yards/receptions-shaped categories the drawer
      // would need, for the same players just listed above.
      console.log(`\n--- RUN 2: probing Sleeper's public per-player weekly stats endpoint ---`);
      try {
        const statsRes = await fetch(`${SLEEPER_BASE}/stats/nfl/regular/${leagueData?.season}/${WEEK}`);
        console.log(`GET /stats/nfl/regular/${leagueData?.season}/${WEEK} -> ${statsRes.status}`);
        if (statsRes.ok) {
          const statsData = await statsRes.json();
          const starterId = (m.starters || []).find((id) => Number(m.players_points?.[String(id)]) > 0);
          console.log(`response shape: ${Array.isArray(statsData) ? 'array' : typeof statsData}, keyed by player id: ${statsData && typeof statsData === 'object' && !Array.isArray(statsData) ? 'yes' : 'no'}`);
          if (starterId && statsData?.[String(starterId)]) {
            console.log(`stat categories for scored starter ${starterId}:`);
            console.log(JSON.stringify(statsData[String(starterId)], null, 2));
          } else {
            console.log(`no scored starter found, or that id isn't a key in the response. Sample of 1 entry:`);
            const sampleKey = Object.keys(statsData || {})[0];
            console.log(sampleKey ? JSON.stringify({ [sampleKey]: statsData[sampleKey] }, null, 2) : '(empty response)');
          }
        } else {
          console.log(`  non-OK status, body: ${(await statsRes.text()).slice(0, 300)}`);
        }
      } catch (err) {
        console.log(`  Sleeper stats-endpoint probe failed: ${err.message}`);
      }
    }
  } catch (err) {
    console.log(`  Sleeper probe failed: ${err.message}`);
  }
} else {
  console.log('\n\n=== Sleeper skipped (no PROBE_SLEEPER_LEAGUE_ID) ===');
}

// --- The NFL scoreboard's own schedule fields ---
//
// The drawer's "@PIT Sun 12:00 PM" line joins each starter to their NFL game
// by team abbreviation, off this same public scoreboard fetchNflGameClocks
// already reads. Two things need confirming against it, and neither is
// visible from a sandbox (the scoreboard host is unreachable there):
//
//   1. The exact abbreviation each team is published under. This is the join
//      key, and three providers spell teams differently — MFL pads to three
//      letters (LVR/GBP/KCC/NEP/NOS/SFO/TBB/JAC) where the scoreboard uses
//      the short forms. NFL_TEAM_ALIASES in providers.mjs covers the ones
//      seen in real roster data; anything printed below that is NOT in the
//      alias table and NOT already a provider's own spelling is a team whose
//      players would silently get no game line.
//   2. That `competitions[0].date` and `status.type.shortDetail` are really
//      there, since the line falls back to nothing without them.
console.log('\n\n=== NFL scoreboard (public, unauthenticated) ===\n');
try {
  const res = await fetch('https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard');
  if (!res.ok) throw new Error(`scoreboard request failed (${res.status})`);
  const data = await res.json();
  console.log(`events: ${(data.events || []).length}`);
  const abbrs = [];
  for (const event of data.events || []) {
    const competition = event.competitions?.[0];
    const status = competition?.status;
    const competitors = competition?.competitors || [];
    for (const c of competitors) if (c.team?.abbreviation) abbrs.push(c.team.abbreviation);
    if (event === data.events[0]) {
      console.log(`\nfirst event, the fields the game line reads:`);
      console.log(JSON.stringify({
        'competitions[0].date': competition?.date,
        'event.date': event.date,
        'status.type.state': status?.type?.state,
        'status.type.shortDetail': status?.type?.shortDetail,
        'status.type.detail': status?.type?.detail,
        'status.period': status?.period,
        'status.clock': status?.clock,
        competitors: competitors.map((c) => ({
          abbreviation: c.team?.abbreviation,
          homeAway: c.homeAway,
        })),
      }, null, 2));
      console.log(`\nfull status block of that event:`);
      console.log(JSON.stringify(status, null, 2));
    }
  }
  console.log(`\nEVERY abbreviation this scoreboard published, sorted — these are the join keys:`);
  console.log([...new Set(abbrs)].sort().join(' '));
  // The teams whose players come from MFL under a different spelling. Any of
  // these NOT handled by NFL_TEAM_ALIASES is a silent gap.
  console.log(`\nMFL spells these differently — confirm each is aliased:`);
  console.log('  MFL: GBP JAC KCC LVR NEP NOS SFO TBB   scoreboard should say: GB JAX KC LV NE NO SF TB');
  console.log(`  Washington/Arizona are the two the scoreboard itself has been inconsistent on — it published: ${
    [...new Set(abbrs)].filter((a) => /^(WAS|WSH|ARI|ARZ)$/.test(a)).join(' ') || '(neither this week)'
  }`);
} catch (err) {
  console.log(`  scoreboard probe failed: ${err.message}`);
}

console.log('\nDone.');

// RUN 3 — added after RUN 2 found MFL's liveScoring updatedStats field
// reads '' on every player regardless of score (confirmed against 8 real
// scored players, 1.0 to 15.5 points, week 1 2026). Before concluding MFL
// has no stat-breakdown source at all, check the one other MFL endpoint
// this project already calls that carries player-level data for a week —
// TYPE=weeklyResults, which fetchMflWeekScores/fetchMflLineup already read
// for `status`/`score` only. Does its player entry carry anything else?
if (MFL_LEAGUE_ID) {
  console.log(`\n\n=== RUN 3: MFL TYPE=weeklyResults player-entry shape, league ${MFL_LEAGUE_ID} week ${WEEK} ===\n`);
  try {
    const cookie = await mflLogin(process.env.MFL_USERNAME, process.env.MFL_PASSWORD);
    const year = seasonOf({ id: MFL_LEAGUE_ID });
    const weeklyData = await mflGet(`/export?TYPE=weeklyResults&L=${MFL_LEAGUE_ID}&W=${WEEK}&JSON=1`, cookie, year);
    const matchups = weeklyData?.weeklyResults?.matchup;
    const matchupList = Array.isArray(matchups) ? matchups : matchups ? [matchups] : [];
    const allPlayers = [];
    for (const m of matchupList) {
      const franchises = Array.isArray(m.franchise) ? m.franchise : m.franchise ? [m.franchise] : [];
      for (const f of franchises) {
        const players = Array.isArray(f.player) ? f.player : f.player ? [f.player] : [];
        for (const p of players) allPlayers.push(p);
      }
    }
    const unionKeys = new Set();
    for (const p of allPlayers) for (const k of Object.keys(p || {})) unionKeys.add(k);
    console.log(`union of ALL weeklyResults player-entry keys: ${[...unionKeys].sort().join(', ')}`);
    const scored = allPlayers.filter((p) => Number(p.score) > 0);
    console.log(`players with score > 0: ${scored.length} of ${allPlayers.length}`);
    console.log(`first 4 scored entries verbatim:`);
    console.log(JSON.stringify(scored.slice(0, 4), null, 2));
  } catch (err) {
    console.log(`  RUN 3 probe failed: ${err.message}`);
  }
} else {
  console.log('\n\n=== RUN 3 skipped (no PROBE_MFL_LEAGUE_ID) ===');
}

// RUN 4 — added after the project's manager found MFL's own Developers
// Program PDFs (General Info + Request Reference), which settle a question
// RUN 2/3 could only leave open by absence: General Info's Terms of
// Service, item 7, states MFL "can not and will not under any circumstance
// make raw NFL player stats available, as that's forbidden per our stats
// licensing agreement." That's a categorical answer for a RAW stat count
// ("74 receiving yards") — no endpoint will ever carry that. But the
// Request Reference lists TYPE=playerScores with a RULES=1 argument
// ("re-calculates the fantasy score for each player according to that
// league's rules") — a previously-untried endpoint. If it exposes a
// PER-RULE POINT total (not the raw stat, just "12.0 points from this
// scoring rule"), that's MFL's own derived number, not the licensed raw
// stat, and could power a breakdown phrased as "Passing Touchdowns: 12.0
// pts" without a raw count. This run checks that, and also pulls
// TYPE=allRules — the authoritative event-code -> description decoder
// (rather than the community-documented guesses fetchMflReceptionPoints'
// own "CC" comment already flagged as unconfirmed for anything but
// receptions).
//
// RESULTS — 2026-09-12, week 1, league 26696, real data:
//   playerScores&RULES=1  Entries carry ONLY {id, isAvailable, score,
//     week} — 45 of 62 scored, e.g. {id:"16185", score:"26.2"}. NO
//     per-rule breakdown of any kind, just the one recalculated total —
//     the same shape as weeklyResults' score, from a different call.
//     This closes off the one remaining hope for an MFL-side breakdown:
//     liveScoring (updatedStats), weeklyResults, and playerScores&RULES=1
//     have now ALL been checked, and none carries anything between "the
//     final score" and the raw stats item 7 forbids outright. There is
//     no fourth call left to try in the Request Reference that plausibly
//     carries this.
//   allRules  Real and rich — confirmed abbreviation/shortDescription/
//     detailedDescription triples for every rule, e.g. PY="Passing
//     Yards", #P="Number of Passing TDs", IN="Pass Interceptions
//     Thrown", TSK="QB Sacked". This is the authoritative decoder for
//     TYPE=rules' event codes (upgrading fetchMflReceptionPoints' own
//     "CC is the reception event" comment from behavior-inferred to
//     documented) — useful for describing a league's SCORING RULES in
//     the abstract, but it has nothing to say about what any player did
//     in any given week, so it cannot feed a per-player breakdown either.
// CONCLUSION: MFL cannot support the Scoring tab's stat-breakdown
// popover through any documented, triable endpoint. See mfl/README.md
// for the full writeup (the actual PDFs live there too).
if (MFL_LEAGUE_ID) {
  console.log(`\n\n=== RUN 4: MFL TYPE=playerScores&RULES=1, league ${MFL_LEAGUE_ID} week ${WEEK} ===\n`);
  try {
    const cookie = await mflLogin(process.env.MFL_USERNAME, process.env.MFL_PASSWORD);
    const year = seasonOf({ id: MFL_LEAGUE_ID });
    const data = await mflGet(
      `/export?TYPE=playerScores&L=${MFL_LEAGUE_ID}&W=${WEEK}&RULES=1&JSON=1`,
      cookie,
      year
    );
    const raw = data?.playerScores?.playerScore;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    console.log(`playerScore entries: ${list.length}`);
    const unionKeys = new Set();
    for (const p of list) for (const k of Object.keys(p || {})) unionKeys.add(k);
    console.log(`union of ALL playerScore keys: ${[...unionKeys].sort().join(', ')}`);
    const scored = list.filter((p) => Number(p.score) > 0);
    console.log(`entries with score > 0: ${scored.length} of ${list.length}`);
    console.log(`first 5 scored entries verbatim:`);
    console.log(JSON.stringify(scored.slice(0, 5), null, 2));
  } catch (err) {
    console.log(`  RUN 4 playerScores probe failed: ${err.message}`);
  }

  console.log(`\n\n=== RUN 4: MFL TYPE=allRules, league ${MFL_LEAGUE_ID} ===\n`);
  try {
    const cookie = await mflLogin(process.env.MFL_USERNAME, process.env.MFL_PASSWORD);
    const year = seasonOf({ id: MFL_LEAGUE_ID });
    const data = await mflGet(`/export?TYPE=allRules&JSON=1`, cookie, year);
    const raw = data?.allRules?.positionRules;
    console.log(`shape: ${JSON.stringify(Object.keys(data?.allRules || {}))}`);
    console.log(JSON.stringify(data?.allRules, null, 2).slice(0, 6000));
  } catch (err) {
    console.log(`  RUN 4 allRules probe failed: ${err.message}`);
  }
} else {
  console.log('\n\n=== RUN 4 skipped (no PROBE_MFL_LEAGUE_ID) ===');
}
