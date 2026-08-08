// Unit test for the *client* half of plan syncing — the part of myffl.html
// that decides what to do with a merge response from api/plans.js.
//
// scripts/test-plans.mjs pins the server side: merge is a union, replace
// replaces. That leaves the failure this file exists for entirely uncovered.
// A union cannot express a deletion, so a merge response landing after someone
// clears a plan hands the old value straight back — and the page used to write
// it into localStorage unread. Clearing a contract length back to "—" simply
// did not stick, while setting one worked fine.
//
// There is no framework here and no DOM, so the page's script block is
// evaluated in a vm with the handful of browser globals it touches stubbed
// out. That means these tests run the real source rather than a copy of it:
// the plan functions are top-level function declarations, so they land on the
// context's global object and can be called directly. Nothing is mocked
// beyond the browser itself — fetch is the seam.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(root, 'myffl.html'), 'utf8');
const scriptSource = html.match(/<script>([\s\S]*)<\/script>/)[1];

const CONTRACT_KEY = 'myfflContractPlans';
const SALARY_KEY = 'myfflSalaryPlans';

// Every element lookup answers with the same do-nothing node. The page only
// touches the DOM here to wire up listeners it never fires in these tests.
function fakeElement() {
	const node = {
		value: '',
		textContent: '',
		disabled: false,
		dataset: {},
		style: {},
		classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
		addEventListener() {},
		removeEventListener() {},
		appendChild: (child) => child,
		removeChild: (child) => child,
		remove() {},
		focus() {},
		setAttribute() {},
		querySelector: () => null,
		querySelectorAll: () => [],
		closest: () => null,
		insertBefore: (child) => child,
	};
	return node;
}

function fakeLocalStorage() {
	const store = new Map();
	return {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k),
		clear: () => store.clear(),
	};
}

// Loads the page script into a fresh context. `respond` is called for every
// request the page makes and returns the parsed body to answer with, or throws
// to simulate an unreachable store.
function loadPage({ respond, loggedIn = true, seedPlans } = {}) {
	const localStorage = fakeLocalStorage();
	if (loggedIn) localStorage.setItem('mflAuthToken', 'test-token');
	if (seedPlans?.contractPlans) localStorage.setItem(CONTRACT_KEY, JSON.stringify(seedPlans.contractPlans));
	if (seedPlans?.salaryPlans) localStorage.setItem(SALARY_KEY, JSON.stringify(seedPlans.salaryPlans));

	const requests = [];
	const fetchStub = async (url, options = {}) => {
		const body = options.body ? JSON.parse(options.body) : null;
		const request = { url, method: options.method || 'GET', body };
		requests.push(request);
		const answer = await respond(request);
		if (answer === undefined) return { ok: false, status: 503, json: async () => ({}) };
		return { ok: true, status: 200, json: async () => answer };
	};

	const context = {
		console,
		fetch: fetchStub,
		localStorage,
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		document: {
			addEventListener() {},
			getElementById: () => fakeElement(),
			createElement: () => fakeElement(),
			querySelector: () => null,
			querySelectorAll: () => [],
			visibilityState: 'visible',
			body: fakeElement(),
		},
		window: { addEventListener() {} },
	};
	vm.createContext(context);
	vm.runInContext(scriptSource, context);
	return { g: context, localStorage, requests };
}

const contractPlans = (localStorage) => JSON.parse(localStorage.getItem(CONTRACT_KEY) || '{}');
const salaryPlans = (localStorage) => JSON.parse(localStorage.getItem(SALARY_KEY) || '{}');
const planPosts = (requests) => requests.filter((r) => r.url.includes('/api/plans'));

