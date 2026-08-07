#!/usr/bin/env node
// Unit tests for scoring-format detection — which FantasyPros list the ECR
// column is drawn from. Pure functions, no network, so this runs in CI.
//
// Worth pinning: twelve of eighteen leagues turned out not to be PPR, and the
// failure mode is silent. A league scored against the wrong list still shows a
// full ECR column of plausible-looking numbers; nothing errors, nothing is
// blank, the ranks are just quietly for a different game.

import { receptionPointsToFormat } from './lib/providers.mjs';
import { rankingSpecForLeague } from './lib/fantasypros.mjs';

let failures = 0;
function check(name, pass, detail = '') {
  if (pass) {
    console.log(`  ok    ${name}`);
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

// ---- the three lists FantasyPros publishes ----
check('1 per reception is PPR', receptionPointsToFormat(1) === 'PPR');
check('0.5 is half', receptionPointsToFormat(0.5) === 'HALF');
check('0 is standard', receptionPointsToFormat(0) === 'STD');

// Anything else must not be rounded to the nearest list. A league scoring 0.25
// a catch is none of the three, and picking the closest would put its ECR column
// quietly on the wrong one — the exact silent failure this guards against.
for (const odd of [0.25, 0.75, 1.5, 2, -1]) {
  check(`${odd} per reception doesn't map onto a list`, receptionPointsToFormat(odd) === null);
}
for (const bad of [null, undefined, NaN, Infinity, 'PPR']) {
  check(`${JSON.stringify(bad)} is not a format`, receptionPointsToFormat(bad) === null);
}

// ---- how a league's spec picks its scoring ----
const inSeason = new Date('2026-11-15T12:00:00Z');

check('an explicit config value wins over detection',
  rankingSpecForLeague({ type: 'redraft', scoring: 'STD', detectedScoring: 'HALF' }, inSeason).scoring === 'STD');
check('detection is used when config says nothing',
  rankingSpecForLeague({ type: 'redraft', detectedScoring: 'HALF' }, inSeason).scoring === 'HALF');
// The last resort, and the only case that should ever land on a guess.
check('PPR remains the fallback when neither is set',
  rankingSpecForLeague({ type: 'redraft' }, inSeason).scoring === 'PPR');
check('a null detection falls back rather than blanking the spec',
  rankingSpecForLeague({ type: 'redraft', detectedScoring: null }, inSeason).scoring === 'PPR');

// Detection must not disturb anything else the spec decides.
check('the ranking type is unaffected by scoring',
  rankingSpecForLeague({ type: 'dynasty', detectedScoring: 'STD' }, inSeason).type === 'ROS');
check('superflex is unaffected by scoring',
  rankingSpecForLeague({ type: 'redraft', tags: ['Superflex'], detectedScoring: 'STD' }, inSeason)
    .positions.join() === 'OP,ALL');

console.log(failures === 0 ? '\nAll scoring-format checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
