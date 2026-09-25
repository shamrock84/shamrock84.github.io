#!/usr/bin/env node
// Which source says a player is INACTIVE, and how soon after the NFL
// publishes the gameday inactive list (about 90 minutes before kickoff)?
//
// The question behind it: the Game-Time Watchlist (myffl.html) tells the
// manager which starters to check before kickoff. The next step is to do the
// checking for him — look at each watched starter after inactives are out and
// send "active" or "inactive, swap him" instead of an alarm. That only works
// if some source reflects the inactive list within minutes. The designation
// the sync carries today (Q/D/O) is the practice-week injury report, which is
// a different thing: a Friday Q is still Q on MFL at kickoff whether or not he
// was declared inactive at 11:30. Nothing in this project has ever looked at
// gameday inactives, so this probe decides the design rather than a guess.
//
// Candidates, all read-only, all polled on the same clock so their timing is
// directly comparable:
//
//   1. ESPN's public game summary (site.api.espn.com/.../summary?event=ID).
//      Its per-game `injuries` block is the obvious place to look; the probe
//      also deep-searches the whole response for any key naming
//      active/inactive/didNotPlay, since the field could live anywhere.
//   2. ESPN's core API per-competitor roster
//      (sports.core.api.espn.com/.../competitors/{team}/roster) — the
//      gamecast's own roster, which may carry an active flag per athlete.
//      Every primitive field on an entry is recorded, and any change to one
//      is logged, so a flag nobody knew the name of still shows up.
//   3. ESPN's league-wide injuries endpoint (site.api.espn.com/.../injuries).
//   4. MFL's TYPE=injuries — the feed the sync already reads. Raw status, not
//      normalized, so "Out" vs "Inactive" vs anything new stays visible.
//   5. Sleeper's /players/nfl `injury_status` and `status`. Polled on its own
//      slower interval (SLEEPER_INTERVAL_MINUTES): it is a multi-megabyte
//      dump that Sleeper asks callers to fetch at most daily, and this is a
//      one-off measurement, not a pattern to copy into anything scheduled.
//
// Who is tracked: every starter in data/rosters.json carrying a designation
// (the watchlist itself), plus every player on an in-window game's ESPN
// injury report — the watchlist alone is too few bodies to catch a flip on
// a given Sunday. Changes on the ESPN core roster are logged for everyone,
// capped per team per tick, since that is where an unknown flag would show.
//
// Output: a timestamped line per status change as it happens
// ("12:31 ET  T-89m  mfl  Saquon Barkley PHI: Q -> Out"), and at the end a
// per-player table of every source's first and last status and when it
// changed relative to kickoff — also written to the job summary.
//
// Run from the Actions tab (probe-inactives.yml), dispatched about two hours
// before the first kickoff of a slate. Inputs: DURATION_MINUTES (how long to
// poll), INTERVAL_MINUTES, SLEEPER_INTERVAL_MINUTES. MFL is skipped, with a
// line saying so, when MFL_USERNAME/MFL_PASSWORD are absent.

import { readFile, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mflLogin, mflGet, loadPlayerMap, setMflRequestInterval } from './lib/providers.mjs';
import { normalizePlayerName } from './lib/fantasypros.mjs';

const ROSTERS_PATH = fileURLToPath(new URL('../data/rosters.json', import.meta.url));
const DURATION_MIN = Number(process.env.DURATION_MINUTES ?? 300);
const INTERVAL_MIN = Number(process.env.INTERVAL_MINUTES ?? 5);
const SLEEPER_INTERVAL_MIN = Number(process.env.SLEEPER_INTERVAL_MINUTES ?? 15);
// A game is polled from this long before kickoff until it goes final — wide
// enough to see the pre-inactives state before the 90-minute mark.
const LEAD_WINDOW_MIN = 150;
const CORE_CHANGE_LOG_CAP = 15;

const SITE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const CORE = 'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl';

