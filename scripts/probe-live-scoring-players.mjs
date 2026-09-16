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
// ===================================================================
// RUN 3 — 2026-09-13, week 1, live Sunday slate, ~00:48 UTC. Added after
// fetchEspnScoring switched from trusting schedule[].home/away.totalPoints
// (confirmed on 2026-09-12 to sit flat at 0 for hours while several
// starters' games had already gone final — a batched figure, not a live
// one) to summing each starter's own appliedStatTotal instead. Question:
// does ESPN expose a genuinely live team total field, and where?
//
// CONFIRMED: totalPointsLive exists, and lives on the SIDE object
// (home/away), not the matchup — matchup-level keys carried no such field
// (`away, home, id, matchupPeriodId, winner` only), while each side's own
// keys included `totalPointsLive` and `totalProjectedPointsLive` right
// alongside the stale `totalPoints`. Real numbers from this run:
//   home.totalPoints = 0        (the stale/batched field — confirms RUN 1's
//                                 finding again, worse: hours in, not seconds)
//   home.totalPointsLive = 26.2
//   sum of non-bench/IR appliedStatTotal for the same side = 26.20
//   home.totalProjectedPointsLive = 126.98949738  (full-week projection,
//                                 not a candidate for the live score)
//   away.totalPoints = 0; away.totalPointsLive = 18
// totalPointsLive matched the summed total exactly, so fetchEspnScoring now
// reads totalPointsLive as the primary source (it's ESPN's own number, so it
// would also carry a team-level manual scoring adjustment a pure sum can't
// see) and keeps the sum only as a fallback for a response that omits it.
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

// Standalone re-implementations of two functions this project tried,
// shipped, and deliberately removed from providers.mjs (see mfl/README.md's
// DETAILS=1 bullet and mflPlayerEntry's own comment for why) — kept here,
// not imported, so RUN 8/RUN 10 below can still be re-run to confirm
// playerScores&RULES=1 stays unreliable, without that dead approach having
// to remain live production code just to stay probeable.
async function probeMflRosterIdsByFranchise(league, cookie) {
  const data = await mflGet(`/export?TYPE=rosters&L=${league.id}&JSON=1`, cookie, seasonOf(league));
  const rawFranchises = Array.isArray(data?.rosters?.franchise)
    ? data.rosters.franchise
    : data?.rosters?.franchise
    ? [data.rosters.franchise]
    : [];
  const byFranchise = new Map();
  for (const f of rawFranchises) {
    const rawPlayers = f?.player;
    const players = Array.isArray(rawPlayers) ? rawPlayers : rawPlayers ? [rawPlayers] : [];
    byFranchise.set(String(f.id), players.map((p) => String(p.id)));
  }
  return byFranchise;
}

async function probeMflWeekPlayerScores(league, week, cookie) {
  const data = await mflGet(
    `/export?TYPE=playerScores&L=${league.id}&W=${week}&RULES=1&JSON=1`,
    cookie,
    seasonOf(league)
  );
  const raw = data?.playerScores?.playerScore;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const scores = new Map();
  for (const p of list) {
    if (p?.id == null || p.score == null || p.score === '') continue;
    scores.set(String(p.id), Number(p.score));
  }
  return scores;
}

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
    const summedScore = entries
      .filter((e) => e.lineupSlotId !== 20 && e.lineupSlotId !== 21)
      .reduce((acc, e) => acc + Number(e.playerPoolEntry?.appliedStatTotal ?? 0), 0);
    console.log(`\nside.totalPoints = ${side?.totalPoints}; sum of non-bench/IR appliedStatTotal = ${summedScore.toFixed(2)}`);

    // RUN 3: does either the matchup object or the side itself carry a
    // totalPointsLive (or totalProjectedPointsLive)? Dumped for BOTH sides,
    // and both matchup-level and side-level keys, since community docs
    // disagree on where a live total would live and neither has been
    // checked against a real league here.
    console.log(`\n--- RUN 3: hunting for totalPointsLive ---`);
    console.log(`matchup-level keys: ${keysOf(m)}`);
    console.log(`home-side keys: ${keysOf(m?.home)}`);
    console.log(`away-side keys: ${keysOf(m?.away)}`);
    console.log(`matchup.totalPointsLive = ${m?.totalPointsLive}; matchup.totalProjectedPointsLive = ${m?.totalProjectedPointsLive}`);
    console.log(`home.totalPoints = ${m?.home?.totalPoints}; home.totalPointsLive = ${m?.home?.totalPointsLive}; home.totalProjectedPointsLive = ${m?.home?.totalProjectedPointsLive}`);
    console.log(`away.totalPoints = ${m?.away?.totalPoints}; away.totalPointsLive = ${m?.away?.totalPointsLive}; away.totalProjectedPointsLive = ${m?.away?.totalProjectedPointsLive}`);
    console.log(`(for comparison) summed non-bench/IR appliedStatTotal for the side dumped above = ${summedScore.toFixed(2)}`);

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

