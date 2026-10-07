#!/usr/bin/env node
// Asks whether MFL's API hands out a franchise's cap Total / Cap Room, or the
// rule for how much of an IR player's salary counts, so the page could read
// them instead of computing them (capSummaryNumbers in myffl.html).
//
// Why this exists: the page's cap math once left IR out and disagreed with
// MFL's roster page by exactly half of an IR player's salary ($25.00 IR ->
// $12.50, on SuperCap). The fix was a per-league irSalaryPercent in config,
// made without ever checking whether MFL exposes the total. Nothing in
// providers.mjs reads one: the sync takes per-player `salary` (TYPE=rosters),
// `salaryCapAmount` (TYPE=league) and sums TYPE=salaryAdjustments itself.
//
// What it does, per salary-cap league (set PROBE_LEAGUE_ID to narrow to one):
//   1. Reads TYPE=league, TYPE=rosters (our franchise), TYPE=salaryAdjustments
//      and a handful of guessed export names, all against the league's own
//      baseURL (the generic host drops a privileged session at random — see
//      probe-mfl-owner-name.mjs RUN 4).
//   2. Computes the numbers the page computes: active salaries, adjustments,
//      IR salary, and Total / Cap Room at IR 0%, 50% and 100%.
//   3. Walks every response for any number equal to one of those, printing the
//      path it sits at. A hit on the Total or Cap Room is the answer; a hit on
//      the IR charge says where MFL keeps it.
//   4. Prints every key in the league export that looks salary/cap/IR/taxi
//      shaped, which is where a percentage setting would live.
//
// Reading the output: "MATCH total@50%" at a path means MFL serves the figure
// itself. No matches, and nothing salary-shaped in the league export, means
// the page has to compute it and irSalaryPercent stays.
//
// RUN 1: not yet run. Dispatch probe-mfl-cap-totals.yml and record the verdict
// here, the way the other probes do.
//
// Read-only: a few GETs per salary-cap league.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mflLogin, mflGet, seasonOf } from './lib/providers.mjs';

const CONFIG_PATH = fileURLToPath(new URL('../config/leagues.json', import.meta.url));
const { leagues } = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));

const only = process.env.PROBE_LEAGUE_ID;
const targets = leagues.filter((l) => (!l.provider || l.provider === 'mfl') && l.type === 'salarycap' && (!only || l.id === only));
if (targets.length === 0) {
  console.log('No matching MFL salary-cap leagues in config/leagues.json — nothing to probe.');
  process.exit(0);
}

const SHAPED = /sal|cap|reserve|taxi|contract|\bir\b|_ir|ir_|injur|relief|penalt|waiv|bid/i;
// Guessed export names. An unknown TYPE comes back as an error object or a
// non-200, both of which are results here, not failures.
const CANDIDATE_TYPES = ['salaries', 'salaryCap', 'capSpace', 'franchiseSalaries', 'leagueStandings', 'assets'];

const asArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const money = (n) => Number(n.toFixed(2));

