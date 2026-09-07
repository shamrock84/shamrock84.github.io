#!/usr/bin/env node
// Confirms whether ESPN's fantasy-league API exposes the real person behind
// each team (a "team owner" / manager name) so the Scoring card's matchup
// rows could show "Team Name (Owner)" for the two ESPN redraft leagues.
// providers.mjs has never read anything owner-shaped off ESPN — espnTeamName
// only reads team.name/location/nickname — so nothing here can be assumed
// without checking a real response first.
//
// Community documentation for ESPN's fantasy API says a team object carries
// an `owners` array of member GUIDs, and the top-level league response (once
// you ask for a view that includes it — commonly mTeam, sometimes mSettings)
// carries a `members` array with each GUID's displayName/firstName/lastName.
// None of that has been checked against a real league here.
//
// Read-only: one GET per ESPN league already in config/leagues.json, asking
// for every view that might carry `members` at once so a single request
// settles it. Requires ESPN_S2 and ESPN_SWID like every other ESPN call in
// this project — unreachable from the sandbox this repo is normally edited
// from, so a workflow run is the only place to ask.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { espnGet, espnTeamName } from './lib/providers.mjs';

const CONFIG_PATH = fileURLToPath(new URL('../config/leagues.json', import.meta.url));
const { leagues } = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));

const espnLeagues = leagues.filter((l) => l.provider === 'espn');
if (espnLeagues.length === 0) {
  console.log('No ESPN leagues in config/leagues.json — nothing to probe.');
  process.exit(0);
}

for (const league of espnLeagues) {
  console.log(`\n=== ${league.name} (${league.id}), franchise ${league.franchiseId} ===`);
  try {
    const data = await espnGet(league, 'view=mTeam&view=mSettings&view=mRoster');

    const members = data.members || [];
    console.log(`  top-level "members" present: ${members.length > 0} (count: ${members.length})`);
    if (members.length > 0) {
      console.log(`  sample member shape: ${JSON.stringify(members[0])}`);
    }

    const teams = data.teams || [];
    console.log(`  teams: ${teams.length}`);
    for (const t of teams) {
      const name = espnTeamName(t);
      const owners = t.owners || [];
      const resolved = owners.map((guid) => {
        const m = members.find((mm) => mm.id === guid);
        if (!m) return `${guid} <- NOT FOUND in members`;
        const display = m.displayName || [m.firstName, m.lastName].filter(Boolean).join(' ') || '(no name field)';
        return `${guid} -> ${display}`;
      });
      console.log(`    team ${t.id} "${name}": owners=${JSON.stringify(owners)} resolved=[${resolved.join('; ')}]`);
    }
  } catch (err) {
    console.log(`  FAILED: ${err.message}`);
  }
}
