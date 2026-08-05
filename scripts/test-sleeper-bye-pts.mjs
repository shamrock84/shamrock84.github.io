#!/usr/bin/env node
// One-off test: verify Sleeper bye weeks (via the MFL team-code crosswalk)
// and season points (via summed weekly matchups) against the real SFB16
// league. Not part of the regular sync — delete once verified working.

import { mflLogin, fetchNflByeWeeks, loadSleeperPlayerMap, fetchSleeperLeagueRoster } from './lib/providers.mjs';

const league = {
  id: '1367867592919760896',
  franchiseId: '4',
  name: 'SFB16 Cloud Strife',
  type: 'redraft',
  provider: 'sleeper',
};

async function main() {
  const username = process.env.MFL_USERNAME;
  const password = process.env.MFL_PASSWORD;
  const cookie = await mflLogin(username, password);
  const byeWeeks = await fetchNflByeWeeks(cookie);
  console.log(`Bye weeks loaded: ${byeWeeks.size} teams`);
  console.log('Sample MFL bye entries (GBP, KCC, LVR):', byeWeeks.get('GBP'), byeWeeks.get('KCC'), byeWeeks.get('LVR'));

  const playerMap = await loadSleeperPlayerMap();
  const roster = await fetchSleeperLeagueRoster(league, playerMap, byeWeeks);

  console.log(`\nPlayer count: ${roster.players.length}`);
  const withBye = roster.players.filter((p) => p.bye != null);
  const withoutBye = roster.players.filter((p) => p.bye == null);
  console.log(`Players with a bye value: ${withBye.length}`);
  console.log(`Players WITHOUT a bye value: ${withoutBye.length}`, withoutBye.map((p) => `${p.name} (${p.team})`));
  console.log('\nSample players (name, team, bye, pts):');
  for (const p of roster.players.slice(0, 8)) {
    console.log(`  ${p.name} | ${p.team} | bye=${p.bye} | pts=${p.pts}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
