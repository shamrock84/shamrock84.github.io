// Pins the two abuse limits on the public endpoints that are worth abusing:
//
//   - api/login.js counts FAILED attempts per IP and across everyone in the
//     plans Upstash store, refuses a locked-out request before comparing the
//     password (and without counting it), clears the IP's counter on success,
//     and fails open when the store is missing or down.
//   - api/trigger-sync.js refuses a request without a valid login token
//     (before the cooldown, so a stranger can't spend it), holds its cooldown
//     in the same store so it binds across cold starts and concurrent
//     instances — which a module-level timestamp never did — hands the
//     cooldown back when the GitHub dispatch fails, and falls back to the old
//     per-instance check without a store.
//
// Both run against an in-memory fake of Upstash's /pipeline REST endpoint and
// of GitHub's dispatch endpoint, by stubbing globalThis.fetch. No network.

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createToken } from '../api/_lib/auth.mjs';

const STORE_URL = 'https://fake-upstash.test';
const originalFetch = globalThis.fetch;

// --- A just-big-enough Upstash: the commands store.mjs actually sends. ---
function makeFakeStore() {
	const data = new Map(); // key -> { value, expiresAt|null }
	let now = 0;
	let down = false;
	const live = (key) => {
		const e = data.get(key);
		if (e && e.expiresAt != null && e.expiresAt <= now) { data.delete(key); return null; }
		return e || null;
	};
	const run = ([cmd, key, ...args]) => {
		switch (cmd) {
			case 'GET': return live(key)?.value ?? null;
			case 'SET': {
				const nx = args.includes('NX');
				if (nx && live(key)) return null;
				const ex = args.indexOf('EX');
				data.set(key, { value: args[0], expiresAt: ex >= 0 ? now + Number(args[ex + 1]) * 1000 : null });
				return 'OK';
			}
			case 'PTTL': { const e = live(key); return !e ? -2 : e.expiresAt == null ? -1 : e.expiresAt - now; }
			case 'INCR': {
				const e = live(key);
				const n = (Number(e?.value) || 0) + 1;
				data.set(key, { value: String(n), expiresAt: e?.expiresAt ?? null });
				return n;
			}
			case 'EXPIRE': { const e = live(key); if (!e) return 0; e.expiresAt = now + Number(args[0]) * 1000; return 1; }
			case 'DEL': return data.delete(key) ? 1 : 0;
			default: throw new Error(`fake store: unexpected command ${cmd}`);
		}
	};
	return {
		data,
		advance(ms) { now += ms; },
		setDown(v) { down = v; },
		async handle(url, init) {
			if (down) return { ok: false, status: 503, json: async () => ({}) };
			assert.equal(url, `${STORE_URL}/pipeline`, 'store.mjs helpers should all go through /pipeline');
			const commands = JSON.parse(init.body);
			return { ok: true, status: 200, json: async () => commands.map((c) => ({ result: run(c) })) };
		},
	};
}

let store;
let githubCalls = 0;
let githubOk = true;
globalThis.fetch = async (url, init = {}) => {
	if (String(url).startsWith(STORE_URL)) return store.handle(String(url), init);
	if (String(url).startsWith('https://api.github.com/')) {
		githubCalls++;
		return githubOk
			? { ok: true, status: 204, text: async () => '' }
			: { ok: false, status: 500, text: async () => 'boom' };
	}
	throw new Error(`unexpected fetch ${url}`);
};

function fakeRes() {
	return {
		statusCode: null, body: null, headers: {},
		setHeader(k, v) { this.headers[k] = v; },
		status(c) { this.statusCode = c; return this; },
		json(b) { this.body = b; return this; },
		end() { return this; },
	};
}

let importCount = 0;
// A fresh module instance each time, so module-level state (trigger-sync's
// fallback timestamp) starts clean — the same thing a cold start does.
const freshHandler = async (path) => (await import(`${path}?fresh=${importCount++}`)).default;

async function call(handler, { body = {}, ip = '1.1.1.1', token = null } = {}) {
	const res = fakeRes();
	const headers = { origin: 'https://melbostads.com', 'x-real-ip': ip };
	if (token) headers.authorization = `Bearer ${token}`;
	await handler({ method: 'POST', headers, body }, res);
	return res;
}

function withStoreEnv() {
	process.env.KV_REST_API_URL = STORE_URL;
	process.env.KV_REST_API_TOKEN = 'tok';
}
function withoutStoreEnv() {
	delete process.env.KV_REST_API_URL;
	delete process.env.KV_REST_API_TOKEN;
	delete process.env.UPSTASH_REDIS_REST_URL;
	delete process.env.UPSTASH_REDIS_REST_TOKEN;
}

