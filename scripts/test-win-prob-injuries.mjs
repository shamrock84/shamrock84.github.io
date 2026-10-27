// Pins that a starter known not to play (Out, IR, PUP, suspended...) neither
// projects points nor keeps a matchup "live" in the win-probability model
// (isKnownOut, estimateRemainingPoints, undecidedMinutes via attachWinProbabilities).
import assert from 'node:assert/strict';
import { isKnownOut, estimateRemainingPoints, bestBallProjection } from './lib/providers.mjs';

const healthy = { secondsRemaining: 1800, points: 0, injuryStatus: null };
const ir = { secondsRemaining: 1800, points: 0, injuryStatus: 'IR' };
assert.equal(isKnownOut(ir), true);
assert.equal(isKnownOut({ ...ir, injuryStatus: 'O' }), true);
assert.equal(isKnownOut({ ...ir, injuryStatus: 'Q' }), false);
assert.equal(isKnownOut({ ...ir, injuryStatus: 'D' }), false);
assert.equal(isKnownOut(healthy), false);
// Points on the board beat a stale report.
assert.equal(isKnownOut({ ...ir, points: 4.2 }), false);

const flat = () => 20;
assert.equal(estimateRemainingPoints([ir], flat), 0);
assert.equal(estimateRemainingPoints([healthy], flat), 10);

// Best ball: an out bench/starter player adds no minutes and no projection.
const spec = { positions: { RB: { min: 1, max: 1 } }, total: 1 };
const out = bestBallProjection(
  { players: [{ ...ir, position: 'RB' }], bench: [] }, spec, flat, new Map()
);
assert.equal(out.minutes, 0);
assert.equal(out.projectedScore, 0);
console.log('test-win-prob-injuries: ok');
