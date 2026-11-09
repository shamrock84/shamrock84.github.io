// Prior-season Vikings schedules for vikings.html's History tab and the Admin
// tab's Seasons card. The snapshot (data/rosters.json) only ever carries the
// CURRENT season, so earlier years live in their own committed file,
// data/vikings-history.json, written by scripts/backfill-vikings-history.mjs
// (workflow: backfill-vikings-history.yml). It is its own file for the same
// reason mfl-league-meta.json is: the page downloads all of rosters.json on
// every load and this would only grow it.
//
// Shape: { generatedAt, team, seasons: { "2019": { schedule, preseason,
// postseason } } } where `schedule` is the team's regular-season entries,
// `preseason` its preseason entries and `postseason` its playoff entries
// (wild card, divisional, conference rounds; `wk` is the round, 1-3), all in the snapshot's wire shape
// ({ wk, opp, home, at, tbd?, r?, pf?, pa? } or { wk, bye: true }). The page
// treats a season exactly as it treats the snapshot's, so it needs no second
// parser. Names and face values are NOT here; they live in api/vikings.js
// keyed `${season}-${wk}`.

export const FIRST_SEASON = 2007;

// Pure and separately tested (test-vikings-history.mjs). `schedules` is
// fetchNflSchedules' return value, `preseason` fetchNflPreseason's (or null
// when that read failed — an empty preseason is not an error). `postseason` is
// the same for the playoffs, with one difference that matters: it is left OFF
// the entry when that read failed (null), because the page treats a present
// list — even an empty one — as "the feed answered, a team with no home
// playoff game has none", and an absent one as "unknown, let the manager type
// the rows". Don't default it to [].
export function buildSeasonEntry(schedules, preseason, team, postseason = null) {
  const schedule = (schedules && schedules.teams && schedules.teams[team]) || [];
  const pre = (preseason && preseason.teams && preseason.teams[team]) || [];
  const entry = { schedule, preseason: pre };
  if (postseason) entry.postseason = (postseason.teams && postseason.teams[team]) || [];
  return entry;
}

// Years to (re)read: every season from FIRST_SEASON up to but not including
// the one the snapshot already carries.
export function seasonsToBackfill(currentSeason, first = FIRST_SEASON) {
  const out = [];
  for (let y = first; y < Number(currentSeason); y++) out.push(y);
  return out;
}