function walk(node, path, visit) {
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`, visit);
  } else {
    visit(path, node);
  }
}

function shapedKeys(node) {
  const out = [];
  walk(node, '', (path, value) => {
    const key = path.split('.').pop();
    if (SHAPED.test(key)) out.push(`${path} = ${JSON.stringify(value)}`);
  });
  return out;
}

async function hostGet(league, path, cookie, host) {
  try {
    return await mflGet(path, cookie, seasonOf(league), 1, host);
  } catch (err) {
    return { __failed: err.message };
  }
}

const cookie = await mflLogin(process.env.MFL_USERNAME, process.env.MFL_PASSWORD);
const verdicts = [];

for (const league of targets) {
  console.log(`\n=== ${league.name} (${league.id}, our franchiseId=${league.franchiseId}) ===`);
  const generic = await hostGet(league, `/export?TYPE=league&L=${league.id}&JSON=1`, cookie);
  const baseURL = generic?.league?.baseURL;
  if (!baseURL) {
    console.log(`  no baseURL on the league object (${JSON.stringify(generic).slice(0, 200)}) — skipping.`);
    verdicts.push(`${league.name}: could not read league`);
    continue;
  }
  const host = baseURL;
  const get = (p) => hostGet(league, p, cookie, host);

  const leagueData = await get(`/export?TYPE=league&L=${league.id}&JSON=1`);
  const rosters = await get(`/export?TYPE=rosters&L=${league.id}&FRANCHISE=${league.franchiseId}&JSON=1`);
  const adjustments = await get(`/export?TYPE=salaryAdjustments&L=${league.id}&JSON=1`);

  const { franchises, divisions, ...leagueRest } = leagueData?.league || {};
  console.log('  [TYPE=league] league-level object (minus franchises/divisions):');
  console.log(`    ${JSON.stringify(leagueRest)}`);
  const franchiseList = asArray(franchises?.franchise);
  const ours = franchiseList.find((f) => f.id === league.franchiseId);
  console.log(`  [TYPE=league] OUR franchise object: ${JSON.stringify(ours)}`);

  const franchise = asArray(rosters?.rosters?.franchise).find((f) => f.id === league.franchiseId) || asArray(rosters?.rosters?.franchise)[0];
  const { player, ...franchiseRest } = franchise || {};
  console.log(`  [TYPE=rosters] franchise-level fields (minus player list): ${JSON.stringify(franchiseRest)}`);
  const players = asArray(player);
  const byStatus = {};
  for (const p of players) (byStatus[p.status || 'ROSTER'] ||= []).push(p);
  for (const [status, list] of Object.entries(byStatus)) {
    console.log(`  [TYPE=rosters] ${status}: ${list.length} players; raw sample ${JSON.stringify(list[0])}`);
  }

  // The numbers the page computes, from the same fields it reads.
  const sum = (list) => (list || []).reduce((a, p) => a + (Number(p.salary) || 0), 0);
  const active = sum(byStatus.ROSTER);
  const irSalary = sum(byStatus.INJURED_RESERVE);
  const taxiSalary = sum(byStatus.TAXI_SQUAD);
  const adj = asArray(adjustments?.salaryAdjustments?.salaryAdjustment)
    .filter((r) => r.franchise_id === league.franchiseId)
    .reduce((a, r) => a + (Number(r.amount) || 0), 0);
  const cap = Number(leagueRest.salaryCapAmount) || null;
  console.log(`  computed: active=${money(active)} adjustments=${money(adj)} IR salary=${money(irSalary)} taxi salary=${money(taxiSalary)} cap=${cap}`);

  // value -> label. Several labels can share a value (IR 0 makes totals equal).
  const wanted = new Map();
  const want = (label, value) => {
    if (value == null || !Number.isFinite(value) || value === 0) return;
    const key = money(value);
    wanted.set(key, [...(wanted.get(key) || []), label]);
  };
  for (const pct of [0, 50, 100]) {
    const total = active + adj + irSalary * pct / 100;
    want(`total@${pct}%`, total);
    if (cap != null) want(`capRoom@${pct}%`, cap - total);
  }
  want('IR salary', irSalary);
  want('IR charge@50%', irSalary / 2);
  want('active+adj', active + adj);
  console.log(`  looking for: ${[...wanted].map(([v, l]) => `${v} (${l.join('/')})`).join('; ')}`);

  const responses = { 'TYPE=league': leagueData, 'TYPE=rosters': rosters, 'TYPE=salaryAdjustments': adjustments };
  for (const type of CANDIDATE_TYPES) {
    const extra = type === 'leagueStandings' || type === 'assets' ? `&L=${league.id}` : `&L=${league.id}&FRANCHISE=${league.franchiseId}`;
    const data = await get(`/export?TYPE=${type}${extra}&JSON=1`);
    responses[`TYPE=${type}`] = data;
    const head = JSON.stringify(data).slice(0, 220);
    console.log(`  [TYPE=${type}] ${data?.__failed ? `FAILED ${data.__failed}` : data?.error ? `error ${JSON.stringify(data.error)}` : head}`);
  }

  const matches = [];
  for (const [name, data] of Object.entries(responses)) {
    walk(data, name, (path, value) => {
      const n = Number(value);
      if (value === '' || value == null || !Number.isFinite(n)) return;
      const labels = wanted.get(money(n));
      if (labels) matches.push(`${path} = ${value}  <- ${labels.join('/')}`);
    });
  }
  // A franchise-keyed hit is far more telling than a stray equal number, so
  // matches inside other franchises' rows are kept but are the reader's call.
  console.log(`  MATCHES (${matches.length}):`);
  for (const m of matches) console.log(`    MATCH ${m}`);

  const shaped = shapedKeys(leagueRest);
  console.log(`  salary/cap/IR/taxi-shaped keys in the league-level object (${shaped.length}):`);
  for (const s of shaped) console.log(`    ${s}`);

  const served = matches.some((m) => /total@|capRoom@/.test(m) && !/IR salary/.test(m));
  verdicts.push(`${league.name}: ${served ? 'a total/cap-room-shaped number appears in an API response — check the MATCH lines' : 'no total or cap room found in any response'}; ${shaped.length} shaped league keys`);
}

console.log('\n=== verdict ===');
for (const v of verdicts) console.log(v);
