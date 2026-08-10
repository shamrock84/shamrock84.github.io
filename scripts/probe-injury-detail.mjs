#!/usr/bin/env node
// Asks MFL and Sleeper what they will tell us about an injury beyond its
// designation.
//
// The question it was written to settle: whether a line of detail — body part,
// expected return — exists in responses the sync already makes, or whether it
// would need a new source. It does. `details` and `exp_return` came back filled
// on 325 of 325 rows, and the sync now keeps both (injuryEntryFromRow), which is
// what the Injury Exposure card prints under a name.
//
// Still worth re-running whenever that line looks wrong or empty: it is the only
// way to see what the feed is actually publishing, and it re-reads the status
// vocabulary INJURY_SEVERITY has to cover — which is how the mangled IR-PUP
// mapping surfaced the first time, having sorted a season-long reserve
// designation below a Questionable for as long as it had existed.
//
// Deliberately shape-finding rather than field-checking: it does not look for
// a key called `details`, it prints every key that isn't `id`/`status` and
// says how often each is actually filled in. A field that exists on the
// schema and is empty for 90% of the injury report is not a feature.
//
// Four things are being decided, and the run prints each:
//
//   1. Does a detail field exist at all, per provider, and what is in it.
//   2. Is it populated often enough to be worth a line on the card — fill
//      rates across the whole report, not just on a sample row.
//   3. Would it cover the players we actually roster. This is the one that
//      decides the design. MFL's injury report is global (TYPE=injuries takes
//      no league parameter), so if it covers players held in Sleeper and ESPN
//      leagues too, the detail can live in one top-level map keyed by name
//      rather than being attached per-provider — which is what stops the
//      column being blank for exactly the leagues MFL doesn't serve.
//   4. What that name join costs. Keying by name rather than by MFL id is
//      what makes the cross-provider lookup possible, and it is also how two
//      players who share a name become one row (josh-allen.php is the QB,
//      josh-allen-lb.php the linebacker). Collisions inside the injury report
//      are counted below.
//
// ESPN is not probed. Both ESPN leagues hold 0 players until their drafts, so
// there is nothing to read a detail off even if its roster view carries one —
// and under the design above ESPN doesn't need to carry one. The Sleeper
// league stands in as the cross-provider test: its players are keyed by
// Sleeper ids, so if MFL's global report reaches them by name it will reach
// ESPN's the same way.
//
// Read-only, and every call here is one the 4-hourly sync already makes:
// MFL login, TYPE=injuries, TYPE=players, and Sleeper's player dump.
//
// Run from the Actions tab (probe-injury-detail.yml).

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mflLogin, mflGet, loadPlayerMap, normalizeInjuryStatus } from './lib/providers.mjs';
import { normalizePlayerName } from './lib/fantasypros.mjs';

const ROSTERS_PATH = fileURLToPath(new URL('../data/rosters.json', import.meta.url));

const rule = (label) => {
  console.log('\n' + '='.repeat(72));
  console.log(label);
  console.log('='.repeat(72));
};

const filled = (v) => v != null && String(v).trim() !== '';

// Fill rate and text length per key, over every row rather than a sample.
// Length is here for the payload question: whatever this ends up costing is
// paid by every visitor on every page load, since data/rosters.json is
// fetched whole.
function fieldStats(rows, keys) {
  return keys.map((key) => {
    const values = rows.map((r) => (filled(r[key]) ? String(r[key]).trim() : null)).filter(Boolean);
    const lengths = values.map((v) => v.length);
    const distinct = new Set(values);
    return {
      key,
      count: values.length,
      pct: rows.length ? Math.round((values.length / rows.length) * 100) : 0,
      distinct: distinct.size,
      maxLen: lengths.length ? Math.max(...lengths) : 0,
      meanLen: lengths.length ? Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length) : 0,
      sample: values.slice(0, 6),
    };
  });
}

function printFieldStats(stats, total) {
  const pad = (v, n) => String(v ?? '').padEnd(n);
  console.log(`  ${pad('FIELD', 22)}${pad('FILLED', 14)}${pad('DISTINCT', 10)}${pad('LEN mean/max', 14)}EXAMPLES`);
  for (const s of stats) {
    console.log(
      `  ${pad(s.key, 22)}${pad(`${s.count}/${total} (${s.pct}%)`, 14)}${pad(s.distinct, 10)}` +
        `${pad(`${s.meanLen}/${s.maxLen}`, 14)}${s.sample.map((v) => JSON.stringify(v)).join(' ')}`
    );
  }
}

// A name-keyed map is the only way to reach a player rostered on another
// provider, and it is also where two people become one row. Both halves are
// reported: the map itself, and what it lost building it.
function nameKeyed(entries) {
  const map = new Map();
  const collisions = new Map();
  for (const { name, detail } of entries) {
    const key = normalizePlayerName(name);
    if (!key) continue;
    if (map.has(key) && map.get(key).name !== name) {
      if (!collisions.has(key)) collisions.set(key, [map.get(key).name]);
      collisions.get(key).push(name);
    }
    if (!map.has(key)) map.set(key, { name, detail });
  }
  return { map, collisions };
}

