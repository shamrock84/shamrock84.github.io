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
// costs no request at all, and `asked` records which seasons were tried so the
// walk-back can be checked by more than its final answer.
//
// Probes are tri-state: true, false (definitely absent), null (couldn't tell).
// An answer can be a plain value for every season, or a {season: answer} map.
const calls = { mfl: 0, espn: 0 };
let asked = [];
const answerFor = (answer, season) =>
  (answer && typeof answer === 'object' ? (season in answer ? answer[season] : false) : answer);
const probes = (mflAnswer, espnAnswer = false) => ({
  mfl: async (_l, season) => { calls.mfl++; asked.push(season); return answerFor(mflAnswer, season); },
  espn: async (_l, season) => { calls.espn++; asked.push(season); return answerFor(espnAnswer, season); },
});
const resetCalls = () => { calls.mfl = 0; calls.espn = 0; asked = []; };

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

// The case that sent this back for a second pass: a league whose new site isn't
// up yet, on a first sync, has no recorded season to fall back to. Defaulting to
// the target would show an empty season; it should land on the one actually
// last played.
resetCalls();
r = await resolveSeason(mfl, null, 2027, probes({ 2027: false, 2026: true }));
check('with no history and no target season, walks back to the season that exists',
  r.season === '2026', JSON.stringify(r));
check('...and is flagged as a fallback', r.fellBack === true);
check('...having tried the target first, then the one before',
  asked.join() === '2027,2026', asked.join());

resetCalls();
r = await resolveSeason(mfl, null, 2027, probes({ 2027: false, 2026: false, 2025: true }));
check('walks back more than one season if it has to', r.season === '2025', JSON.stringify(r));

resetCalls();
r = await resolveSeason(mfl, null, 2027, probes(false));
check('gives up on the target when nothing in range answers', r.season === '2027', JSON.stringify(r));
check('...flagged unresolved rather than silently fine', r.unresolved === true);
check('...and the walk-back is bounded', calls.mfl === 3, `${calls.mfl} probe(s): ${asked.join()}`);

// ---- a recorded season that never actually worked must not stick ----
// The bug this guards: the first sync records a season for every league,
// including ones it couldn't verify. If the recorded season alone short-circuits
// the probe, a league that never had that season is stranded there forever.
resetCalls();
r = await resolveSeason(mfl, { season: '2027', error: 'No roster data returned for this franchise' }, 2027,
  probes({ 2027: false, 2026: true }));
check('a league erroring on its recorded season is re-checked, not trusted',
  r.season === '2026', JSON.stringify(r));
check('...and it did ask', calls.mfl > 0);

resetCalls();
r = await resolveSeason(mfl, { season: '2027', error: null }, 2027, probes(false));
check('a league fetching cleanly on the target is still never re-probed',
  r.season === '2027' && calls.mfl === 0, `${calls.mfl} probe(s)`);

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

// ---- "couldn't tell" is not "absent" ----
// A 429 from the probe burst, or an ESPN 401 from stale cookies, must not be
// read as a season disappearing — otherwise a transient failure walks a healthy
// league backwards, which is the one outcome with no loud symptom.
resetCalls();
r = await resolveSeason(mfl, { season: '2026' }, 2027, probes(null));
check('an unknown answer leaves a settled league exactly where it was', r.season === '2026', JSON.stringify(r));
check('...flagged as a failed probe, not as waiting', r.probeFailed === true && !r.waiting);

resetCalls();
r = await resolveSeason(mfl, null, 2027, probes(null));
check('an unknown answer on a first sync changes nothing', r.season === '2027', JSON.stringify(r));
check('...and does not trigger the walk-back', calls.mfl === 1, `${calls.mfl} probe(s)`);

resetCalls();
r = await resolveSeason(mfl, null, 2027, probes({ 2027: false, 2026: null, 2025: true }));
check('an unknown partway through the walk-back stops it rather than skipping past',
  r.season === '2027' && r.probeFailed === true, JSON.stringify(r));

resetCalls();
r = await resolveSeason(espn, { season: '2026' }, 2027, probes(false, null));
check('a stale-cookie ESPN answer leaves the league put', r.season === '2026', JSON.stringify(r));

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
