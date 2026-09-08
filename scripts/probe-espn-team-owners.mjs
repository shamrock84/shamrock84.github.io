#!/usr/bin/env node
// Confirms whether ESPN's fantasy-league API exposes the real person behind
// each team (a "team owner" / manager name) so the Scoring card's matchup
// rows could show "Team Name (Owner)" for the two ESPN redraft leagues.
// providers.mjs had never read anything owner-shaped off ESPN before this —
// espnTeamName only reads team.name/location/nickname — so nothing here
// could be assumed without checking a real response first.
//
// CONFIRMED (2026-09-08, probe-espn-team-owners.yml run #1, both ESPN
// leagues): the community-documented shape holds exactly. A team object
// carries an `owners` array of member GUIDs, and the top-level league
// response (asked for with view=mTeam here) carries a `members` array with
// each GUID's displayName/firstName/lastName. Every team in both leagues
// resolved to a real member via `owners[0]`.
//
// Also confirmed directly against ESPN's own site (not just the API shape):
// what ESPN's UI labels "Manager" is firstName + lastName (e.g. "Christopher
// Staloch"), not displayName (that same member's login handle, "cstaloch")
// — the first version of espnOwnerName had this backwards. A member who
// never set name fields falls back to ESPN's auto-generated handle (e.g.
// "ESPNFAN2996311429"), which is simply what that member's account shows,
// not a bug in espnOwnerName (providers.mjs). espnOwnerName itself only
// keeps firstName, a deliberate display shortening for the matchup row (see
// its own comment) rather than a further finding about what the API or the
// site provide — full name data is still there in `members` if ever needed.
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
