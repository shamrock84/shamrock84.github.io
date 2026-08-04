#!/usr/bin/env node
// One-off, manually-triggered-only test for submitMflLineup — NOT part of
// the regular sync (scripts/fetch-rosters.mjs) and never wired into a
// schedule. Re-submits the exact current starters for the lineupPilot
// league (a no-op if the API call format is correct) and re-fetches
// afterward to confirm nothing actually changed, instead of trusting a
// 200 response at face value — this is a write against a real team.
//
// Requires MFL_USERNAME/MFL_PASSWORD env vars, same as fetch-rosters.mjs.
// Run via the "Test Set Lineup" GitHub Actions workflow (workflow_dispatch
// only), never on a schedule.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mflLogin, fetchMflLineup, submitMflLineup } from './lib/providers.mjs';

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

  // TEMP DIAGNOSTIC — MFL rejected TYPE=setLineup outright ("Invalid Data
  // Type"), meaning the type name itself is wrong, not just a param. Pull
  // MFL's own API docs page (reachable from GH Actions' network, unlike the
  // sandbox this was developed in) to find the real type name instead of
  // guessing again.
  try {
    const year = new Date().getFullYear();
    const docRes = await fetch(`https://api.myfantasyleague.com/${year}/api_info?L=${league.id}`, {
      headers: { Cookie: cookie },
    });
    const docText = await docRes.text();
    console.log(`[docs-debug] api_info status ${docRes.status}, length ${docText.length}`);
    for (const needle of ['setLineup', 'TYPE=import', 'import?TYPE', 'Import Commands', 'STARTERS']) {
      const idx = docText.indexOf(needle);
      console.log(`[docs-debug] indexOf("${needle}") = ${idx}`);
      if (idx !== -1) {
        console.log(`[docs-debug] context: ${docText.slice(Math.max(0, idx - 150), idx + 500)}`);
      }
    }
  } catch (err) {
    console.log(`[docs-debug] api_info fetch failed: ${err.message}`);
  }

  console.log(`Fetching current starters for ${league.name}...`);
  const before = await fetchMflLineup(league, cookie);
  console.log(`Current starters (week ${before.week}): ${before.starterIds.join(', ')}`);

  if (before.starterIds.length === 0) {
    throw new Error('No current starters found — aborting rather than submitting an empty lineup.');
  }

  console.log(`Re-submitting the SAME ${before.starterIds.length} starters (no-op test)...`);
  const result = await submitMflLineup(league, cookie, before.starterIds, before.week);
  console.log(`submitMflLineup HTTP status: ${result.status} (ok: ${result.ok})`);
  console.log(`submitMflLineup raw body:\n${result.bodyText}`);

  console.log('Re-fetching to verify nothing changed...');
  const after = await fetchMflLineup(league, cookie);
  console.log(`Starters after submit (week ${after.week}): ${after.starterIds.join(', ')}`);

  const beforeSet = new Set(before.starterIds);
  const afterSet = new Set(after.starterIds);
  const same = beforeSet.size === afterSet.size && [...beforeSet].every((id) => afterSet.has(id));
  console.log(
    same
      ? 'VERIFIED: starters unchanged after the no-op submit. Safe to build on.'
      : 'WARNING: starters CHANGED after the no-op submit — do NOT trust this endpoint yet.'
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
