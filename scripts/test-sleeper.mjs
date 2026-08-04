#!/usr/bin/env node
// One-off test of the new Sleeper provider functions against the real
// SFB16 league, before wiring them into the full sync. Not part of the
// regular sync — delete once the real integration is verified working.

import {
  loadSleeperPlayerMap,
  fetchSleeperLeagueRoster,
  fetchSleeperStandings,
  fetchSleeperScoring,
} from './lib/providers.mjs';

const league = {
  id: '1367867592919760896',
  franchiseId: '4',
  name: 'SFB16 Cloud Strife',
  type: 'redraft',
  provider: 'sleeper',
};

async function main() {
  console.log('Loading Sleeper player map...');
  const playerMap = await loadSleeperPlayerMap();
  console.log(`Player map size: ${playerMap.size}`);

  console.log('\nFetching roster...');
  const roster = await fetchSleeperLeagueRoster(league, playerMap);
  console.log(`League name: ${roster.leagueName}`);
  console.log(`Team name: ${roster.teamName}`);
  console.log(`URL: ${roster.url}`);
  console.log(`Player count: ${roster.players.length}`);
  console.log('Sample players:', roster.players.slice(0, 5).map((p) => `${p.name} (${p.position}, ${p.team}, ${p.status})`));
  const unknownNames = roster.players.filter((p) => p.name.startsWith('Unknown Player'));
  console.log(`Unresolved player names: ${unknownNames.length}`);

  console.log('\nFetching standings...');
  const standings = await fetchSleeperStandings(league);
  console.log(`Standings count: ${standings.length}`);
  console.log('My row:', standings.find((s) => s.isMe));

  console.log('\nFetching scoring...');
  try {
    const scoring = await fetchSleeperScoring(league);
    console.log(`Scoring week: ${scoring.week}, teams: ${scoring.teams.length}`);
    console.log('My score row:', scoring.teams.find((t) => t.isMe));
  } catch (err) {
    console.log(`Scoring fetch: ${err.message} (expected if preseason with no matchups yet)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
