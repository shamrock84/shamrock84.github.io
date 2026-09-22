// Unit test for selectPrimaryRankingSet in scripts/lib/fantasypros.mjs.
//
// A superflex league is spec'd to OP first (see rankingSpecForLeague), but
// FantasyPros doesn't always have that list populated — a ROS|*|OP request
// came back with zero experts and a stale last_updated on 2026-09-21, live,
// meaning nobody's currently publishing to it. attachRankings used to record
// spec.positions[0] (OP) as the league's pool key regardless, which left
// `pools['ROS|HALF|OP']` never built (attachRankings only creates a pool
// when the primary list has players) and so the ECR power-rank basis and Top
// Available both permanently TBD/empty for every superflex league — even
// though the ALL list, fetched in the same Promise.all for kickers/
// defenses/IDP, had real data the whole time.

import assert from 'node:assert/strict';
import { selectPrimaryRankingSet } from './lib/fantasypros.mjs';

const withPlayers = (n) => ({ list: new Array(n).fill({}) });
const empty = { list: [] };

// --- An empty OP list falls through to a populated ALL list -------------------
{
	const index = selectPrimaryRankingSet(['OP', 'ALL'], [empty, withPlayers(250)]);
	assert.equal(index, 1, 'picks ALL when OP came back with nobody in it');
}

// --- A populated OP list is preferred over ALL, unchanged ---------------------
// Mixing OP and ALL into one pool would interleave two rankings that don't
// compare on the same scale — this must never trigger when OP actually works.
{
	const index = selectPrimaryRankingSet(['OP', 'ALL'], [withPlayers(180), withPlayers(250)]);
	assert.equal(index, 0, 'keeps OP when it has real data');
}

// --- A non-superflex league's single-entry list always resolves to itself -----
{
	assert.equal(selectPrimaryRankingSet(['ALL'], [withPlayers(250)]), 0);
	assert.equal(selectPrimaryRankingSet(['ALL'], [empty]), 0, 'nothing to fall through to');
}

// --- Both lists empty falls back to index 0, same as before this existed ------
{
	assert.equal(selectPrimaryRankingSet(['OP', 'ALL'], [empty, empty]), 0);
}

// --- A missing or malformed set at an index is treated as empty, not a crash --
{
	assert.equal(selectPrimaryRankingSet(['OP', 'ALL'], [undefined, withPlayers(250)]), 1);
	assert.equal(selectPrimaryRankingSet([], []), 0);
}

console.log('test-ranking-set-fallback: all assertions passed');
