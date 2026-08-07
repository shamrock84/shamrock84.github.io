#!/usr/bin/env node
// Unit tests for resolveSeason (scripts/fetch-rosters.mjs) — which season each
// league is read from during the rollover window. Pure logic with the provider
// probes injected, so this runs anywhere, including in CI on every PR.
//
// Worth pinning properly: this decides, unattended, which season's data the
// whole site shows, and both ways of getting it wrong are quiet. Roll a league
// forward too early and every card goes empty or errors; roll it forward too
// late — or backwards — and the page shows last season's rosters while looking
// perfectly healthy. There is no loud failure mode to notice.

import { resolveSeason } from './fetch-rosters.mjs';

let failures = 0;
function check(name, pass, detail = '') {
  if (pass) {
    console.log(`  ok    ${name}`);
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

// Probe doubles. `calls` counts them so the tests can assert the common path
// costs no request at all.
const calls = { mfl: 0, espn: 0 };
const probes = (mflAnswer, espnAnswer = false) => ({
  mfl: async () => { calls.mfl++; return mflAnswer; },
  espn: async () => { calls.espn++; return espnAnswer; },
});
const resetCalls = () => { calls.mfl = 0; calls.espn = 0; };

const mfl = { id: '26696' };
const espn = { id: '1966972', provider: 'espn' };
const sleeper = { id: '1367867592919760896', provider: 'sleeper' };

// ---- the common case: already there, never probed ----
resetCalls();
let r = await resolveSeason(mfl, { season: '2027' }, 2027, probes(true));
check('a league already on the target stays there', r.season === '2027');
check('...without spending a probe', calls.mfl === 0, `${calls.mfl} probe(s)`);

// ---- the rollover window ----
resetCalls();
r = await resolveSeason(mfl, { season: '2026' }, 2027, probes(false));
check('a league whose new season does not exist yet stays put', r.season === '2026', JSON.stringify(r));
check('...and is flagged as waiting', r.waiting === true);
check('...having actually asked', calls.mfl === 1);

r = await resolveSeason(mfl, { season: '2026' }, 2027, probes(true));
check('a league whose new season exists rolls forward', r.season === '2027', JSON.stringify(r));
check('...and is flagged as rolled over', r.rolledOver === true);

// The whole point of the design: two leagues, same day, different answers.
const [early, late] = await Promise.all([
  resolveSeason({ id: 'a' }, { season: '2026' }, 2027, probes(true)),
  resolveSeason({ id: 'b' }, { season: '2026' }, 2027, probes(false)),
]);
check('two leagues can sit on different seasons at once',
  early.season === '2027' && late.season === '2026',
  `${early.season} / ${late.season}`);

// ---- never backwards ----
// A transient provider failure reads as "not available", and the fallback is
// the previous season. If that previous season is AHEAD of the target, taking
// it must not drag the league back to an older one.
resetCalls();
r = await resolveSeason(mfl, { season: '2027' }, 2026, probes(false));
check('a league ahead of the target is never dragged backwards', r.season === '2027', JSON.stringify(r));
// The one that matters: last season still exists at the provider and answers a
// probe happily, so a yes must not be enough to move a league backwards.
r = await resolveSeason(mfl, { season: '2027' }, 2026, probes(true));
check('...not even when the older season really does exist', r.season === '2027', JSON.stringify(r));
check('...and it never asked', calls.mfl === 0, `${calls.mfl} probe(s)`);

// ---- first run, nothing recorded yet ----
resetCalls();
r = await resolveSeason(mfl, null, 2027, probes(true));
check('a brand-new league takes the target when it exists', r.season === '2027');
check('...and is not reported as a rollover', !r.rolledOver, JSON.stringify(r));
r = await resolveSeason(mfl, null, 2027, probes(false));
check('a brand-new league falls back to the target when the probe says no',
  r.season === '2027', JSON.stringify(r));
r = await resolveSeason(mfl, {}, 2027, probes(false));
check('a previous entry with no season recorded behaves the same', r.season === '2027');

// ---- the manual pin ----
resetCalls();
r = await resolveSeason({ ...mfl, season: '2025' }, { season: '2026' }, 2027, probes(true));
check('an explicit season in config wins over everything', r.season === '2025', JSON.stringify(r));
check('...and is flagged as pinned', r.pinned === true);
check('...and opts the league out of probing', calls.mfl === 0, `${calls.mfl} probe(s)`);
r = await resolveSeason({ ...mfl, season: 2025 }, null, 2027, probes(true));
check('a numeric pin is normalised to a string', r.season === '2025' && typeof r.season === 'string');

// ---- per provider ----
resetCalls();
r = await resolveSeason(espn, { season: '2026' }, 2027, probes(false, true));
check('ESPN is probed with the ESPN probe, not the MFL one',
  calls.espn === 1 && calls.mfl === 0, JSON.stringify(calls));
check('...and rolls forward on a yes', r.season === '2027');

// Sleeper can't be probed: a new season is a new league id there, and the old
// id keeps answering forever, so a successful request proves nothing.
resetCalls();
r = await resolveSeason(sleeper, { season: '2026' }, 2027, probes(false, false));
check('Sleeper is never probed', calls.mfl === 0 && calls.espn === 0, JSON.stringify(calls));
check('...and simply follows the target', r.season === '2027', JSON.stringify(r));

// ---- everything returns a string, since it goes straight into a URL path ----
const shapes = await Promise.all([
  resolveSeason(mfl, { season: 2026 }, 2027, probes(false)),
  resolveSeason(mfl, null, 2027, probes(true)),
  resolveSeason(sleeper, null, 2027, probes(false)),
]);
check('every result is a string season',
  shapes.every((x) => typeof x.season === 'string' && /^\d{4}$/.test(x.season)),
  JSON.stringify(shapes));

console.log(failures === 0 ? '\nAll season-rollover checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