// Providers spell some teams differently (MFL's LVR is the scoreboard's LV,
// and Washington/Arizona go both ways), so a kickoff is stored under every
// spelling. Same table as NFL_TEAM_ALIASES in providers.mjs, which keeps it
// module-private.
const TEAM_ALIASES = { GBP: 'GB', JAC: 'JAX', KCC: 'KC', LVR: 'LV', NEP: 'NE', NOS: 'NO', SFO: 'SF', TBB: 'TB', WSH: 'WAS', WAS: 'WSH', ARZ: 'ARI', ARI: 'ARZ' };
function teamSpellings(abbr) {
  const out = new Set([abbr]);
  for (const [alias, canonical] of Object.entries(TEAM_ALIASES)) {
    if (canonical === abbr) out.add(alias);
    if (alias === abbr) out.add(canonical);
  }
  return out;
}

const key = (name) => normalizePlayerName(name) || String(name || '').toLowerCase();
const et = (d) => d.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }) + ' ET';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

// Every path in `obj` whose key matches `re`, with a short rendering of the
// value — how a field nobody knew the name of gets found.
function deepFindKeys(obj, re, path = '', out = [], seen = new Set()) {
  if (!obj || typeof obj !== 'object' || seen.has(obj)) return out;
  seen.add(obj);
  for (const [k, v] of Object.entries(obj)) {
    const p = Array.isArray(obj) ? `${path}[${k}]` : path ? `${path}.${k}` : k;
    if (re.test(k)) out.push(`${p} = ${JSON.stringify(v)?.slice(0, 160)}`);
    if (v && typeof v === 'object') deepFindKeys(v, re, p, out, seen);
  }
  return out;
}

// The primitive fields of an object as one stable string — a change in any
// of them is a change worth logging.
function primitiveSignature(obj) {
  return Object.entries(obj || {})
    .filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v))
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join(' ');
}

// ---- State ----------------------------------------------------------------

// tracked: key -> { name, team, watch: bool }
const tracked = new Map();
// status: `${source}|${key}` -> string
const status = new Map();
// history: key -> [{ at, source, from, to, kickoff }]
const history = new Map();
// kickoff by team abbreviation, for the T-minus column.
const kickoffByTeam = new Map();
const shapesPrinted = new Set();
let lastMflStamp;

function track(name, team, watch = false) {
  const k = key(name);
  if (!k) return k;
  const prev = tracked.get(k);
  if (!prev) tracked.set(k, { name, team: team || null, watch });
  else {
    if (watch) prev.watch = true;
    if (!prev.team && team) prev.team = team;
  }
  return k;
}

function tMinus(k, now) {
  const team = tracked.get(k)?.team;
  const kickoff = team ? kickoffByTeam.get(team) : null;
  if (!kickoff) return '   ?  ';
  const mins = Math.round((kickoff - now) / 60000);
  return (mins >= 0 ? `T-${mins}m` : `T+${-mins}m`).padEnd(6);
}

function record(source, k, value, now, { quiet = false } = {}) {
  const id = `${source}|${k}`;
  const prev = status.get(id);
  if (prev === value) return;
  status.set(id, value);
  const who = tracked.get(k);
  const team = who?.team ? kickoffByTeam.get(who.team) : null;
  if (!history.has(k)) history.set(k, []);
  history.get(k).push({ at: now, source, from: prev ?? null, to: value, kickoff: team ?? null });
  // The first reading is a baseline, not a change; say it only for watched
  // starters so the log opens with what the watchlist is looking at.
  if (prev === undefined && !who?.watch) return;
  if (quiet) return;
  const label = `${who?.name ?? k}${who?.team ? ' ' + who.team : ''}${who?.watch ? ' [WATCH]' : ''}`;
  console.log(`${et(now).padEnd(12)} ${tMinus(k, now)} ${source.padEnd(13)} ${label}: ${prev === undefined ? '(first)' : prev} -> ${value}`);
}

// ---- Sources --------------------------------------------------------------

async function readScoreboard() {
  const data = await getJson(`${SITE}/scoreboard`);
  return (data.events || []).map((e) => {
    const c = e.competitions?.[0];
    return {
      id: e.id,
      name: e.shortName,
      kickoff: new Date(c?.date || e.date),
      state: c?.status?.type?.state || 'pre',
      teams: (c?.competitors || []).map((t) => ({ id: t.team?.id, abbr: t.team?.abbreviation })),
    };
  });
}