// RUN 5 — added to answer a follow-up idea: could ESPN's PUBLIC (non-
// fantasy) NFL data supply the raw stats MFL's own API is contractually
// forbidden from exposing (see mfl/README.md), so this project computes
// its own MFL-scoring-rule breakdown independently rather than reading
// one from MFL? That would need a per-player BOXSCORE endpoint — the
// scoreboard fetchNflGames already reads has no per-player stats at all,
// only game/team state. ESPN's site API commonly exposes a richer
// `/summary?event=<id>` for each game; this checks whether that's real,
// unauthenticated, and has individual player stat lines (not just team
// score), against a real FINISHED game.
console.log('\n\n=== RUN 5: does ESPN\'s public site API have a per-game player boxscore? ===\n');
try {
  const res = await fetch('https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard');
  const data = await res.json();
  const finished = (data.events || []).find((e) => e.competitions?.[0]?.status?.type?.state === 'post');
  if (!finished) {
    console.log('  no finished game in this week\'s scoreboard to test against');
  } else {
    console.log(`testing against event id ${finished.id} (${finished.shortName || finished.name})`);
    const sres = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${finished.id}`);
    console.log(`GET /summary?event=${finished.id} -> ${sres.status}`);
    if (sres.ok) {
      const sdata = await sres.json();
      console.log(`top-level keys: ${Object.keys(sdata).sort().join(', ')}`);
      const boxscore = sdata.boxscore;
      console.log(`boxscore present: ${!!boxscore}; boxscore keys: ${boxscore ? Object.keys(boxscore).join(', ') : '(none)'}`);
      const playersBlock = boxscore?.players;
      console.log(`boxscore.players present: ${!!playersBlock}; length: ${Array.isArray(playersBlock) ? playersBlock.length : 'n/a'}`);
      if (Array.isArray(playersBlock) && playersBlock[0]) {
        const team0 = playersBlock[0];
        console.log(`\nfirst team block keys: ${Object.keys(team0).join(', ')}`);
        console.log(`statistics categories: ${(team0.statistics || []).map((s) => s.name).join(', ')}`);
        const firstCat = team0.statistics?.[0];
        console.log(`\nfirst category ("${firstCat?.name}") full shape:`);
        console.log(JSON.stringify(firstCat, null, 2).slice(0, 3000));
      }
    } else {
      console.log(`  non-OK, body: ${(await sres.text()).slice(0, 300)}`);
    }
  }
} catch (err) {
  console.log(`  RUN 5 probe failed: ${err.message}`);
}

// RUN 6 — added immediately after RUN 5 confirmed the boxscore endpoint is
// real. RUN 5 only dumped the "passing" category's key/label shape; before
// writing any ESPN-boxscore -> MFL-event-code join, confirm the rushing/
// receiving/interceptions category key names too (the point of this
// project's whole verify-first convention — a guessed key name here would
// silently mislabel a stat rather than error). Also prints a defensive
// player's "interceptions" category to make sure it's a DIFFERENT shape
// from passing's own "interceptions" key (INTs thrown vs INTs caught) —
// a real collision risk once both get joined against MFL's IN vs IC event
// codes.
console.log('\n\n=== RUN 6: ESPN boxscore rushing/receiving/defensive category shapes ===\n');
try {
  const res = await fetch('https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard');
  const data = await res.json();
  const finished = (data.events || []).find((e) => e.competitions?.[0]?.status?.type?.state === 'post');
  if (!finished) {
    console.log('  no finished game to test against');
  } else {
    const sres = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${finished.id}`);
    const sdata = await sres.json();
    const teams = sdata.boxscore?.players || [];
    for (const team of teams) {
      for (const catName of ['rushing', 'receiving', 'interceptions', 'defensive']) {
        const cat = (team.statistics || []).find((s) => s.name === catName);
        if (!cat) continue;
        console.log(`\n--- ${team.team?.abbreviation} / ${catName} ---`);
        console.log(`keys: ${JSON.stringify(cat.keys)}`);
        console.log(`labels: ${JSON.stringify(cat.labels)}`);
        const withStats = (cat.athletes || []).find((a) => (a.stats || []).some((s) => Number(s) > 0));
        if (withStats) {
          console.log(`sample athlete: ${withStats.athlete?.displayName} -> ${JSON.stringify(withStats.stats)}`);
        }
      }
    }
  }
} catch (err) {
  console.log(`  RUN 6 probe failed: ${err.message}`);
}