// The page debounces pushes by 800ms; flushPlanPush is the same path a
// backgrounded tab takes, and firing it directly keeps the tests instant.
async function flush(page) {
	page.g.flushPlanPush();
	// One turn for the fetch, one for the .then that adopts the answer, plus a
	// little slack for the follow-up push a reconcile can schedule.
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

let failures = 0;
const tests = [];
function test(name, fn) {
	tests.push([name, fn]);
}

// --- the bug this file was written for --------------------------------------

test('a merge answer does not resurrect a plan cleared while it was in flight', async () => {
	// The store still has the plan, because the merge was computed from a
	// snapshot taken before the clear happened. That is the normal case: the
	// roster is on screen and editable for the whole round-trip.
	let release;
	const inFlight = new Promise((resolve) => { release = resolve; });
	const page = loadPage({
		seedPlans: { contractPlans: { L1: { p1: '2' } } },
		respond: async (req) => {
			if (!req.url.includes('/api/plans')) return undefined;
			if (req.body.mode === 'merge') {
				await inFlight;
				return { plans: { contractPlans: { L1: { p1: '2' } }, salaryPlans: {} } };
			}
			return { plans: req.body.plans };
		},
	});

	const syncing = page.g.syncPlans();
	page.g.setContractPlan('L1', 'p1', '');
	assert.deepEqual(contractPlans(page.localStorage), {}, 'the local clear happens immediately');
	release();
	await syncing;
	for (let i = 0; i < 10; i++) await Promise.resolve();

	assert.deepEqual(contractPlans(page.localStorage), {}, 'the merge answer must not put it back');
});

test('the deletion is pushed on to the store in replace mode', async () => {
	const page = loadPage({
		seedPlans: { contractPlans: { L1: { p1: '2' } } },
		respond: async (req) => {
			if (!req.url.includes('/api/plans')) return undefined;
			if (req.body.mode === 'merge') {
				return { plans: { contractPlans: { L1: { p1: '2' } }, salaryPlans: {} } };
			}
			return { plans: req.body.plans };
		},
	});

	page.g.setContractPlan('L1', 'p1', '');
	await page.g.syncPlans();
	await flush(page);

	const posts = planPosts(page.requests);
	const replace = posts.filter((r) => r.body.mode === 'replace');
	assert.equal(replace.length >= 1, true, 'a replace push must follow the reconciled merge');
	assert.deepEqual(replace.at(-1).body.plans.contractPlans, {}, 'and it carries the deletion');
});

test('a change made before any successful sync clears rather than resurrects', async () => {
	// This is the other window: the load-time sync failed, so the device is
	// still in merge mode and the edit itself is what retries it.
	let allowSync = false;
	const page = loadPage({
		seedPlans: { contractPlans: { L1: { p1: '3' } } },
		respond: async (req) => {
			if (!req.url.includes('/api/plans')) return undefined;
			if (!allowSync) throw new Error('store down');
			if (req.body.mode === 'merge') {
				return { plans: { contractPlans: { L1: { p1: '3' } }, salaryPlans: {} } };
			}
			return { plans: req.body.plans };
		},
	});

	await page.g.syncPlans(); // fails, leaving the device unsynced
	allowSync = true;
	page.g.setContractPlan('L1', 'p1', '');
	await flush(page);
	await flush(page);

	assert.deepEqual(contractPlans(page.localStorage), {}, 'the clear survives the retry merge');
	const modes = planPosts(page.requests).map((r) => r.body.mode);
	assert.equal(modes.includes('replace'), true, 'and a replace push follows to remove it upstream');
});

// --- properties the fix must not break --------------------------------------

test('a merge still pulls in another device\'s plans', async () => {
	const page = loadPage({
		respond: async (req) => {
			if (!req.url.includes('/api/plans')) return undefined;
			return { plans: { contractPlans: { L1: { p9: '1' } }, salaryPlans: { L1: { p9: '15' } } } };
		},
	});

	await page.g.syncPlans();

	assert.deepEqual(contractPlans(page.localStorage), { L1: { p9: '1' } });
	assert.deepEqual(salaryPlans(page.localStorage), { L1: { p9: '15' } });
});

test('reconciling touches only the keys this device changed', async () => {
	const page = loadPage({
		seedPlans: { contractPlans: { L1: { p1: '2' } } },
		respond: async (req) => {
			if (!req.url.includes('/api/plans')) return undefined;
			if (req.body.mode === 'merge') {
				return { plans: { contractPlans: { L1: { p1: '2', p2: '3' }, L2: { p5: '1' } }, salaryPlans: {} } };
			}
			return { plans: req.body.plans };
		},
	});

	page.g.setContractPlan('L1', 'p1', '');
	await page.g.syncPlans();

	assert.deepEqual(
		contractPlans(page.localStorage),
		{ L1: { p2: '3' }, L2: { p5: '1' } },
		'everything the merge brought in survives; only the cleared key goes'
	);
});

test('a value set while the merge was in flight survives the answer', async () => {
	let release;
	const inFlight = new Promise((resolve) => { release = resolve; });
	const page = loadPage({
		respond: async (req) => {
			if (!req.url.includes('/api/plans')) return undefined;
			if (req.body.mode === 'merge') {
				await inFlight;
				return { plans: { contractPlans: {}, salaryPlans: {} } };
			}
			return { plans: req.body.plans };
		},
	});

	const syncing = page.g.syncPlans();
	page.g.setContractPlan('L1', 'p1', '2');
	page.g.setSalaryPlan('L1', 'p1', '12');
	release();
	await syncing;
	for (let i = 0; i < 10; i++) await Promise.resolve();

	assert.deepEqual(contractPlans(page.localStorage), { L1: { p1: '2' } });
	assert.deepEqual(salaryPlans(page.localStorage), { L1: { p1: '12' } });
});

test('a first sync still posts in merge mode', async () => {
	const page = loadPage({
		respond: async (req) => {
			if (!req.url.includes('/api/plans')) return undefined;
			return { plans: { contractPlans: {}, salaryPlans: {} } };
		},
	});

	await page.g.syncPlans();

	assert.equal(planPosts(page.requests)[0].body.mode, 'merge');
});

test('an already-synced device posts changes in replace mode only', async () => {
	const page = loadPage({
		respond: async (req) => {
			if (!req.url.includes('/api/plans')) return undefined;
			if (req.body.mode === 'merge') return { plans: { contractPlans: {}, salaryPlans: {} } };
			return { plans: req.body.plans };
		},
	});

	await page.g.syncPlans();
	page.g.setContractPlan('L1', 'p1', '2');
	await flush(page);
	page.g.setContractPlan('L1', 'p1', '');
	await flush(page);

	const modes = planPosts(page.requests).map((r) => r.body.mode);
	assert.deepEqual(modes.slice(1), ['replace', 'replace'], 'no merge after the first one');
	assert.deepEqual(contractPlans(page.localStorage), {});
});

test('the page still edits plans with the store unreachable', async () => {
	const page = loadPage({
		seedPlans: { contractPlans: { L1: { p1: '2' } } },
		respond: async () => { throw new Error('offline'); },
	});

	await page.g.syncPlans();
	page.g.setContractPlan('L1', 'p1', '');
	await flush(page);

	assert.deepEqual(contractPlans(page.localStorage), {}, 'localStorage is the working copy');
});

test('logging out drops the edit log so it cannot be replayed over a newer copy', async () => {
	const page = loadPage({
		seedPlans: { contractPlans: { L1: { p1: '2' } } },
		respond: async (req) => {
			if (req.url.includes('/api/login')) return { token: 'a-fresh-token' };
			if (!req.url.includes('/api/plans')) return undefined;
			// Whatever this device asks for, the store answers with a plan made
			// somewhere else after the logout.
			return { plans: { contractPlans: { L1: { p1: '3' } }, salaryPlans: {} } };
		},
	});

	page.g.setContractPlan('L1', 'p1', '');
	page.g.doLogout();
	await page.g.doLogin('site-password'); // re-merges from scratch
	for (let i = 0; i < 10; i++) await Promise.resolve();

	assert.deepEqual(
		contractPlans(page.localStorage),
		{ L1: { p1: '3' } },
		'the pre-logout clear must not be re-applied over the newer value'
	);
});

for (const [name, fn] of tests) {
	try {
		await fn();
		console.log(`  ok   ${name}`);
	} catch (err) {
		failures++;
		console.log(`  FAIL ${name}`);
		console.log(`       ${err.message}`);
	}
}

if (failures) {
	console.log(`\n${failures} plan-sync test${failures === 1 ? '' : 's'} failed.`);
	process.exit(1);
}
console.log('\nAll plan-sync tests passed.');