// ESPN athlete id -> name, per team, fetched once.
const athleteNames = new Map();
async function loadTeamRoster(teamId) {
  if (athleteNames.has(`team:${teamId}`)) return;
  athleteNames.set(`team:${teamId}`, true);
  try {
    const data = await getJson(`${SITE}/teams/${teamId}/roster`);
    for (const group of data.athletes || []) {
      for (const a of group.items || [group]) {
        if (a?.id) athleteNames.set(String(a.id), a.fullName || a.displayName);
      }
    }
  } catch (err) {
    console.log(`  team roster ${teamId}: ${err.message}`);
  }
}

async function pollSummary(game, now) {
  let data;
  try {
    data = await getJson(`${SITE}/summary?event=${game.id}`);
  } catch (err) {
    console.log(`  summary ${game.name}: ${err.message}`);
    return;
  }
  if (!shapesPrinted.has('summary')) {
    shapesPrinted.add('summary');
    console.log(`\n--- ESPN summary shape (${game.name}) ---`);
    console.log('top-level keys:', Object.keys(data));
    console.log('injuries[0]:', JSON.stringify(data.injuries?.[0])?.slice(0, 1500));
  }
  // Re-run the deep search once per game after its inactives should be out,
  // since a field that only appears then would be missed by the first look.
  const minsToKick = (game.kickoff - now) / 60000;
  for (const phase of ['early', 'post-inactives']) {
    const due = phase === 'early' || minsToKick <= 85;
    const tag = `deep:${game.id}:${phase}`;
    if (!due || shapesPrinted.has(tag)) continue;
    shapesPrinted.add(tag);
    const hits = deepFindKeys(data, /inactive|^active$|didnotplay|dnp/i);
    console.log(`\n--- ${game.name} summary, ${phase}: keys naming active/inactive (${hits.length}) ---`);
    hits.slice(0, 25).forEach((h) => console.log('  ' + h));
  }
  for (const teamBlock of data.injuries || []) {
    const abbr = teamBlock.team?.abbreviation;
    for (const inj of teamBlock.injuries || []) {
      const name = inj.athlete?.displayName || inj.athlete?.fullName;
      if (!name) continue;
      const k = track(name, abbr);
      const detail = [inj.status, inj.type?.abbreviation || inj.type?.name, inj.details?.fantasyStatus?.abbreviation].filter(Boolean).join(' / ');
      record('espn-summary', k, detail || JSON.stringify(inj).slice(0, 80), now);
    }
  }
}

async function pollCoreRoster(game, team, now) {
  let data;
  try {
    data = await getJson(`${CORE}/events/${game.id}/competitions/${game.id}/competitors/${team.id}/roster`);
  } catch (err) {
    if (!shapesPrinted.has(`core-err:${team.id}`)) {
      shapesPrinted.add(`core-err:${team.id}`);
      console.log(`  core roster ${team.abbr}: ${err.message}`);
    }
    return;
  }
  const entries = data.entries || data.items || [];
  if (!shapesPrinted.has('core')) {
    shapesPrinted.add('core');
    console.log(`\n--- ESPN core roster shape (${team.abbr}) ---`);
    console.log('top-level keys:', Object.keys(data), `entries: ${entries.length}`);
    console.log('entries[0]:', JSON.stringify(entries[0])?.slice(0, 1500));
  }
  await loadTeamRoster(team.id);
  let logged = 0;
  let changed = 0;
  for (const e of entries) {
    const athleteId = String(e.playerId ?? e.athlete?.id ?? (e.athlete?.$ref || '').match(/athletes\/(\d+)/)?.[1] ?? '');
    const name = e.displayName || athleteNames.get(athleteId) || `espn#${athleteId}`;
    const k = track(name, team.abbr);
    const sig = primitiveSignature(e);
    const prev = status.get(`espn-core|${k}`);
    if (prev !== undefined && prev !== sig) changed++;
    const quiet = prev !== undefined && prev !== sig && logged >= CORE_CHANGE_LOG_CAP;
    if (prev !== undefined && prev !== sig) logged++;
    record('espn-core', k, sig, now, { quiet: quiet || prev === undefined });
  }
  if (changed > CORE_CHANGE_LOG_CAP) console.log(`  (${team.abbr}: ${changed} core-roster changes this tick, ${CORE_CHANGE_LOG_CAP} shown)`);
}