process.env.SITE_PASSWORD = 'correct horse';
process.env.SESSION_SECRET = 'secret';
process.env.GITHUB_DISPATCH_TOKEN = 'gh';

const { LOGIN_IP_MAX_FAILURES, LOGIN_GLOBAL_MAX_FAILURES } = await import('../api/login.js');
const { COOLDOWN_MS } = await import('../api/trigger-sync.js');
// A logged-in caller, for every trigger-sync case below except the auth ones.
const sync = (handler) => call(handler, { token: createToken(process.env.SESSION_SECRET) });

// ---------------------------------------------------------------- login ----

{
	store = makeFakeStore();
	withStoreEnv();
	const login = await freshHandler('../api/login.js');

	const ok = await call(login, { body: { password: 'correct horse' } });
	assert.equal(ok.statusCode, 200, 'the right password logs in');
	assert.ok(ok.body.token, 'and gets a token');

	for (let i = 0; i < LOGIN_IP_MAX_FAILURES; i++) {
		const r = await call(login, { body: { password: `guess ${i}` } });
		assert.equal(r.statusCode, 401, `failure ${i + 1} is an ordinary 401`);
	}
	const locked = await call(login, { body: { password: 'correct horse' } });
	assert.equal(locked.statusCode, 429, 'past the per-IP limit even the right password is refused');
	assert.equal(locked.body.token, undefined, 'and no token leaks out of a locked request');
	assert.equal(store.data.get('login:fail:ip:1.1.1.1').value, String(LOGIN_IP_MAX_FAILURES),
		'a refused request is not counted, so guessing during a lockout does not extend it');

	const otherIp = await call(login, { body: { password: 'correct horse' }, ip: '2.2.2.2' });
	assert.equal(otherIp.statusCode, 200, 'one IP being locked out does not lock out another');

	store.advance(15 * 60 * 1000 + 1);
	const afterWindow = await call(login, { body: { password: 'correct horse' } });
	assert.equal(afterWindow.statusCode, 200, 'the per-IP lockout drains once the window passes');
	assert.equal(store.data.has('login:fail:ip:1.1.1.1'), false, 'a success clears that IP\'s counter');
}

{
	// Sliding window: a script that keeps failing never lets its counter drain.
	store = makeFakeStore();
	withStoreEnv();
	const login = await freshHandler('../api/login.js');
	for (let i = 0; i < LOGIN_IP_MAX_FAILURES - 1; i++) {
		await call(login, { body: { password: 'nope' } });
		store.advance(10 * 60 * 1000); // each failure inside the window of the last
	}
	assert.equal((await call(login, { body: { password: 'nope' } })).statusCode, 401);
	assert.equal((await call(login, { body: { password: 'correct horse' } })).statusCode, 429,
		'failures spaced inside the window accumulate rather than expiring one by one');
}

{
	// The global counter is what stops a guesser spread across many IPs.
	store = makeFakeStore();
	withStoreEnv();
	const login = await freshHandler('../api/login.js');
	for (let i = 0; i < LOGIN_GLOBAL_MAX_FAILURES; i++) {
		await call(login, { body: { password: 'nope' }, ip: `10.0.${Math.floor(i / 200)}.${i % 200}` });
	}
	const fresh = await call(login, { body: { password: 'correct horse' }, ip: '9.9.9.9' });
	assert.equal(fresh.statusCode, 429, 'past the global limit, a never-seen IP is refused too');
	store.advance(60 * 60 * 1000 + 1);
	assert.equal((await call(login, { body: { password: 'correct horse' }, ip: '9.9.9.9' })).statusCode, 200,
		'and the global lockout drains after its window');
}

{
	// Fails open: no store configured, or the store down, is the old behaviour.
	withoutStoreEnv();
	const login = await freshHandler('../api/login.js');
	for (let i = 0; i < LOGIN_IP_MAX_FAILURES + 5; i++) await call(login, { body: { password: 'nope' } });
	assert.equal((await call(login, { body: { password: 'correct horse' } })).statusCode, 200,
		'with no store, there is nothing to count against and login still works');

	store = makeFakeStore();
	store.setDown(true);
	withStoreEnv();
	const login2 = await freshHandler('../api/login.js');
	assert.equal((await call(login2, { body: { password: 'nope' } })).statusCode, 401, 'a store outage still rejects a wrong password');
	assert.equal((await call(login2, { body: { password: 'correct horse' } })).statusCode, 200,
		'and never locks the manager out of their own site');
}

{
	// Malformed input is a failure, not a crash.
	store = makeFakeStore();
	withStoreEnv();
	const login = await freshHandler('../api/login.js');
	assert.equal((await call(login, { body: { password: 12345 } })).statusCode, 401);
	assert.equal((await call(login, { body: null })).statusCode, 401);
}

