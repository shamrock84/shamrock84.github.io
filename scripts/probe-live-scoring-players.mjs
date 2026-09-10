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
// Read-only. Run from the Actions tab (probe-live-scoring-players.yml).
import {
  mflLogin,
  mflGet,
  seasonOf,
  espnGet,
  loadSleeperPlayerMap,
} from './lib/providers.mjs';

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