async function pollLeagueInjuries(windowTeams, now) {
  let data;
  try {
    data = await getJson(`${SITE}/injuries`);
  } catch (err) {
    if (!shapesPrinted.has('league-injuries-err')) {
      shapesPrinted.add('league-injuries-err');
      console.log(`  league injuries: ${err.message}`);
    }
    return;
  }
  if (!shapesPrinted.has('league-injuries')) {
    shapesPrinted.add('league-injuries');
    console.log('\n--- ESPN league injuries shape ---');
    console.log('top-level keys:', Object.keys(data));
    console.log('injuries[0]:', JSON.stringify(data.injuries?.[0])?.slice(0, 1200));
  }
  for (const teamBlock of data.injuries || []) {
    for (const inj of teamBlock.injuries || []) {
      const name = inj.athlete?.displayName;
      const abbr = inj.athlete?.team?.abbreviation || teamBlock.team?.abbreviation || null;
      if (!name) continue;
      const k = key(name);
      if (!tracked.has(k) && !(abbr && windowTeams.has(abbr))) continue;
      track(name, abbr);
      record('espn-injuries', k, [inj.status, inj.type?.abbreviation].filter(Boolean).join(' / '), now);
    }
  }
}

async function pollMfl(cookie, playerMap, now) {
  let data;
  try {
    data = await mflGet('/export?TYPE=injuries&JSON=1', cookie);
  } catch (err) {
    console.log(`  mfl injuries: ${err.message}`);
    return;
  }
  const raw = data?.injuries?.injury;
  const rows = Array.isArray(raw) ? raw : raw ? [raw] : [];
  if (!shapesPrinted.has('mfl')) {
    shapesPrinted.add('mfl');
    console.log(`\n--- MFL injuries: ${rows.length} rows; timestamp=${data?.injuries?.timestamp ?? '(none)'} ---`);
    console.log('rows[0]:', JSON.stringify(rows[0]));
    console.log('distinct statuses:', [...new Set(rows.map((r) => r.status))]);
  } else if (data?.injuries?.timestamp && data.injuries.timestamp !== lastMflStamp) {
    console.log(`${et(now).padEnd(12)}        mfl feed timestamp -> ${data.injuries.timestamp}`);
  }
  lastMflStamp = data?.injuries?.timestamp;
  const seen = new Set();
  for (const r of rows) {
    const name = playerMap.get(r.id)?.name;
    if (!name) continue;
    const k = key(name);
    if (!tracked.has(k)) continue;
    seen.add(k);
    record('mfl', k, r.status, now);
  }
  // Dropping off the report is itself a status.
  for (const k of tracked.keys()) {
    if (!seen.has(k) && status.has(`mfl|${k}`)) record('mfl', k, '(not on report)', now);
  }
}

async function pollSleeper(now) {
  let data;
  try {
    data = await getJson('https://api.sleeper.app/v1/players/nfl');
  } catch (err) {
    console.log(`  sleeper players: ${err.message}`);
    return;
  }
  for (const p of Object.values(data)) {
    const name = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ');
    const k = key(name);
    if (!tracked.has(k)) continue;
    record('sleeper', k, `${p.injury_status ?? '-'} | ${p.status ?? '-'}`, now);
  }
}

// ---- Main -----------------------------------------------------------------

const snapshot = JSON.parse(await readFile(ROSTERS_PATH, 'utf8'));
for (const league of snapshot.leagues || []) {
  if (!Array.isArray(league.starters)) continue;
  const byId = new Map((league.players || []).map((p) => [String(p.id), p]));
  for (const id of league.starters) {
    const p = byId.get(String(id));
    if (p?.injuryStatus) track(p.name, p.team, true);
  }
}
console.log(`Watchlist from data/rosters.json (${snapshot.generatedAt}):`);
for (const t of tracked.values()) console.log(`  ${t.name} ${t.team}`);