// --------------------------------------------------------- trigger-sync ----

{
	store = makeFakeStore();
	withStoreEnv();
	githubCalls = 0;
	githubOk = true;
	const instanceA = await freshHandler('../api/trigger-sync.js');
	const instanceB = await freshHandler('../api/trigger-sync.js');

	assert.equal((await sync(instanceA)).statusCode, 200, 'the first request dispatches');
	assert.equal(githubCalls, 1);

	const fromB = await sync(instanceB);
	assert.equal(fromB.statusCode, 429,
		'a second instance (or a cold start) sees the same cooldown — the hole the module-level timestamp left');
	assert.equal(githubCalls, 1, 'and does not dispatch');
	assert.ok(fromB.body.retryAfterSeconds > 0 && fromB.body.retryAfterSeconds <= COOLDOWN_MS / 1000, 'it says how long to wait');
	assert.match(fromB.body.error, /try again in \d+ min/, 'in words the page shows as-is');

	assert.ok(COOLDOWN_MS >= 3 * 60 * 1000, 'the cooldown stays longer than a sync run (60-120s), or dispatches queue back to back');
	store.advance(COOLDOWN_MS - 60 * 1000);
	assert.equal((await sync(instanceB)).statusCode, 429, 'still inside the window a minute before it ends');
	store.advance(60 * 1000 + 1);
	assert.equal((await sync(instanceB)).statusCode, 200, 'and open again once it passes');
	assert.equal(githubCalls, 2);
}

{
	// A failed dispatch hands the cooldown back, so a retry can go straight away.
	store = makeFakeStore();
	withStoreEnv();
	githubCalls = 0;
	githubOk = false;
	const handler = await freshHandler('../api/trigger-sync.js');
	assert.equal((await sync(handler)).statusCode, 502, 'GitHub refusing is reported');
	githubOk = true;
	assert.equal((await sync(handler)).statusCode, 200, 'and did not spend the cooldown');
	assert.equal(githubCalls, 2);
}

{
	// Concurrent requests: exactly one gets through.
	store = makeFakeStore();
	withStoreEnv();
	githubCalls = 0;
	githubOk = true;
	const handlers = await Promise.all([0, 1, 2, 3, 4].map(() => freshHandler('../api/trigger-sync.js')));
	const results = await Promise.all(handlers.map((h) => sync(h)));
	assert.equal(results.filter((r) => r.statusCode === 200).length, 1, 'one of five simultaneous requests dispatches');
	assert.equal(githubCalls, 1);
}

{
	// Fallbacks: no store, or a store outage, keep the per-instance check.
	githubOk = true;
	for (const setup of [() => withoutStoreEnv(), () => { store = makeFakeStore(); store.setDown(true); withStoreEnv(); }]) {
		setup();
		githubCalls = 0;
		const handler = await freshHandler('../api/trigger-sync.js');
		assert.equal((await sync(handler)).statusCode, 200, 'the button still works without the shared store');
		assert.equal((await sync(handler)).statusCode, 429, 'and this instance still enforces its own cooldown');
		assert.equal(githubCalls, 1);
	}
}


{
	// Login gate: no token, a forged token or an expired one is refused, and
	// a refused request does not spend the cooldown — otherwise anyone could
	// lock the manager out of their own button by calling it first.
	store = makeFakeStore();
	withStoreEnv();
	githubCalls = 0;
	githubOk = true;
	const handler = await freshHandler('../api/trigger-sync.js');

	const anon = await call(handler);
	assert.equal(anon.statusCode, 401, 'no token is refused');
	assert.equal((await call(handler, { token: 'not.a-token' })).statusCode, 401, 'a forged token is refused');
	const expiredPayload = Buffer.from(JSON.stringify({ exp: Date.now() - 1000 })).toString('base64url');
	const expiredSig = createHmac('sha256', process.env.SESSION_SECRET).update(expiredPayload).digest('base64url');
	assert.equal((await call(handler, { token: `${expiredPayload}.${expiredSig}` })).statusCode, 401, 'an expired token is refused');
	assert.equal(githubCalls, 0, 'none of them dispatched');
	assert.equal(store.data.has('sync:cooldown'), false, 'and none of them spent the cooldown');
	assert.match(anon.headers['Access-Control-Allow-Headers'] || '', /Authorization/,
		'the preflight allows the Authorization header, or the browser never sends the token');

	assert.equal((await sync(handler)).statusCode, 200, 'a logged-in caller still gets through straight after');
	assert.equal(githubCalls, 1);
}

globalThis.fetch = originalFetch;
console.log('api rate limits: all assertions passed');