// RUN 7 — RUN 4's allRules dump was truncated (this project's own
// .slice(0, 6000)) before reaching the rushing/receiving codes needed to
// label an MFL-side stat breakdown built from ESPN's public boxscore (see
// RUN 5/6). Filters the same allRules response down to exactly the codes
// this feature cares about, rather than guessing their wording by analogy
// to the confirmed passing ones (#P/PY/IN).
if (MFL_LEAGUE_ID) {
  console.log(`\n\n=== RUN 7: allRules, filtered to RY/#R/CY/#C/CC ===\n`);
  try {
    const cookie = await mflLogin(process.env.MFL_USERNAME, process.env.MFL_PASSWORD);
    const year = seasonOf({ id: MFL_LEAGUE_ID });
    const data = await mflGet(`/export?TYPE=allRules&JSON=1`, cookie, year);
    const rules = asArray(data?.allRules?.rule);
    const wanted = new Set(['RY', '#R', 'CY', '#C', 'CC', 'R2', 'C2']);
    for (const r of rules) {
      const abbr = mflText(r.abbreviation);
      if (!wanted.has(abbr)) continue;
      console.log(`${abbr}: short="${mflText(r.shortDescription)}" detailed="${mflText(r.detailedDescription)}"`);
    }
  } catch (err) {
    console.log(`  RUN 7 probe failed: ${err.message}`);
  }
}

// RUN 8 — diagnosing the "Bugs" task "Bench scoring not working. Showing no
// scores." The shipped bench drawer (mflBenchFromRoster) gets an MFL bench
// player's points from TYPE=playerScores&RULES=1 (fetchMflWeekPlayerScores),
// joined against TYPE=rosters (fetchMflLeagueRosterIds) for who's even on
// the roster. mfl/README.md's own "Other things confirmed from the Request
// Reference" section already flags that TYPE=liveScoring itself takes a
// DETAILS=1 argument returning nonstarters too — never tried against real
// data. This run checks two things: does DETAILS=1 actually add nonstarter
// entries with a real `score`, and does playerScores&RULES=1 (the field
// currently feeding the bench drawer) cover the same players at all, or is
// it silently thinner than the roster it's joined against?
if (MFL_LEAGUE_ID) {
  console.log(`\n\n=== RUN 8: TYPE=liveScoring&DETAILS=1 vs playerScores&RULES=1, league ${MFL_LEAGUE_ID} week ${WEEK} ===\n`);
  try {
    const cookie = await mflLogin(process.env.MFL_USERNAME, process.env.MFL_PASSWORD);
    const year = seasonOf({ id: MFL_LEAGUE_ID });
    const league = { id: MFL_LEAGUE_ID };

    const liveData = await mflGet(`/export?TYPE=liveScoring&L=${MFL_LEAGUE_ID}&W=${WEEK}&DETAILS=1&JSON=1`, cookie, year);
    const rawMatchups = liveData?.liveScoring?.matchup;
    const matchupList = Array.isArray(rawMatchups) ? rawMatchups : rawMatchups ? [rawMatchups] : [];

    const allEntries = [];
    for (const m of matchupList) {
      const fs = Array.isArray(m.franchise) ? m.franchise : m.franchise ? [m.franchise] : [];
      for (const fr of fs) {
        const raw = fr.players?.player;
        const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
        for (const p of list) allEntries.push({ franchiseId: fr.id, ...p });
      }
    }
    const starterEntries = allEntries.filter((p) => String(p.status).toLowerCase() === 'starter');
    const nonstarterEntries = allEntries.filter((p) => String(p.status).toLowerCase() !== 'starter');
    console.log(`With DETAILS=1: ${allEntries.length} total entries, ${starterEntries.length} starter, ${nonstarterEntries.length} nonstarter`);
    console.log(`union of nonstarter statuses: ${[...new Set(nonstarterEntries.map((p) => p.status))].join(', ') || '(none)'}`);
    console.log(`union of ALL nonstarter-entry keys: ${[...new Set(nonstarterEntries.flatMap((p) => Object.keys(p)))].sort().join(', ')}`);
    const nonstarterScored = nonstarterEntries.filter((p) => p.score != null && p.score !== '');
    console.log(`nonstarter entries carrying a non-null score: ${nonstarterScored.length} of ${nonstarterEntries.length}`);
    console.log(`first 5 nonstarter entries verbatim:`);
    console.log(JSON.stringify(nonstarterEntries.slice(0, 5), null, 2));

    const rosterIdsByFranchise = await probeMflRosterIdsByFranchise(league, cookie);
    let totalRosterSize = 0;
    for (const ids of rosterIdsByFranchise.values()) totalRosterSize += ids.length;
    console.log(`\nTYPE=rosters: ${rosterIdsByFranchise.size} franchises, ${totalRosterSize} rostered players total`);

    const weekScores = await probeMflWeekPlayerScores(league, WEEK, cookie);
    console.log(`TYPE=playerScores&RULES=1: ${weekScores.size} players carry a score league-wide (not scoped to this league's own roster)`);
    let rosteredWithWeekScore = 0;
    for (const ids of rosterIdsByFranchise.values()) {
      for (const id of ids) if (weekScores.has(String(id))) rosteredWithWeekScore++;
    }
    console.log(`Of this league's ${totalRosterSize} rostered players, ${rosteredWithWeekScore} have an entry in playerScores&RULES=1`);

    const liveNonstarterById = new Map(nonstarterEntries.map((p) => [String(p.id), p]));
    let rosteredWithLiveNonstarterScore = 0;
    for (const ids of rosterIdsByFranchise.values()) {
      for (const id of ids) {
        const entry = liveNonstarterById.get(String(id));
        if (entry && entry.score != null && entry.score !== '') rosteredWithLiveNonstarterScore++;
      }
    }
    console.log(`Of the same ${totalRosterSize} rostered players, ${rosteredWithLiveNonstarterScore} have a scored entry in liveScoring&DETAILS=1's nonstarter list`);
  } catch (err) {
    console.log(`  RUN 8 probe failed: ${err.message}`);
  }
} else {
  console.log('\n\n=== RUN 8 skipped (no PROBE_MFL_LEAGUE_ID) ===');
}

