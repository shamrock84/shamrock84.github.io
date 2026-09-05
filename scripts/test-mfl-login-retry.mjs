// Unit test for the MFL login's transient-failure retry —
// fetchWithTransientRetry/mflLogin in scripts/lib/providers.mjs.
//
// This exists because of a real failure. The scheduled sync at 18:16 on
// 2026-09-05 died 27 seconds in, before a single league was attempted:
//
//   TypeError: fetch failed
//     at async mflLogin (scripts/lib/providers.mjs)
//     [cause]: ConnectTimeoutError (timeout: 10000ms)
//
// "The sync degrades, it never fails" holds per league — every one is wrapped
// in try/catch and falls back to the previous snapshot. The login is not a
// league. It runs before all of that machinery, so one ten-second connect blip
// threw straight out of main() and cost a whole four-hour cycle.
//
// The distinction being pinned here is which failures are worth asking again
// about and which are answers. A transport failure and a "later" status are
// retried; a 200 with no session cookie is what wrong credentials look like and
// must still fail fast, or a genuine misconfiguration would take fourteen
// seconds to report itself and read as a network problem.

import assert from 'node:assert/strict';
import { mflLogin, fetchWithTransientRetry, TRANSIENT_RETRY_DELAYS_MS } from './lib/providers.mjs';

// A fast schedule, so the give-up path costs milliseconds rather than the real
// fourteen seconds. The retry *count* is what the assertions turn on.
const FAST = [1, 1, 1];

const originalFetch = globalThis.fetch;

const loginOk = () => ({
	ok: true,
	status: 200,
	headers: { getSetCookie: () => ['MFL_USER_ID=abc123; path=/'], get: () => null },
	text: async () => '<status>OK</status>',
});

// A 200 that carries no cookie — what MFL answers for bad credentials.
const loginNoCookie = () => ({
	ok: true,
	status: 200,
	headers: { getSetCookie: () => [], get: () => null },
	text: async () => '<error>Invalid password</error>',
});

const status = (code) => ({
	ok: false,
	status: code,
	headers: { getSetCookie: () => [], get: () => null },
	text: async () => '',
});

// undici's shape: fetch rejects with a bare "fetch failed" and the real code on
// .cause. Reproduced exactly, because the message the helper builds reads that
// cause and a plain Error would quietly produce a less useful one.
function connectTimeout() {
	const err = new TypeError('fetch failed');
	err.cause = Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
	return err;
}

// --- The real failure: a connect timeout, then success -----------------------
{
	let calls = 0;
	globalThis.fetch = async () => {
		calls += 1;
		if (calls === 1) throw connectTimeout();
		return loginOk();
	};
	const cookie = await mflLogin('user', 'pass');
	assert.equal(cookie, 'MFL_USER_ID=abc123', 'the login recovers on the retry');
	assert.equal(calls, 2, 'exactly one retry was needed');
}

// --- Transport failures are retried up to the schedule, then give up ---------
{
	let calls = 0;
	globalThis.fetch = async () => { calls += 1; throw connectTimeout(); };
	await assert.rejects(
		() => fetchWithTransientRetry('https://example.test/login', {}, 'MFL login', FAST),
		// The undici cause, not the uninformative "fetch failed", is what a
		// failed run's logs need to be diagnosable at all.
		/MFL login failed: UND_ERR_CONNECT_TIMEOUT/,
		'gives up with the underlying cause in the message'
	);
	assert.equal(calls, FAST.length + 1, 'one initial attempt plus one per delay');
}

// --- 429 and 5xx are "ask again later" ---------------------------------------
for (const code of [429, 500, 502, 503]) {
	let calls = 0;
	globalThis.fetch = async () => {
		calls += 1;
		return calls === 1 ? status(code) : loginOk();
	};
	const res = await fetchWithTransientRetry('https://example.test/login', {}, 'MFL login', FAST);
	assert.equal(res.status, 200, `${code} is retried`);
	assert.equal(calls, 2, `${code} took exactly one retry`);
}

// --- A 4xx is an answer, not a hiccup ----------------------------------------
// Handed straight back rather than retried, so the caller decides. Retrying a
// 401 three times would only delay the same conclusion.
{
	let calls = 0;
	globalThis.fetch = async () => { calls += 1; return status(401); };
	const res = await fetchWithTransientRetry('https://example.test/login', {}, 'MFL login', FAST);
	assert.equal(res.status, 401, 'a 4xx comes back as-is');
	assert.equal(calls, 1, 'and is not retried');
}

// --- Bad credentials still fail fast -----------------------------------------
// The load-bearing negative case. A 200 with no cookie is a real answer about
// the credentials, so it must not be dressed up as a network problem.
{
	let calls = 0;
	globalThis.fetch = async () => { calls += 1; return loginNoCookie(); };
	await assert.rejects(
		() => mflLogin('user', 'wrong'),
		/did not return a session cookie/,
		'a cookieless 200 reports the credential problem'
	);
	assert.equal(calls, 1, 'and does so on the first attempt, without retrying');
}

// --- The cookie is read from the body when no Set-Cookie header arrives -------
// Pre-existing fallback, re-asserted here because the retry now sits in front
// of it and a regression would look like a login failure rather than a parse one.
{
	globalThis.fetch = async () => ({
		ok: true,
		status: 200,
		headers: { getSetCookie: () => [], get: () => null },
		text: async () => 'set-cookie: MFL_USER_ID=frombody99; path=/',
	});
	assert.equal(await mflLogin('user', 'pass'), 'MFL_USER_ID=frombody99');
}

// --- The shipped schedule is three retries, generously spaced ----------------
// Not arbitrary: the alternative to waiting here is not a stale league, it is
// no sync at all for four hours.
{
	assert.equal(TRANSIENT_RETRY_DELAYS_MS.length, 3, 'three retries');
	assert.ok(
		TRANSIENT_RETRY_DELAYS_MS.every((d, i, a) => i === 0 || d > a[i - 1]),
		'delays back off rather than repeating'
	);
	assert.ok(
		TRANSIENT_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) >= 10000,
		'and span long enough to outlast a connect-timeout blip'
	);
}

globalThis.fetch = originalFetch;

console.log('test-mfl-login-retry: all assertions passed');