// ---- Who we actually care about: the players on the card right now ----

let ours = new Map();
let generatedAt = null;
try {
  const prev = JSON.parse(await readFile(ROSTERS_PATH, 'utf8'));
  generatedAt = prev.generatedAt || null;
  for (const league of prev.leagues || []) {
    const provider = league.provider || 'mfl';
    for (const p of league.players || []) {
      // Both halves of what the card treats as injured — injuryDesignation in
      // myffl.html falls back to a league IR slot when the feed says nothing.
      // Kept apart below, because a player who is only on an IR slot is
      // precisely the one the feed is most likely to have no detail for.
      const slotIr = String(p.status || '').toUpperCase() === 'INJURED_RESERVE';
      if (!p.injuryStatus && !slotIr) continue;
      const key = normalizePlayerName(p.name);
      if (!ours.has(key)) {
        ours.set(key, { name: p.name, mflIds: new Set(), designations: new Set(), providers: new Set(), fromFeed: false });
      }
      const entry = ours.get(key);
      entry.providers.add(provider);
      if (provider === 'mfl' && p.id) entry.mflIds.add(String(p.id));
      if (p.injuryStatus) {
        entry.designations.add(p.injuryStatus);
        entry.fromFeed = true;
      } else {
        entry.designations.add('ir-slot');
      }
    }
  }
} catch (err) {
  console.log(`No usable data/rosters.json (${err.message}) — the coverage section will be empty.`);
}

console.log(`Our rosters: ${ours.size} distinct players carrying an injury designation` +
  (generatedAt ? ` (synced ${generatedAt})` : ''));

// ---- MFL ----

rule('MFL  TYPE=injuries  (global, no league parameter)');

const cookie = await mflLogin(process.env.MFL_USERNAME, process.env.MFL_PASSWORD);

