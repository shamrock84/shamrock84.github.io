#!/usr/bin/env node
// One-off diagnostic: dump Sleeper's public API shapes for a real league, to
// design the fetchSleeperLeagueRoster/Standings/Scoring functions. Sleeper's
// API needs no auth at all — delete this script and its workflow once the
// real fields are confirmed and wired into providers.mjs.

const LEAGUE_ID = '1367867592919760896';
const USERNAME = 'shamrock84';

async function get(path) {
  const res = await fetch(`https://api.sleeper.app${path}`);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const league = await get(`/v1/league/${LEAGUE_ID}`);
  console.log('=== league (top-level keys) ===');
  console.log(Object.keys(league));
  console.log('=== league core fields ===');
  console.log(JSON.stringify({
    name: league.name,
    season: league.season,
    status: league.status,
    total_rosters: league.total_rosters,
    roster_positions: league.roster_positions,
    scoring_settings_keys: Object.keys(league.scoring_settings || {}),
    previous_league_id: league.previous_league_id,
  }, null, 2));

  const users = await get(`/v1/league/${LEAGUE_ID}/users`);
  console.log('=== users (count) ===', users.length);
  console.log('=== users[0] shape ===');
  console.log(JSON.stringify(users[0], null, 2));
  const me = users.find((u) => u.display_name === USERNAME || u.username === USERNAME);
  console.log('=== matched user for username', USERNAME, '===');
  console.log(JSON.stringify(me, null, 2));

  const rosters = await get(`/v1/league/${LEAGUE_ID}/rosters`);
  console.log('=== rosters (count) ===', rosters.length);
  console.log('=== rosters[0] shape ===');
  console.log(JSON.stringify(rosters[0], null, 2));
  if (me) {
    const myRoster = rosters.find((r) => r.owner_id === me.user_id);
    console.log('=== my roster ===');
    console.log(JSON.stringify(myRoster, null, 2));
  }

  const state = await get('/v1/state/nfl');
  console.log('=== state/nfl ===');
  console.log(JSON.stringify(state, null, 2));

  const week = state.week || 1;
  try {
    const matchups = await get(`/v1/league/${LEAGUE_ID}/matchups/${week}`);
    console.log(`=== matchups week ${week} (count) ===`, matchups.length);
    console.log('=== matchups[0] shape ===');
    console.log(JSON.stringify(matchups[0], null, 2));
  } catch (err) {
    console.log('matchups fetch failed:', err.message);
  }

  // Players DB is huge (~5MB) — just sample one player's shape + total count.
  const players = await get('/v1/players/nfl');
  const ids = Object.keys(players);
  console.log('=== players/nfl total count ===', ids.length);
  const sampleId = rosters[0]?.players?.[0] || ids[0];
  console.log('=== sample player shape (id', sampleId, ') ===');
  console.log(JSON.stringify(players[sampleId], null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
