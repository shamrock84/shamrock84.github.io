// Writes data/vikings-history.json: the Vikings' regular-season and preseason
// schedule (results included) for every season from 2016 up to, but not
// including, the one data/rosters.json already carries. See
// scripts/lib/vikings-history.mjs for the shape and why it is its own file.
//
// Same ESPN public scoreboard the sync reads (lib/espn-schedules.mjs), one
// request per week per season: ~23 requests a season. ESPN's host is
// unreachable from the sandbox this repo is edited in, so this runs in Actions
// (backfill-vikings-history.yml). It keeps whatever it already had for a
// season when ESPN fails on that season, and exits non-zero only when it
// could not produce any season at all. Re-run it once a year, after the
// season rolls over, to move the finished year out of the snapshot.
//
// Run: node scripts/backfill-vikings-history.mjs

import fs from 'node:fs';
import { fetchNflSchedules, fetchNflPreseason } from './lib/espn-schedules.mjs';
import { buildSeasonEntry, seasonsToBackfill } from './lib/vikings-history.mjs';

const TEAM = 'MIN';
const OUT = 'data/vikings-history.json';

const snapshot = JSON.parse(fs.readFileSync('data/rosters.json', 'utf8'));
const current = snapshot.nflSchedules && snapshot.nflSchedules.season;
if (!current) throw new Error('data/rosters.json carries no nflSchedules.season');

let previous = { seasons: {} };
try { previous = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { /* first run */ }
const seasons = { ...(previous.seasons || {}) };

let read = 0;
for (const year of seasonsToBackfill(current)) {
  try {
    const schedules = await fetchNflSchedules({ season: year });
    // A preseason hiccup must not cost the regular season (same call the sync makes).
    const preseason = await fetchNflPreseason({ season: year, teams: [TEAM] }).catch((e) => {
      console.error(`  preseason ${year}: ${e.message}`);
      return null;
    });
    const entry = buildSeasonEntry(schedules, preseason, TEAM);
    if (!entry.schedule.some((g) => !g.bye)) throw new Error('no games for the team');
    // Keep an earlier good preseason read rather than blanking it on a failed one.
    if (!preseason && seasons[year] && seasons[year].preseason) entry.preseason = seasons[year].preseason;
    seasons[year] = entry;
    read++;
    console.log(`${year}: ${entry.schedule.filter((g) => !g.bye && g.home).length} regular home, ${entry.preseason.filter((g) => g.home).length} preseason home`);
  } catch (e) {
    console.error(`${year}: kept previous (${e.message})`);
  }
}
if (!read) throw new Error('no season could be read');

const doc = { generatedAt: new Date().toISOString(), team: TEAM, seasons };
// One season per line, like the other committed data files, for readable diffs.
const lines = Object.keys(seasons).sort().map((y) => `${JSON.stringify(y)}:${JSON.stringify(seasons[y])}`);
fs.writeFileSync(OUT, `{"generatedAt":${JSON.stringify(doc.generatedAt)},"team":${JSON.stringify(TEAM)},"seasons":{\n${lines.join(',\n')}\n}}\n`);
console.log(`Wrote ${OUT}`);
