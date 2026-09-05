// Unit test for MFL request pacing and the TYPE=league dedup —
// setMflRequestInterval/mflGet, fetchStandings and fetchLeagueRoster in
// scripts/lib/providers.mjs.
//
// Both halves exist for the same reason: across 29 committed snapshots of
// data/rosters.json, 24 carried at least one 429, and they clustered in the
// leagues at the tail of each pass. The sync had no send-rate floor at all —
// every request went out the instant the previous one resolved — and it was
// spending a fifth of its budget re-reading a TYPE=league response it had
// already fetched.
//
// Both failure modes are silent. Pacing that quietly stops applying just means
// 429s come back, which reads as MFL being moody rather than as a bug here; a
// dedup that quietly stops deduping costs requests nobody is counting. Neither
// is reachable from a sandbox against the real API, so this drives a stubbed
// fetch and asserts on what was actually sent and when.
//
// The concurrency case is the one that matters most. Both fetchLeagueRoster and
// fetchStandings issue their requests through Promise.all, so the gate has to
// hold for callers that start together, not just for a serial loop. A plain
// "has enough time passed since the last request?" check passes a serial test
// and fails this one: two concurrent callers read the same timestamp, both
// decide they are clear to go, and send the exact burst being prevented.

import assert from 'node:assert/strict';
import {
	mflGet,
	setMflRequestInterval,
	fetchStandings,
	fetchLeagueRoster,
	mflFranchiseNames,
} from './lib/providers.mjs';

// Records the moment each request *starts*, which is what the gate spaces out.
// Responses resolve immediately so nothing but the gate can account for a gap.
function stubFetch(handler) {
	const starts = [];
	const paths = [];
	globalThis.fetch = async (url) => {
		starts.push(Date.now());
		paths.push(String(url));
		return handler(String(url));
	};
	return { starts, paths };
}

const okJson = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

const gaps = (starts) => starts.slice(1).map((t, i) => t - starts[i]);

const originalFetch = globalThis.fetch;

// --- Serial calls are spaced by at least the interval -------------------------
{
	const { starts } = stubFetch(() => okJson({ ok: 1 }));
	setMflRequestInterval(40);
	for (let i = 0; i < 5; i++) await mflGet(`/export?TYPE=league&L=${i}&JSON=1`, null, 2026);
	assert.equal(starts.length, 5);
	// Timers fire no earlier than asked but can fire late, so the floor is the
	// assertion and there is deliberately no ceiling — a slow CI runner must not
	// turn this into a flake.
	for (const gap of gaps(starts)) {
		assert.ok(gap >= 38, `serial requests must be spaced by the interval, saw ${gap}ms`);
	}
}

// --- Concurrent callers are spaced too ---------------------------------------
// The Promise.all case. Ten requests fired at once must still leave the gate one
// at a time; a racy implementation lets them all through in a single tick.
{
	const { starts } = stubFetch(() => okJson({ ok: 1 }));
	setMflRequestInterval(25);
	await Promise.all(
		Array.from({ length: 10 }, (_, i) => mflGet(`/export?TYPE=rosters&L=${i}&JSON=1`, null, 2026))
	);
	assert.equal(starts.length, 10);
	const sorted = [...starts].sort((a, b) => a - b);
	for (const gap of gaps(sorted)) {
		assert.ok(gap >= 23, `concurrent requests must still be paced, saw ${gap}ms`);
	}
	// The whole point, stated as the property rather than as per-gap arithmetic:
	// ten requests at a 25ms floor cannot possibly complete in under ~225ms.
	assert.ok(
		sorted[sorted.length - 1] - sorted[0] >= 200,
		'ten paced requests must span at least nine intervals'
	);
}

// --- Interval 0 disables pacing ----------------------------------------------
// api/live-scoring.js shares this module and fans out across every league on a
// ~30s poll. It never calls setMflRequestInterval, so it must keep sending
// concurrently — pacing that leaked into the default would add seconds of
// latency to a user-facing tab that is not what trips the rate limit.
{
	const { starts } = stubFetch(() => okJson({ ok: 1 }));
	setMflRequestInterval(0);
	const began = Date.now();
	await Promise.all(
		Array.from({ length: 10 }, (_, i) => mflGet(`/export?TYPE=liveScoring&L=${i}&JSON=1`, null, 2026))
	);
	assert.equal(starts.length, 10);
	assert.ok(Date.now() - began < 100, 'unpaced requests must not be serialized');
}

// --- A 429 retry is paced, and does not wedge the gate behind it --------------
// Retries recurse through mflGet, so they queue like any other request. The
// failure this guards against is a rejected turn poisoning the shared chain and
// stalling every request queued after it — which would take down a whole sync,
// not just the request that failed.
{
	let calls = 0;
	const { starts } = stubFetch(() => {
		calls += 1;
		// First call 429s (one retry), everything after succeeds.
		if (calls === 1) return { ok: false, status: 429, json: async () => ({}), text: async () => '' };
		return okJson({ ok: 1 });
	});
	setMflRequestInterval(20);
	const first = await mflGet('/export?TYPE=league&L=1&JSON=1', null, 2026);
	assert.deepEqual(first, { ok: 1 }, 'a 429 must still resolve after its retry');
	assert.equal(starts.length, 2, 'the retry is a second request');

	// The gate still works for the next caller rather than having been wedged.
	const before = starts.length;
	await Promise.all([
		mflGet('/export?TYPE=league&L=2&JSON=1', null, 2026),
		mflGet('/export?TYPE=league&L=3&JSON=1', null, 2026),
	]);
	assert.equal(starts.length, before + 2, 'requests after a 429 must still go out');
	const after = [...starts.slice(before)].sort((a, b) => a - b);
	assert.ok(after[1] - after[0] >= 18, 'the gate must still pace after a 429');
}

