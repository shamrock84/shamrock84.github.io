// Prior-season Vikings schedules for vikings.html's History tab and the Admin
// tab's Seasons card. The snapshot (data/rosters.json) only ever carries the
// CURRENT season, so earlier years live in their own committed file,
// data/vikings-history.json, written by scripts/backfill-vikings-history.mjs
// (workflow: backfill-vikings-history.yml). It is its own file for the same
// reason mfl-league-meta.json is: the page downloads all of rosters.json on
// every load and this would only grow it.
//
// Shape: { generatedAt, team, seasons: { "2019": { schedule, preseason } } }
// where `schedule` is the team's regular-season entries and `preseason` its
// preseason entries, both in the snapshot's wire shape
// ({ wk, opp, home, at, tbd?, r?, pf?, pa? } or { wk, bye: true }). The page
// treats a season exactly as it treats the snapshot's, so it needs no second
// parser. Names and face values are NOT here; they live in api/vikings.js
// keyed `${season}-${wk}`.

export const FIRST_SEASON = 2016;

// Pure and separately tested (test-vikings-history.mjs). `schedules` is
// fetchNflSchedules' return value, `preseason` fetchNflPreseason's (or null
// when that read failed — an empty preseason is not an error).
export function buildSeasonEntry(schedules, preseason, team) {
  const schedule = (schedules && schedules.teams && schedules.teams[team]) || [];
  const pre = (preseason && preseason.teams && preseason.teams[team]) || [];
  return { schedule, preseason: pre };
}

// Years to (re)read: every season from FIRST_SEASON up to but not including
// the one the snapshot already carries.
export function seasonsToBackfill(currentSeason, first = FIRST_SEASON) {
  const out = [];
  for (let y = first; y < Number(currentSeason); y++) out.push(y);
  return out;
}