let mflByName = new Map();
let mflById = new Map();
try {
  const data = await mflGet('/export?TYPE=injuries&JSON=1', cookie);
  const container = data?.injuries ?? {};
  const rawRows = container.injury;
  const rows = Array.isArray(rawRows) ? rawRows : rawRows ? [rawRows] : [];

  // Anything hanging off the container rather than a row — a report-wide
  // timestamp would answer the staleness question on its own. The sync runs
  // every 4 hours, which is fine for a body part and wrong for a practice
  // report, so how old the feed itself is matters as much as what it says.
  const containerAttrs = Object.entries(container).filter(([k]) => k !== 'injury');
  console.log('  container attrs:', containerAttrs.length ? JSON.stringify(Object.fromEntries(containerAttrs)) : '(none)');
  for (const [k, v] of containerAttrs) {
    const secs = Number(v);
    if (Number.isFinite(secs) && secs > 1e9 && secs < 1e11) {
      const ms = secs > 1e10 ? secs : secs * 1000;
      console.log(`    ${k} reads as ${new Date(ms).toISOString()} (${((Date.now() - ms) / 3600e3).toFixed(1)}h ago)`);
    }
  }
  console.log(`  rows: ${rows.length}`);

  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  console.log('  keys present across all rows:', keys.join(', ') || '(none)');

  console.log('\n  First rows verbatim:');
  for (const r of rows.slice(0, 5)) console.log('   ', JSON.stringify(r));

  const candidates = keys.filter((k) => k !== 'id' && k !== 'status');
  console.log(`\n  Candidate detail fields (everything but id/status): ${candidates.join(', ') || '(none — status is all MFL gives)'}`);
  if (candidates.length) printFieldStats(fieldStats(rows, candidates), rows.length);

  // The status vocabulary itself, which INJURY_SEVERITY in myffl.html has to
  // cover. An unrecognised code ranks -1 there on purpose, so a new one is
  // silent rather than wrong — this is the cheap place to notice it.
  const statusCounts = new Map();
  for (const r of rows) {
    const s = String(r.status ?? '').trim();
    statusCounts.set(s, (statusCounts.get(s) || 0) + 1);
  }
  console.log('\n  Raw status vocabulary -> what normalizeInjuryStatus makes of it:');
  for (const [s, n] of [...statusCounts].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(4)}  ${JSON.stringify(s).padEnd(24)} -> ${JSON.stringify(normalizeInjuryStatus(s))}`);
  }

  // Keyed both ways, because the two joins have different costs: MFL-rostered
  // players can be reached by id (exact), everyone else only by name.
  const detailOf = (r) => {
    const parts = candidates.map((k) => (filled(r[k]) ? `${k}=${String(r[k]).trim()}` : null)).filter(Boolean);
    return parts.length ? parts.join(' | ') : null;
  };
  for (const r of rows) if (r.id) mflById.set(String(r.id), detailOf(r));

  const playerMap = await loadPlayerMap(cookie);
  const named = rows
    .map((r) => ({ name: playerMap.get(String(r.id))?.name, detail: detailOf(r) }))
    .filter((e) => e.name);
  console.log(`\n  Resolved ${named.length}/${rows.length} injury rows to a player name via TYPE=players.`);
  const { map, collisions } = nameKeyed(named);
  mflByName = map;
  console.log(`  Name-keyed map: ${map.size} entries, ${collisions.size} normalized-name collisions.`);
  for (const [key, names] of [...collisions].slice(0, 10)) {
    console.log(`    ${key}: ${names.join(' / ')}  <- one of these would win a name-keyed lookup`);
  }
} catch (err) {
  console.log(`  FAILED: ${err.message}`);
}

// ---- Sleeper ----

rule('Sleeper  /players/nfl  (global, public, no auth)');

let sleeperByName = new Map();
try {
  const res = await fetch('https://api.sleeper.app/v1/players/nfl');
  if (!res.ok) throw new Error(`Sleeper request failed (${res.status})`);
  const data = await res.json();
  const all = Object.values(data);

  // Only players the feed considers injured. Fill rates across all ~12k
  // players would be meaningless — almost everyone is healthy, so every
  // injury field would read as ~1% filled and look useless.
  const injured = all.filter((p) => filled(p.injury_status) && normalizeInjuryStatus(p.injury_status));
  console.log(`  players: ${all.length}, of which carrying a designation: ${injured.length}`);

  const injuryKeys = [...new Set(injured.flatMap((p) => Object.keys(p)))]
    .filter((k) => /injur|practice|status/i.test(k) && k !== 'injury_status');
  console.log('  injury-ish keys besides injury_status:', injuryKeys.join(', ') || '(none)');

  console.log('\n  First injured players, injury fields only:');
  for (const p of injured.slice(0, 5)) {
    const view = Object.fromEntries(
      ['full_name', 'team', 'injury_status', ...injuryKeys].map((k) => [k, p[k]])
    );
    console.log('   ', JSON.stringify(view));
  }

  if (injuryKeys.length) {
    console.log('');
    printFieldStats(fieldStats(injured, injuryKeys), injured.length);
  }

  const detailOf = (p) => {
    const parts = injuryKeys.map((k) => (filled(p[k]) ? `${k}=${String(p[k]).trim()}` : null)).filter(Boolean);
    return parts.length ? parts.join(' | ') : null;
  };
  const { map, collisions } = nameKeyed(
    injured
      .map((p) => ({ name: p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' '), detail: detailOf(p) }))
      .filter((e) => e.name)
  );
  sleeperByName = map;
  console.log(`\n  Name-keyed map: ${map.size} entries, ${collisions.size} normalized-name collisions.`);
} catch (err) {
  console.log(`  FAILED: ${err.message}`);
}

// ---- The decision: coverage of the players actually on the card ----

rule('Coverage of the players currently on the Injury Exposure card');

const pad = (v, n) => String(v ?? '').padEnd(n);
console.log(`${pad('PLAYER', 24)}${pad('DESIG', 10)}${pad('ROSTERED VIA', 16)}${pad('MFL BY ID', 10)}${pad('MFL BY NAME', 12)}SLEEPER BY NAME`);

let coveredEither = 0;
let mflIdOnly = 0;
let nameNeeded = 0;
let uncovered = [];
for (const [key, entry] of [...ours].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
  const byId = [...entry.mflIds].map((id) => mflById.get(id)).find(Boolean) || null;
  const byName = mflByName.get(key)?.detail || null;
  const sleeper = sleeperByName.get(key)?.detail || null;
  const nonMflOnly = !entry.providers.has('mfl');
  if (byId || byName || sleeper) coveredEither++;
  else uncovered.push(entry);
  if (byId && !nonMflOnly) mflIdOnly++;
  if (nonMflOnly && (byName || sleeper)) nameNeeded++;
  console.log(
    `${pad(entry.name.slice(0, 23), 24)}${pad([...entry.designations].join(','), 10)}` +
      `${pad([...entry.providers].join(','), 16)}${pad(byId ? 'yes' : '-', 10)}${pad(byName ? 'yes' : '-', 12)}${sleeper ? 'yes' : '-'}`
  );
}

console.log('');
console.log(`${coveredEither}/${ours.size} of our injured players would get a detail line from one of these feeds.`);
console.log(`${mflIdOnly} of them are reachable by MFL id alone (no name join needed).`);
console.log(`${nameNeeded} are rostered only on Sleeper/ESPN, so the name join is what reaches them.`);
if (uncovered.length) {
  console.log(`Nobody has detail for: ${uncovered.map((e) => `${e.name} (${[...e.designations].join(',')})`).join(', ')}`);
  console.log('  — an ir-slot designation here is expected: the league put him on IR, the feed never said so.');
}

console.log('\nWhat to look for:');
console.log('  * A candidate field filled well under ~80% is a column that is usually blank.');
console.log('  * Mean length says what this costs. ~30 chars over the injured players is');
console.log('    nothing against a 400KB file; a 150-char news blurb duplicated per roster');
console.log('    copy is the case for a top-level map keyed by name instead.');
console.log('  * If the container timestamp is hours old, the feed is no fresher than the');
console.log('    4-hourly sync and a "latest update" framing is overclaiming either way.');
console.log('  * If MFL by-name covers the Sleeper-rostered players, one global map serves');
console.log('    every league and ESPN needs nothing of its own.');
