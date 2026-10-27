// Pins that a starter known not to play (Out, IR, PUP, suspended...) neither
// projects points nor keeps a matchup "live" in the win-probability model
// (isKnownOut, estimateRemainingPoints, undecidedMinutes via attachWinProbabilities).
import assert from 'node:assert/strict';
import { isKnownOut, estimateRemainingPoints, bestBallProjection, attachWinProbabilities } from './lib/providers.mjs';

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
// A team whose only player left is out: minutes drop to 0, the matchup
// resolves (100/0 rather than the 1/99 clamp) and "min left" agrees.
const mk = (id, score, minutes, players) => ({ franchiseId: id, score, minutesRemaining: minutes, players });
const me = mk('1', 120, 0, [{ ...healthy, secondsRemaining: 0, points: 20 }]);
const opp = mk('2', 30, 30, [{ ...ir, secondsRemaining: 1800 }]);
attachWinProbabilities([me, opp], [{ teamIds: ['1', '2'] }], flat);
assert.equal(me.winProb, 100);
assert.equal(opp.winProb, 0);
assert.equal(opp.minutesRemaining, 0);
// Same matchup with him healthy stays live and keeps his minutes.
const opp2 = mk('2', 30, 30, [{ ...healthy, secondsRemaining: 1800 }]);
const me2 = mk('1', 120, 0, [{ ...healthy, secondsRemaining: 0, points: 20 }]);
attachWinProbabilities([me2, opp2], [{ teamIds: ['1', '2'] }], flat);
assert.equal(opp2.minutesRemaining, 30);
assert.ok(me2.winProb < 100);
console.log('test-win-prob-injuries: ok');