let cookie = null;
let mflPlayers = null;
if (process.env.MFL_USERNAME && process.env.MFL_PASSWORD) {
  setMflRequestInterval(300);
  try {
    cookie = await mflLogin(process.env.MFL_USERNAME, process.env.MFL_PASSWORD);
    mflPlayers = await loadPlayerMap(cookie);
  } catch (err) {
    console.log(`MFL unavailable, skipping it: ${err.message}`);
  }
} else {
  console.log('MFL_USERNAME/MFL_PASSWORD not set — MFL skipped.');
}

const started = Date.now();
const endAt = started + DURATION_MIN * 60000;
let lastSleeper = 0;
console.log(`\nPolling every ${INTERVAL_MIN} min (Sleeper every ${SLEEPER_INTERVAL_MIN}) until ${et(new Date(endAt))}.\n`);

for (let tick = 0; ; tick++) {
  const now = new Date();
  let games = [];
  try {
    games = await readScoreboard();
  } catch (err) {
    console.log(`${et(now)} scoreboard: ${err.message}`);
  }
  // Watch a game from LEAD_WINDOW_MIN before kickoff until it goes final;
  // a game whose window only opens after this run ends isn't worth a request.
  const inWindow = games.filter((g) => g.state !== 'post' && g.kickoff - now <= LEAD_WINDOW_MIN * 60000 && g.kickoff - LEAD_WINDOW_MIN * 60000 <= endAt);
  const windowTeams = new Set();
  for (const g of games) for (const t of g.teams) if (t.abbr) for (const a of teamSpellings(t.abbr)) kickoffByTeam.set(a, g.kickoff);
  for (const g of inWindow) for (const t of g.teams) if (t.abbr) for (const a of teamSpellings(t.abbr)) windowTeams.add(a);
  if (tick === 0) {
    console.log(`Scoreboard: ${games.length} games; in window now: ${inWindow.map((g) => `${g.name} @ ${et(g.kickoff)}`).join(', ') || 'none'}`);
  }

  for (const g of inWindow) {
    await pollSummary(g, now);
    for (const t of g.teams) if (t.id) await pollCoreRoster(g, t, now);
  }
  await pollLeagueInjuries(windowTeams, now);
  if (cookie && mflPlayers) await pollMfl(cookie, mflPlayers, now);
  if (Date.now() - lastSleeper >= SLEEPER_INTERVAL_MIN * 60000) {
    lastSleeper = Date.now();
    await pollSleeper(now);
  }

  if (Date.now() + INTERVAL_MIN * 60000 > endAt) break;
  await sleep(INTERVAL_MIN * 60000);
}

// ---- Summary --------------------------------------------------------------

const lines = ['## Status changes by player', '', '| Player | Source | First | Last | Changed at |', '| --- | --- | --- | --- | --- |'];
console.log('\n' + '='.repeat(72) + '\nSUMMARY — tracked players whose status changed on any source\n' + '='.repeat(72));
for (const [k, events] of history) {
  const bySource = new Map();
  for (const ev of events) {
    if (!bySource.has(ev.source)) bySource.set(ev.source, []);
    bySource.get(ev.source).push(ev);
  }
  const changedSources = [...bySource.entries()].filter(([, evs]) => evs.length > 1);
  if (changedSources.length === 0) continue;
  const who = tracked.get(k);
  console.log(`\n${who?.name ?? k} ${who?.team ?? ''}${who?.watch ? ' [WATCH]' : ''}`);
  for (const [source, evs] of bySource) {
    const first = evs[0].to;
    const last = evs[evs.length - 1];
    const when = evs.length > 1 ? `${et(last.at)} (${last.kickoff ? tMinus(k, last.at).trim() : '?'})` : 'unchanged';
    console.log(`  ${source.padEnd(13)} ${first}  ->  ${last.to}   ${when}`);
    lines.push(`| ${who?.name ?? k}${who?.watch ? ' **[WATCH]**' : ''} | ${source} | ${first} | ${last.to} | ${when} |`);
  }
}
console.log(`\nTracked ${tracked.size} players across the run.`);

if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
}
