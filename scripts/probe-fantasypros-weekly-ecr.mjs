// Asks FantasyPros what `type=WEEKLY` on the consensus-rankings endpoint
// actually returns, ahead of using weekly ECR for the Game-Time Watchlist's
// replacement suggestions (today they sort on p.ecr.rank, which in season is
// the rest-of-season list: a long-horizon value, not a start/sit call).
//
// WEEKLY is already known to be an accepted `type` (the sleepers probe's header
// lists it with DRAFT/DYNASTY/ROS), but nothing in this repo has ever requested
// it, so everything below is unverified:
//   1. Is there an overall list (position=ALL), or only per-position lists
//      (QB, RB, WR, TE, K, DST, plus FLX/OP)? Weekly lists are usually
//      per-position on FantasyPros, which makes rank_ecr a POSITION rank, fine
//      for "best same-position bench player" but not comparable across
//      positions.
//   2. Which `week` value does it want: omitted (the live week), the NFL week
//      number, or both? Does a wrong/absent one silently serve another list?
//   3. Do the response fields match the ones buildRankingIndex reads
//      (player_name, rank_ecr, pos_rank, tier, player_team_id,
//      player_position_id), and are the team/position ids the same spelling?
//   4. How many players come back per position, how many experts, and how
//      fresh is `last_updated` (weekly lists move through the week)?
//   5. Does `scoring` (PPR / HALF / STD) change the list?
//
// Read-only: ~25 GETs, paced, none of them writes. Needs FANTASYPROS_API_KEY,
// which is a GitHub Actions secret, so a workflow run is the only place to ask.
// A control request (the call the sync already makes) must succeed first, or a
// candidate's failure would mean "broken key" rather than "no such list".
//
// RUN 1 (2026-11-05, week 9, season 2026):
//   * type=WEEKLY works, and position=ALL is a real OVERALL list: 396
//     players, rank_ecr 1..396 (17 experts), with pos_rank (WR1, RB3, ...)
//     alongside, so ranks compare across positions. Per position: RB 109,
//     WR 173, TE 114, K 32, DST 30. DEF is a 400 ("Invalid Position"); the
//     valid spellings include QB, RB, WR, TE, K, OP, FLX, DST, IDP.
//   * An OMITTED `week` is the live week: identical to week=9, and the
//     response echoes `week`. week=8 (past) still serves; week=10 answers 200
//     with players=0, experts=0, last_updated "1/01" until it is published;
//     week=0 answers an empty Draft list. So an empty list means "not
//     published yet", never "nobody is ranked".
//   * Same fields buildRankingIndex reads (player_name, rank_ecr, pos_rank,
//     player_team_id, player_position_id, player_page_url) but NO `tier`.
//     Extras not used: player_game_status, player_opponent, rank_ave,
//     rank_std, recommendation, note.
//   * `scoring` is real: PPR/HALF/STD are separate lists (WR depth 173/222/173,
//     experts 18/20/16), though the WR top 5 was identical.
//   * Rate limit: 8 of 23 requests got 429 at 400ms pacing. The sync's fpGet
//     retries 429s with backoff; attachWeeklyRankings makes one request per
//     distinct scoring (at most three).
//   * FOUND AFTER, from the first real sync with the weekly fetch (same day):
//     the overall list carries NO QB, K or DST (0 of 67 rostered QBs, 0 of 8
//     K, 0 of 8 Def matched; RB/WR/TE matched ~85-95%). Those three come from
//     their own position lists, kept in `weeklyPosEcr` because a position rank
//     is a different scale. QB's own list was never read here (that request
//     drew a 429), so its shape is assumed to match RB/WR/TE until a sync
//     shows otherwise. ESPN "Lions D/ST"-style defense names don't join to
//     FantasyPros names, the same gap ROS ecr already has.
//   * Used by attachWeeklyRankings (lib/fantasypros.mjs).

import { fantasyProsApiKey, nflSeasonPhase } from './lib/fantasypros.mjs';

const apiKey = fantasyProsApiKey();
if (!apiKey) {
  console.error('No FANTASYPROS_API_KEY set — nothing to probe.');
  process.exit(1);
}

const FP_BASE = 'https://api.fantasypros.com/public/v2/json';
const { season } = nflSeasonPhase();
const DAY_MS = 86400000;

