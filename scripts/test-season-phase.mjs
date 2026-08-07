#!/usr/bin/env node
// Unit tests for the NFL-calendar rules behind the automatic ranking set
// (scripts/lib/fantasypros.mjs). Pure date arithmetic, no network and no
// secrets, so this runs anywhere — including in CI on every PR.
//
// Worth pinning: these two boundaries decide, unattended, which FantasyPros
// list the ECR column shows all year. Getting them wrong is invisible — the
// column still fills in, just with preseason draft ranks in November, or with
// an empty rest-of-season list in June. The dates below are the real NFL
// kickoffs and Super Bowls, so a "simplification" that breaks the Labor Day
// step or the second-Sunday rule fails here rather than in the wild.

import { nflSeasonPhase, automaticRankingType, rankingSpecForLeague } from './lib/fantasypros.mjs';

let failures = 0;
function check(name, pass, detail = '') {
  if (pass) {
    console.log(`  ok    ${name}`);
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

const at = (iso) => new Date(`${iso}T12:00:00Z`);

// ---- the two boundaries, against the real schedule ----
// Kickoff is the Thursday after Labor Day. Taking "the first Thursday in
// September" instead is a week early whenever September opens on a Thursday,
// which is what 2024 below is here to catch.
const kickoffs = [
  ['2024-09-05', 2024], // Labor Day Mon Sep 2 — September starts on a Sunday
  ['2025-09-04', 2025], // Labor Day Mon Sep 1 — September starts on a Monday
  ['2026-09-10', 2026], // Labor Day Mon Sep 7 — September starts on a Tuesday
];
for (const [iso, season] of kickoffs) {
  const day = new Date(`${iso}T00:00:00Z`);
  const before = new Date(day.getTime() - 1000);
  check(`${season}: in season on kickoff day (${iso})`, nflSeasonPhase(day).inSeason === true);
  check(`${season}: still offseason the moment before kickoff`, nflSeasonPhase(before).inSeason === false);
  check(`${season}: kickoff belongs to the ${season} season`, nflSeasonPhase(day).season === season);
}

// Super Bowl is the second Sunday in February.
const superBowls = [
  ['2025-02-09', 2024], // LIX
  ['2026-02-08', 2025], // LX
  ['2027-02-14', 2026], // LXI
];
for (const [iso, season] of superBowls) {
  const gameDay = at(iso);
  const dayAfter = new Date(at(iso).getTime() + 24 * 60 * 60 * 1000);
  check(`Super Bowl ${iso}: still in season on game day`, nflSeasonPhase(gameDay).inSeason === true);
  check(`Super Bowl ${iso}: game day still counts as the ${season} season`, nflSeasonPhase(gameDay).season === season);
  check(`Super Bowl ${iso}: offseason the day after`, nflSeasonPhase(dayAfter).inSeason === false);
  // The offseason looks forward: rankings are for the season about to be
  // played, not the one that just finished.
  check(`Super Bowl ${iso}: the day after looks ahead to ${season + 1}`, nflSeasonPhase(dayAfter).season === season + 1);
}

// ---- the season year, which is not the calendar year in January ----
// The bug this guards against: asking FantasyPros for next season's ROS list
// during the playoffs, which comes back empty and blanks the ECR column.
check('January belongs to the previous season', nflSeasonPhase(at('2026-01-15')).season === 2025);
check('January is in season', nflSeasonPhase(at('2026-01-15')).inSeason === true);
check('June belongs to the coming season', nflSeasonPhase(at('2026-06-15')).season === 2026);
check('June is the offseason', nflSeasonPhase(at('2026-06-15')).inSeason === false);
check('November belongs to the current season', nflSeasonPhase(at('2026-11-15')).season === 2026);

// ---- what each league type gets, and when ----
const dynasty = { type: 'dynasty' };
const salarycap = { type: 'salarycap' };
const draftonly = { type: 'draftonly' };
const redraft = { type: 'redraft' };
const inSeason = at('2026-11-15');
const offseason = at('2026-06-15');

for (const league of [dynasty, salarycap, draftonly, redraft]) {
  check(`${league.type} gets ROS in season`, automaticRankingType(league, inSeason) === 'ROS');
}
check('dynasty gets DYNASTY in the offseason', automaticRankingType(dynasty, offseason) === 'DYNASTY');
// Deliberate: salary-cap leagues are run on a redraft cadence here, so they sit
// with draft-only and redraft rather than with dynasty. See fantasypros.mjs.
for (const league of [salarycap, draftonly, redraft]) {
  check(`${league.type} gets DRAFT in the offseason`, automaticRankingType(league, offseason) === 'DRAFT');
}

// ---- an explicit rankingType always wins, in both directions ----
// This is the manual override: it opts a league out of the seasonal flip
// entirely rather than merely changing what it flips between.
check('a pinned DYNASTY survives the season starting',
  rankingSpecForLeague({ type: 'dynasty', rankingType: 'DYNASTY' }, inSeason).type === 'DYNASTY');
check('a pinned ROS survives the offseason',
  rankingSpecForLeague({ type: 'redraft', rankingType: 'ROS' }, offseason).type === 'ROS');
check('a pinned WEEKLY is left alone',
  rankingSpecForLeague({ type: 'redraft', rankingType: 'WEEKLY' }, inSeason).type === 'WEEKLY');

// ---- the rest of the spec is untouched by any of this ----
check('scoring still defaults to PPR', rankingSpecForLeague(redraft, inSeason).scoring === 'PPR');
check('scoring is still overridable',
  rankingSpecForLeague({ ...redraft, scoring: 'HALF' }, inSeason).scoring === 'HALF');
check('superflex still gets the OP list first',
  rankingSpecForLeague({ ...redraft, tags: ['Superflex'] }, inSeason).positions.join() === 'OP,ALL');
check('non-superflex still gets ALL only',
  rankingSpecForLeague(redraft, inSeason).positions.join() === 'ALL');

// ---- no argument means now, and now is always somewhere sensible ----
const live = nflSeasonPhase();
check('a bare call returns a usable phase',
  typeof live.inSeason === 'boolean' && Number.isInteger(live.season),
  JSON.stringify(live));
check('a bare call agrees with an explicit new Date()',
  nflSeasonPhase(new Date()).inSeason === live.inSeason);

// Every day of a decade lands in exactly one phase with a sane season year —
// catches an off-by-one that only bites on one weekday of one week.
let sweepBad = null;
for (let t = Date.UTC(2022, 0, 1); t < Date.UTC(2032, 0, 1); t += 24 * 60 * 60 * 1000) {
  const d = new Date(t);
  const { inSeason, season } = nflSeasonPhase(d);
  const year = d.getUTCFullYear();
  const ok = typeof inSeason === 'boolean'
    && (season === year || (season === year - 1 && d.getUTCMonth() <= 1 && inSeason));
  if (!ok) { sweepBad = `${d.toISOString().slice(0, 10)} → ${JSON.stringify({ inSeason, season })}`; break; }
}
check('every day from 2022 to 2031 resolves sanely', sweepBad === null, sweepBad || '');

console.log(failures === 0 ? '\nAll season-phase checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