// RUN 9 — RUN 8 confirmed the DATA exists (playerScores&RULES=1 covers 248
// of 283 rostered players, liveScoring&DETAILS=1's nonstarter list covers
// 148 of 283 with a live score every time). Neither of those numbers is
// zero, so if the shipped drawer is really showing NO scores at all, the
// break has to be somewhere between that data and what api/live-scoring.js
// actually serves — hits the deployed endpoint directly, the same way the
// page's own refreshLiveScoring() does, and prints this league's own bench
// array verbatim. (At the time this ran, the endpoint still gated MFL bench
// behind a now-removed &benchLeagues= query param — see mflPlayerEntry's
// own comment in providers.mjs; a re-run today needs no such param at all.)
if (MFL_LEAGUE_ID) {
  console.log(`\n\n=== RUN 9: the deployed api/live-scoring.js endpoint itself, league ${MFL_LEAGUE_ID} ===\n`);
  try {
    const url = `https://shamrock84-github-io.vercel.app/api/live-scoring?t=${Date.now()}`;
    console.log(`GET ${url}`);
    const res = await fetch(url);
    console.log(`-> HTTP ${res.status}`);
    const body = await res.json();
    const league = (body.leagues || []).find((l) => String(l.id) === String(MFL_LEAGUE_ID));
    if (!league) {
      console.log(`league ${MFL_LEAGUE_ID} not found in response; all league ids returned: ${(body.leagues || []).map((l) => l.id).join(', ')}`);
    } else {
      console.log(`league ${MFL_LEAGUE_ID}: scoringError = ${league.scoringError}`);
      const teams = league.scoring?.teams || [];
      for (const t of teams) {
        console.log(`  team ${t.franchiseId} (${t.teamName}): score=${t.score}, players=${(t.players || []).length}, bench=${(t.bench || []).length}`);
      }
      const withBench = teams.find((t) => (t.bench || []).length);
      if (withBench) {
        console.log(`\nfirst team with a nonempty bench (${withBench.franchiseId}), full bench array:`);
        console.log(JSON.stringify(withBench.bench, null, 2));
      } else {
        console.log('\nEVERY team on this league came back with an EMPTY bench array.');
      }
    }
  } catch (err) {
    console.log(`  RUN 9 probe failed: ${err.message}`);
  }
} else {
  console.log('\n\n=== RUN 9 skipped (no PROBE_MFL_LEAGUE_ID) ===');
}