// --- A non-429 error rejects and leaves the gate usable -----------------------
{
	let calls = 0;
	stubFetch(() => {
		calls += 1;
		if (calls === 1) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
		return okJson({ ok: 1 });
	});
	setMflRequestInterval(10);
	await assert.rejects(
		() => mflGet('/export?TYPE=league&L=404&JSON=1', null, 2026),
		/MFL request failed \(404\)/,
		'a 404 throws immediately rather than burning retries'
	);
	assert.deepEqual(
		await mflGet('/export?TYPE=league&L=5&JSON=1', null, 2026),
		{ ok: 1 },
		'a rejected request must not wedge the gate behind it'
	);
}

setMflRequestInterval(0);

// --- The TYPE=league dedup ----------------------------------------------------
// The franchise-name map is what all three passes actually want off that
// response, and all three used to fetch it for themselves.

const leagueResponse = {
	league: {
		id: '26696',
		name: 'Minnesota Maniax Dynasty',
		franchises: {
			franchise: [
				{ id: '0001', name: 'Rumble Fish' },
				{ id: '0002', name: 'Team Two' },
			],
		},
	},
};

const standingsResponse = {
	leagueStandings: {
		franchise: [
			{ id: '0001', h2hw: '1', h2hl: '0', h2ht: '0', pf: '100.5', pa: '90.25' },
			{ id: '0002', h2hw: '0', h2hl: '1', h2ht: '0', pf: '90.25', pa: '100.5' },
		],
	},
};

// leagueStandings is matched first on purpose: "TYPE=leagueStandings" contains
// "TYPE=league" as a prefix, so the looser test has to come second or it
// swallows both. The counting below keys off "TYPE=league&" for the same reason.
const routed = (url) => {
	if (url.includes('TYPE=leagueStandings')) return okJson(standingsResponse);
	if (url.includes('TYPE=league&')) return okJson(leagueResponse);
	return okJson({});
};

const league = { id: '26696', name: 'MNMx Dynasty', type: 'dynasty', franchiseId: '0001', season: '2026' };

// fetchStandings without a cached map fetches its own — the fallback that keeps
// standings working for a league whose roster pass failed before caching one.
{
	const { paths } = stubFetch(routed);
	const rows = await fetchStandings(league, null);
	assert.equal(paths.filter((p) => p.includes('TYPE=league&')).length, 1, 'no cache means one TYPE=league read');
	assert.equal(rows[0].teamName, 'Rumble Fish', 'names resolve off the freshly fetched response');
}

// With a cached map it makes no TYPE=league request at all, and resolves the
// same names — the saving has to be free of any change in what is rendered.
{
	const { paths } = stubFetch(routed);
	const rows = await fetchStandings(league, null, mflFranchiseNames(leagueResponse));
	assert.equal(paths.filter((p) => p.includes('TYPE=league&')).length, 0, 'a cached map must skip the read entirely');
	assert.equal(paths.filter((p) => p.includes('TYPE=leagueStandings')).length, 1, 'the standings read still happens');
	assert.equal(rows[0].teamName, 'Rumble Fish', 'cached names must resolve identically');
	assert.equal(rows[0].isMe, true);
}

// fetchLeagueRoster takes the same treatment: handed a response it does not
// re-read it. Draft picks are off for this fixture (type redraft) to keep the
// assertion about the one request under test.
{
	const rosterLeague = { ...league, type: 'redraft' };
	const { paths } = stubFetch((url) => {
		if (url.includes('TYPE=rosters')) {
			return okJson({ rosters: { franchise: { id: '0001', player: [] } } });
		}
		return routed(url);
	});
	await fetchLeagueRoster(rosterLeague, null, new Map(), new Map(), new Map(), leagueResponse);
	assert.equal(
		paths.filter((p) => p.includes('TYPE=league&')).length,
		0,
		'a cached TYPE=league response must not be re-fetched'
	);
}

// --- api/live-scoring.js opts in, at its own much smaller interval -----------
// It fans out across every league at once, so an unpaced poll leaves as one
// burst of ~15 simultaneous MFL requests every 30s for as long as the Scoring
// tab is open — and one landing mid-sync stacks on top of what the sync is
// spending. Its interval is deliberately far below the sync's 300ms, because it
// pays the wait in latency on a user-facing tab rather than in cron wall-clock.
//
// Dynamically imported here, after the cases above, precisely because importing
// it is what applies the setting — a static import would hoist above them and
// change what they measure. That the import alone arms the gate is the property
// under test: nothing else in the request path calls setMflRequestInterval for
// this deployment, so if that call were dropped the burst would return silently.
{
	setMflRequestInterval(0);
	await import('../api/live-scoring.js');

	const { starts } = stubFetch(() => okJson({ ok: 1 }));
	await Promise.all(
		Array.from({ length: 6 }, (_, i) => mflGet(`/export?TYPE=liveScoring&L=${i}&JSON=1`, null, 2026))
	);
	const sorted = [...starts].sort((a, b) => a - b);
	assert.equal(sorted.length, 6);
	for (const gap of gaps(sorted)) {
		assert.ok(gap > 0, `importing live-scoring must arm the gate, saw a ${gap}ms gap`);
	}
	// Bounded on both sides: it has to actually pace, and it has to stay far
	// cheaper than the sync's interval or the tab pays for it on every poll.
	const span = sorted[sorted.length - 1] - sorted[0];
	assert.ok(span >= 5 * 70, `six requests must span five intervals, saw ${span}ms`);
	assert.ok(span < 5 * 300, `live-scoring must not inherit the sync's 300ms, saw ${span}ms`);
}

setMflRequestInterval(0);
globalThis.fetch = originalFetch;

console.log('test-mfl-request-pacing: all assertions passed');
