#!/usr/bin/env node
// Asks where MFL keeps the IR-eligibility rule, shown in its settings UI as
// "Player Must Be Classified As Before Being Deactivated: IR or out or
// doubtful or questionable". Nothing in this project reads it: parseRosterLimits
// takes only the IR slot count (`injuredReserve`), and `includeIRWithSalary`
// is the cap-charge share, not eligibility.
//
// Dumps the unfiltered TYPE=league object (minus franchises/divisions), from
// both the shared host and the league's own baseURL (see probe-mfl-owner-name.mjs
// for why the host matters), then flattens it and prints every key or value
// that looks IR/injury/deactivate-shaped. Compare two leagues with different
// UI settings (LEAGUE_ID=<id>) to see which field changes with the rule.
//
// Defaults to MNMx Dynasty (26696). Read-only: two TYPE=league GETs.
// RESULTS: not yet run.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mflLogin, mflGet, seasonOf } from './lib/providers.mjs';

const CONFIG_PATH = fileURLToPath(new URL('../config/leagues.json', import.meta.url));
const { leagues } = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));

const leagueId = process.env.LEAGUE_ID || '26696';
const league = leagues.find((l) => String(l.id) === leagueId);
if (!league) {
  console.log(`League ${leagueId} is not in config/leagues.json.`);
  process.exit(1);
}

const SUSPECT = /(^|[^a-z])(ir|injur|reserve|deactiv|eligib|classif|status|questionable|doubtful|out)/i;

function flatten(value, path, out) {
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) flatten(v, path ? `${path}.${k}` : k, out);
  } else {
    out.push([path, value]);
  }
  return out;
}

function report(label, data) {
  const { franchises, divisions, ...rest } = data?.league || {};
  console.log(`\n--- ${label} ---`);
  console.log('FULL league-level object (minus franchises/divisions):');
  console.log(JSON.stringify(rest, null, 2));
  const hits = flatten(rest, '', []).filter(([p, v]) => SUSPECT.test(p) || SUSPECT.test(String(v)));
  console.log(`\nIR/injury-shaped paths or values (${hits.length}):`);
  for (const [p, v] of hits) console.log(`  ${p} = ${JSON.stringify(v)}`);
  return rest;
}

const cookie = await mflLogin(process.env.MFL_USERNAME, process.env.MFL_PASSWORD);
const year = seasonOf(league);
console.log(`=== ${league.name} (${league.id}, type=${league.type}, season ${year}) ===`);

const generic = await mflGet(`/export?TYPE=league&L=${league.id}&JSON=1`, cookie, year);
const rest = report('generic host', generic);

if (rest.baseURL) {
  const res = await fetch(`${rest.baseURL}/${year}/export?TYPE=league&L=${league.id}&JSON=1`, {
    headers: { Cookie: cookie },
    redirect: 'follow',
  });
  if (res.ok) report(`own host ${rest.baseURL}`, await res.json());
  else console.log(`\nown host ${rest.baseURL} failed (${res.status})`);
}