// RUN 10 — RUN 9's fix (query playerScores for live.week, not a separately-
// resolved week) shipped, but the manager reports bench players STILL
// showing wrong scores: not null this time, but a CONFIDENT 0.00 that
// disagrees with the independently-computed (from ESPN's boxscore) stat
// breakdown sitting right next to it — e.g. a player the breakdown credits
// with real rushing yards still reads 0.00 for bench points. That points at
// playerScores&RULES=1 itself being unreliable/stale for some players
// (bench ids especially) even for a week whose games are Final, which
// liveScoring&DETAILS=1 (the SAME source starters already trust) might not
// share, since RUN 8 found DETAILS=1 covering its whole nonstarter list
// with a real score. This compares the two for every id present in both,
// for THIS SAME league/week, and prints any mismatch — score present but
// disagreeing, not just one side missing the id entirely.
if (MFL_LEAGUE_ID) {
  console.log(`\n\n=== RUN 10: playerScores&RULES=1 vs liveScoring&DETAILS=1, per-player agreement, league ${MFL_LEAGUE_ID} ===\n`);
  try {
    const cookie = await mflLogin(process.env.MFL_USERNAME, process.env.MFL_PASSWORD);
    const year = seasonOf({ id: MFL_LEAGUE_ID });
    const league = { id: MFL_LEAGUE_ID };

    // Resolve the SAME week production now uses: live.week off a plain
    // TYPE=liveScoring call (no DETAILS), exactly what fetchScoring reads.
    const plainLive = await mflGet(`/export?TYPE=liveScoring&L=${MFL_LEAGUE_ID}&JSON=1`, cookie, year);
    const week = plainLive?.liveScoring?.week;
    console.log(`live.week (what fetchScoring now uses for W=): ${week}`);
    if (!week) {
      console.log('  no week on this response — nothing to compare');
    } else {
      const detailedLive = await mflGet(`/export?TYPE=liveScoring&L=${MFL_LEAGUE_ID}&W=${week}&DETAILS=1&JSON=1`, cookie, year);
      const rawMatchups = detailedLive?.liveScoring?.matchup;
      const matchupList = Array.isArray(rawMatchups) ? rawMatchups : rawMatchups ? [rawMatchups] : [];
      const allEntries = [];
      for (const m of matchupList) {
        const fs = Array.isArray(m.franchise) ? m.franchise : m.franchise ? [m.franchise] : [];
        for (const fr of fs) {
          const raw = fr.players?.player;
          const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
          for (const p of list) allEntries.push(p);
        }
      }
      const nonstarterScoreById = new Map(
        allEntries
          .filter((p) => String(p.status).toLowerCase() !== 'starter')
          .filter((p) => p.score != null && p.score !== '')
          .map((p) => [String(p.id), Number(p.score)])
      );
      console.log(`liveScoring&DETAILS=1: ${nonstarterScoreById.size} nonstarter entries with a real score`);

      const weekScores = await probeMflWeekPlayerScores(league, week, cookie);
      console.log(`playerScores&RULES=1: ${weekScores.size} players with a real score league-wide`);

      let agree = 0;
      let disagree = 0;
      const mismatches = [];
      for (const [id, liveScore] of nonstarterScoreById) {
        if (!weekScores.has(id)) continue; // covered separately by RUN 8's coverage numbers
        const psScore = weekScores.get(id);
        if (Math.abs(psScore - liveScore) < 0.05) {
          agree++;
        } else {
          disagree++;
          mismatches.push({ id, liveScoringDetailsScore: liveScore, playerScoresRulesScore: psScore });
        }
      }
      console.log(`\nOf ids present in BOTH sources: ${agree} agree, ${disagree} disagree`);
      if (mismatches.length) {
        console.log(`all mismatches (liveScoring&DETAILS=1 vs playerScores&RULES=1):`);
        console.log(JSON.stringify(mismatches, null, 2));
      }
    }
  } catch (err) {
    console.log(`  RUN 10 probe failed: ${err.message}`);
  }
} else {
  console.log('\n\n=== RUN 10 skipped (no PROBE_MFL_LEAGUE_ID) ===');
}
