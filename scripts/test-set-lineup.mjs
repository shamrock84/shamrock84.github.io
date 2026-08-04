#!/usr/bin/env node
// One-off, manually-triggered-only diagnostic — NOT part of the regular
// sync and never wired into a schedule. Currently just fetching MFL's
// interactive API-test docs page for TYPE=lineup to find the real request
// shape, before attempting any actual write.
//
// Requires MFL_USERNAME/MFL_PASSWORD env vars, same as fetch-rosters.mjs.
// Run via the "Test Set Lineup" GitHub Actions workflow (workflow_dispatch
// only), never on a schedule.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mflLogin } from './lib/providers.mjs';

const CONFIG_PATH = fileURLToPath(new URL('../config/leagues.json', import.meta.url));

async function main() {
  const username = process.env.MFL_USERNAME;
  const password = process.env.MFL_PASSWORD;
  if (!username || !password) {
    throw new Error('MFL_USERNAME and MFL_PASSWORD environment variables are required.');
  }

  const raw = await readFile(CONFIG_PATH, 'utf8');
  const leagues = JSON.parse(raw).leagues || [];
  const league = leagues.find((l) => l.lineupPilot);
  if (!league) throw new Error('No lineupPilot league configured in config/leagues.json');

  const cookie = await mflLogin(username, password);

  const year = new Date().getFullYear();
  const url = `https://www03.myfantasyleague.com/${year}/api_info?STATE=test&CCAT=import&TYPE=lineup&L=${league.id}`;
  console.log(`Fetching ${url}`);
  const res = await fetch(url, { headers: { Cookie: cookie }, redirect: 'follow' });
  const text = await res.text();
  console.log(`status ${res.status}, final url ${res.url}, length ${text.length}`);
  console.log('--- FULL BODY ---');
  console.log(text);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
