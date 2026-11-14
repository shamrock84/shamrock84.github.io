// ESPN's own proTeams byeWeek came back empty for every rostered player, so
// ESPN players take their bye from MFL's nflByeWeeks map (keyed by MFL's team
// codes, which differ from ESPN's for eight teams). Pins that join.
import assert from 'node:assert/strict';
import { byeWeekForTeam } from './lib/providers.mjs';

const mfl = new Map([['GBP', '5'], ['KCC', '10'], ['LVR', '8'], ['PHI', '9'], ['WAS', '12'], ['ARI', '11']]);
assert.equal(byeWeekForTeam(mfl, 'GB'), '5', 'ESPN GB -> MFL GBP');
assert.equal(byeWeekForTeam(mfl, 'KC'), '10');
assert.equal(byeWeekForTeam(mfl, 'LV'), '8');
assert.equal(byeWeekForTeam(mfl, 'PHI'), '9', 'matching codes pass straight through');
assert.equal(byeWeekForTeam(mfl, 'WAS'), '12');
assert.equal(byeWeekForTeam(new Map([['WSH', '12']]), 'WAS'), '12', 'Washington spelling variant');
assert.equal(byeWeekForTeam(mfl, 'FA'), null, 'free agent has no bye');
assert.equal(byeWeekForTeam(mfl, 'ZZZ'), null, 'unknown team');
assert.equal(byeWeekForTeam(new Map(), 'GB'), null, 'map failed to load');
assert.equal(byeWeekForTeam(undefined, 'GB'), null);
console.log('test-espn-bye-weeks: ok');