// NFL week from the calendar: week 1 starts the Thursday after Labor Day, and
// each week turns over Thursday here. Only a starting guess: the probe also
// tries the neighbours, because the exact turnover FantasyPros uses is one of
// the things being asked.
function guessWeek(now = new Date()) {
  const year = now.getUTCFullYear();
  const sept1 = Date.UTC(year, 8, 1);
  const toMonday = (8 - new Date(sept1).getUTCDay()) % 7; // first Monday on or after Sep 1
  const kickoff = sept1 + toMonday * DAY_MS + 3 * DAY_MS;
  return Math.min(18, Math.max(1, Math.floor((now.getTime() - kickoff) / (7 * DAY_MS)) + 1));
}
const week = guessWeek();
console.log(`season ${season}, guessed NFL week ${week} (probing ${week - 1}, ${week}, ${week + 1}, and no week)`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(query) {
  const url = `${FP_BASE}/nfl/${season}/consensus-rankings?${query}`;
  await sleep(400);
  try {
    const res = await fetch(url, { headers: { 'x-api-key': apiKey } });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* leave null */ }
    return { url, status: res.status, text, json };
  } catch (err) {
    return { url, status: null, text: '', json: null, error: err.message };
  }
}

const summarize = (r) => {
  const players = r.json?.players;
  const n = Array.isArray(players) ? players.length : null;
  const ranks = (players || []).map((p) => Number(p.rank_ecr)).filter(Number.isFinite);
  const first = (players || []).slice(0, 3).map((p) => `${p.player_name} [${p.player_position_id}/${p.player_team_id}] rank_ecr=${p.rank_ecr} pos_rank=${p.pos_rank} tier=${p.tier}`);
  return {
    status: r.status,
    players: n,
    experts: r.json?.total_experts ?? null,
    updated: r.json?.last_updated ?? null,
    week: r.json?.week ?? null,
    type: r.json?.type ?? null,
    position: r.json?.position ?? null,
    rankRange: ranks.length ? `${Math.min(...ranks)}..${Math.max(...ranks)}` : null,
    first,
  };
};

function show(label, query) {
  return get(query).then((r) => {
    const s = summarize(r);
    console.log(`\n--- ${label} ---`);
    console.log(`GET ...consensus-rankings?${query}`);
    console.log(`HTTP ${s.status}${r.error ? ` (${r.error})` : ''}  players=${s.players}  experts=${s.experts}  last_updated=${s.updated}  response.week=${s.week}  response.type=${s.type}  response.position=${s.position}  rank_ecr range=${s.rankRange}`);
    if (s.players === null && r.text) console.log(`body: ${r.text.slice(0, 300).replace(/\s+/g, ' ')}`);
    for (const line of s.first) console.log(`  ${line}`);
    return { label, query, ...s, json: r.json };
  });
}

// Control: the call the sync makes every run.
const control = await show('control: type=ROS position=ALL (what the picker uses today)', 'position=ALL&type=ROS&scoring=PPR');
if (control.status !== 200 || !control.players) {
  console.error('\nControl request failed or came back empty: key or API is broken, so nothing below means anything.');
  process.exit(1);
}

const results = [];

// 1 + 2: positions x week spellings. Week variants only for a couple of
// positions; the per-position sweep then uses the best-looking spelling.
for (const [name, w] of [['no week', ''], [`week=${week}`, `&week=${week}`], [`week=${week + 1}`, `&week=${week + 1}`], [`week=${week - 1}`, `&week=${week - 1}`], ['week=0', '&week=0']]) {
  results.push(await show(`WEEKLY position=ALL, ${name}`, `position=ALL&type=WEEKLY&scoring=PPR${w}`));
  results.push(await show(`WEEKLY position=WR, ${name}`, `position=WR&type=WEEKLY&scoring=PPR${w}`));
}

// 1: every position spelling, at the guessed week and with no week.
for (const pos of ['QB', 'RB', 'WR', 'TE', 'K', 'DST', 'DEF', 'FLX', 'OP']) {
  results.push(await show(`WEEKLY position=${pos}, week=${week}`, `position=${pos}&type=WEEKLY&scoring=PPR&week=${week}`));
}

// 5: does scoring change the list? Compare WR top-3 across formats.
const wr = {};
for (const scoring of ['PPR', 'HALF', 'STD']) {
  wr[scoring] = await show(`WEEKLY position=WR scoring=${scoring}, week=${week}`, `position=WR&type=WEEKLY&scoring=${scoring}&week=${week}`);
}

console.log('\n=== summary ===');
for (const r of results) {
  console.log(`${String(r.status).padEnd(4)} players=${String(r.players).padEnd(5)} experts=${String(r.experts).padEnd(4)} ${r.label}`);
}
const top = (r) => (r.json?.players || []).slice(0, 5).map((p) => p.player_name).join(', ');
console.log('\nWR top 5 by scoring (identical lists mean scoring is ignored):');
for (const [k, r] of Object.entries(wr)) console.log(`  ${k}: ${top(r)}`);
console.log('\nField names present on a WEEKLY player (compare with buildRankingIndex):');
const sample = results.find((r) => r.players > 0)?.json?.players?.[0];
console.log(sample ? Object.keys(sample).join(', ') : '  (no WEEKLY list returned players)');
