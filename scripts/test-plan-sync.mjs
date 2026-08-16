// Unit test for the *client* half of plan syncing — what myffl.html does with
// the shared plan document from api/plans.js.
//
// scripts/test-plans.mjs pins the server side in isolation: merge is a union,
// replace replaces. That leaves the failure this file exists for invisible,
// because it only appears when two devices talk to one store. A union cannot
// express a deletion, so for as long as the page merged on every load, a plan
// cleared on the iPad was handed back by the phone's next load — and re-uploaded
// with it, undoing the clear for every device at once. No single-device test can
// see that; the device that made the clear looks perfectly correct throughout.
//
// So the two-device cases below drive two real page instances against one store
// running api/plans.js's actual merge logic, imported rather than reimplemented.
//
// There is no framework here and no DOM, so the page's script block is
// evaluated in a vm with the handful of browser globals it touches stubbed out.
// That means these tests run the real source rather than a copy of it: the plan
// functions are top-level declarations, so they land on the context's global
// object and can be called directly. Nothing is mocked beyond the browser
// itself and the network — fetch is the seam.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { mergePlans, emptyDocument } from '../api/plans.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(root, 'myffl.html'), 'utf8');
const scriptSource = html.match(/<script>([\s\S]*)<\/script>/)[1];

const CONTRACT_KEY = 'myfflContractPlans';
const SALARY_KEY = 'myfflSalaryPlans';
const CUT_KEY = 'myfflCutPlans';
const PENDING_KEY = 'myfflPlanPending';
const SYNCED_KEY = 'myfflPlanSynced';

// Every element lookup answers with the same do-nothing node. The page only
// touches the DOM here to wire up listeners these tests never fire.
function fakeElement() {
	return {
		value: '', textContent: '', disabled: false, dataset: {}, style: {},
		classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
		addEventListener() {}, removeEventListener() {},
		appendChild: (child) => child, removeChild: (child) => child,
		insertBefore: (child) => child, remove() {}, focus() {}, setAttribute() {},
		querySelector: () => null, querySelectorAll: () => [], closest: () => null,
	};
}

// A device is its localStorage. Reloading the page means a new script instance
// over the *same* disk, which is exactly what the persisted "this device has
// synced" flag and the pending-edit log depend on.
function newDisk(initial = {}) {
	const disk = new Map(Object.entries(initial));
	disk.set('mflAuthToken', 'test-token');
	return disk;
}

function loadPage(disk, respond) {
	const localStorage = {
		getItem: (k) => (disk.has(k) ? disk.get(k) : null),
		setItem: (k, v) => disk.set(k, String(v)),
		removeItem: (k) => disk.delete(k),
	};
	const requests = [];
	const context = {
		console,
		localStorage,
		setTimeout, clearTimeout, setInterval, clearInterval,
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
		async fetch(url, options = {}) {
			const request = {
				url: String(url),
				method: options.method || 'GET',
				body: options.body ? JSON.parse(options.body) : null,
			};
			requests.push(request);
			const answer = await respond(request);
			if (answer === undefined) return { ok: false, status: 503, json: async () => ({}) };
			return { ok: true, status: 200, json: async () => answer };
		},
	};
	vm.createContext(context);
	vm.runInContext(scriptSource, context);
	return {
		g: context,
		disk,
		requests,
		contracts: () => JSON.parse(localStorage.getItem(CONTRACT_KEY) || '{}'),
		salaries: () => JSON.parse(localStorage.getItem(SALARY_KEY) || '{}'),
		cuts: () => JSON.parse(localStorage.getItem(CUT_KEY) || '{}'),
		pending: () => JSON.parse(localStorage.getItem(PENDING_KEY) || 'null'),
	};
}

// A store that answers exactly the way api/plans.js does, using its own merge.
function newStore(initial) {
	let doc = { ...emptyDocument(), ...(initial || {}) };
	return {
		read: () => doc,
		contracts: () => doc.contractPlans,
		serve: (request) => {
			if (!request.url.includes('/api/plans')) return undefined;
			if (request.method === 'GET') return { plans: doc };
			doc = request.body.mode === 'merge'
				? mergePlans(doc, request.body.plans)
				: mergePlans(emptyDocument(), request.body.plans);
			return { plans: doc };
		},
	};
}

const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

// The page debounces pushes by 800ms; flushPlanPush is the path a backgrounded
// tab takes, and firing it directly keeps the tests instant.
async function flush(page) {
	page.g.flushPlanPush();
	await settle();
}

let failures = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// --- two devices, one store -------------------------------------------------

test('a plan cleared on one device is gone on the other', async () => {
	const store = newStore({ contractPlans: { L1: { p1: '2' } } });
	const phone = newDisk({ [CONTRACT_KEY]: JSON.stringify({ L1: { p1: '2' } }), [SYNCED_KEY]: '1' });
	const ipad = newDisk({ [CONTRACT_KEY]: JSON.stringify({ L1: { p1: '2' } }), [SYNCED_KEY]: '1' });

	const a = loadPage(ipad, store.serve);
	await a.g.syncPlans();
	a.g.setContractPlan('L1', 'p1', '');
	await flush(a);
	assert.deepEqual(store.contracts(), {}, 'the clear reaches the store');

	// The phone still holds the old value and has no idea it was cleared.
	const b = loadPage(phone, store.serve);
	await b.g.syncPlans();
	await settle();

	assert.deepEqual(b.contracts(), {}, 'the phone drops it on its next load');
	assert.deepEqual(store.contracts(), {}, 'and does not re-upload it');
});

test('and it stays gone when the first device reloads', async () => {
	const store = newStore({ contractPlans: { L1: { p1: '2' } } });
	const phone = newDisk({ [CONTRACT_KEY]: JSON.stringify({ L1: { p1: '2' } }), [SYNCED_KEY]: '1' });
	const ipad = newDisk({ [CONTRACT_KEY]: JSON.stringify({ L1: { p1: '2' } }), [SYNCED_KEY]: '1' });

	const a = loadPage(ipad, store.serve);
	await a.g.syncPlans();
	a.g.setContractPlan('L1', 'p1', '');
	await flush(a);
	await loadPage(phone, store.serve).g.syncPlans();
	await settle();

	const reload = loadPage(ipad, store.serve); // same disk, fresh page
	await reload.g.syncPlans();
	await settle();

	assert.deepEqual(reload.contracts(), {}, 'the clear survives a reload');
	assert.deepEqual(store.contracts(), {});
});

test('a plan set on one device still arrives on the other', async () => {
	const store = newStore();
	const phone = newDisk({ [SYNCED_KEY]: '1' });
	const ipad = newDisk({ [SYNCED_KEY]: '1' });

	const a = loadPage(ipad, store.serve);
	await a.g.syncPlans();
	a.g.setContractPlan('L1', 'p1', '3');
	a.g.setSalaryPlan('L1', 'p1', '22');
	a.g.setCutPlan('L1', 'p2', 'CUT');
	await flush(a);

	const b = loadPage(phone, store.serve);
	await b.g.syncPlans();
	await settle();

	assert.deepEqual(b.contracts(), { L1: { p1: '3' } });
	assert.deepEqual(b.salaries(), { L1: { p1: '22' } });
	assert.deepEqual(b.cuts(), { L1: { p2: 'CUT' } });
});

test('a planned cut clears the same way a contract length does', async () => {
	const store = newStore({ cutPlans: { L1: { p2: 'CUT' } } });
	const disk = newDisk({ [CUT_KEY]: JSON.stringify({ L1: { p2: 'CUT' } }), [SYNCED_KEY]: '1' });

	const page = loadPage(disk, store.serve);
	await page.g.syncPlans();
	page.g.setCutPlan('L1', 'p2', '');
	await flush(page);

	assert.deepEqual(page.cuts(), {}, 'clearing the dropdown clears the local plan');
	assert.deepEqual(store.read().cutPlans, {}, 'and the clear reaches the store');
});

test('a device the store has never met introduces itself with a merge', async () => {
	// The wipe protection: this device has plans of its own and has never
	// synced, so taking the store wholesale would lose them, and replacing the
	// store with its copy would lose the other device's. Union is the only safe
	// move, and it happens exactly once.
	const store = newStore({ contractPlans: { L1: { p9: '1' } } });
	const fresh = newDisk({ [CONTRACT_KEY]: JSON.stringify({ L1: { p1: '2' } }) });

	const page = loadPage(fresh, store.serve);
	await page.g.syncPlans();
	await settle();

	assert.deepEqual(page.contracts(), { L1: { p1: '2', p9: '1' } }, 'nothing is lost either way');
	assert.deepEqual(store.contracts(), { L1: { p1: '2', p9: '1' } });
	assert.equal(fresh.get(SYNCED_KEY), '1', 'and it is never a first load again');

	const second = loadPage(fresh, store.serve);
	await second.g.syncPlans();
	assert.equal(
		second.requests.filter((r) => r.method === 'POST').length,
		0,
		'the next load reads instead of merging'
	);
});

// --- one device -------------------------------------------------------------

test('a returning device pushes in replace mode from the very first edit', async () => {
	// planSyncDone is read back off the disk, so there is no window after load
	// where a clear would be posted as a merge and unioned straight back.
	const store = newStore({ contractPlans: { L1: { p1: '2' } } });
	const disk = newDisk({ [CONTRACT_KEY]: JSON.stringify({ L1: { p1: '2' } }), [SYNCED_KEY]: '1' });

	const page = loadPage(disk, store.serve);
	page.g.setContractPlan('L1', 'p1', ''); // before syncPlans has even run
	await flush(page);

	assert.deepEqual(store.contracts(), {});
	assert.equal(page.requests.every((r) => r.body?.mode !== 'merge'), true);
});

test('an edit made while the load read is in flight is not overwritten', async () => {
	const store = newStore({ contractPlans: { L1: { p1: '2' } } });
	const disk = newDisk({ [CONTRACT_KEY]: JSON.stringify({ L1: { p1: '2' } }), [SYNCED_KEY]: '1' });

	let release;
	const held = new Promise((resolve) => { release = resolve; });
	const page = loadPage(disk, async (req) => {
		if (req.method === 'GET') await held;
		return store.serve(req);
	});

	const syncing = page.g.syncPlans();
	page.g.setContractPlan('L1', 'p1', '');
	page.g.setSalaryPlan('L1', 'p2', '7');
	release();
	await syncing;
	await settle();

	assert.deepEqual(page.contracts(), {}, 'the clear stands');
	assert.deepEqual(page.salaries(), { L1: { p2: '7' } }, 'and so does the set');
});

test('a load answer that lands after a push is discarded', async () => {
	// The answer was computed before the push, so adopting it would undo it.
	const store = newStore({ contractPlans: { L1: { p1: '2' } } });
	const disk = newDisk({ [CONTRACT_KEY]: JSON.stringify({ L1: { p1: '2' } }), [SYNCED_KEY]: '1' });

	let release;
	const held = new Promise((resolve) => { release = resolve; });
	const page = loadPage(disk, async (req) => {
		const answer = store.serve(req);
		if (req.method === 'GET') await held; // answered from the pre-push store
		return answer;
	});

	const syncing = page.g.syncPlans();
	page.g.setContractPlan('L1', 'p1', '');
	await flush(page);
	release();
	await syncing;
	await settle();

	assert.deepEqual(page.contracts(), {}, 'the stale read must not resurrect it');
	assert.deepEqual(store.contracts(), {});
});

test('an edit made with the store down is pushed on the next load', async () => {
	const store = newStore({ contractPlans: { L1: { p1: '2' } } });
	const disk = newDisk({ [CONTRACT_KEY]: JSON.stringify({ L1: { p1: '2' } }), [SYNCED_KEY]: '1' });

	const offline = loadPage(disk, async () => { throw new Error('store down'); });
	await offline.g.syncPlans();
	offline.g.setContractPlan('L1', 'p1', '');
	await flush(offline);
	assert.deepEqual(offline.contracts(), {}, 'the page still works offline');
	assert.deepEqual(offline.pending(), { contractPlans: { L1: { p1: '' } }, salaryPlans: {}, cutPlans: {} });

	const back = loadPage(disk, store.serve);
	await back.g.syncPlans();
	await flush(back);

	assert.deepEqual(store.contracts(), {}, 'the deferred clear reaches the store');
	assert.deepEqual(back.contracts(), {});
});

test('a confirmed push clears the pending log', async () => {
	const store = newStore();
	const disk = newDisk({ [SYNCED_KEY]: '1' });

	const page = loadPage(disk, store.serve);
	await page.g.syncPlans();
	page.g.setContractPlan('L1', 'p1', '2');
	assert.notEqual(page.pending(), null, 'pending while unpushed');
	await flush(page);

	assert.equal(page.pending(), null, 'and gone once the store has it');
});

test('an edit made while a push is in flight stays pending', async () => {
	const store = newStore();
	const disk = newDisk({ [SYNCED_KEY]: '1' });

	let release;
	const held = new Promise((resolve) => { release = resolve; });
	const page = loadPage(disk, async (req) => {
		if (req.method === 'POST') await held;
		return store.serve(req);
	});

	page.g.setContractPlan('L1', 'p1', '2');
	page.g.flushPlanPush();
	page.g.setContractPlan('L1', 'p2', '3'); // after the request went out
	release();
	await settle();

	assert.deepEqual(
		page.pending(),
		{ contractPlans: { L1: { p1: '2', p2: '3' } }, salaryPlans: {}, cutPlans: {} },
		'the second edit is not cleared by an answer that predates it'
	);
});

test('logging out drops unpushed edits but not the fact that this device synced', async () => {
	const store = newStore({ contractPlans: { L1: { p1: '2' } } });
	const disk = newDisk({ [CONTRACT_KEY]: JSON.stringify({ L1: { p1: '2' } }), [SYNCED_KEY]: '1' });

	const page = loadPage(disk, async (req) => {
		if (req.url.includes('/api/login')) return { token: 'a-fresh-token' };
		return store.serve(req);
	});
	page.g.setContractPlan('L1', 'p1', '');
	page.g.doLogout();

	assert.equal(page.pending(), null, 'the unpushed clear is dropped');
	assert.equal(disk.get(SYNCED_KEY), '1', 'but the device is still known to the store');

	await page.g.doLogin('site-password');
	await settle();

	assert.deepEqual(page.contracts(), { L1: { p1: '2' } }, 'the next login reads the store');
	assert.equal(page.requests.every((r) => r.body?.mode !== 'merge'), true, 'by GET, not merge');
});

test('the page renders and accepts edits with no store at all', async () => {
	const disk = newDisk({ [CONTRACT_KEY]: JSON.stringify({ L1: { p1: '2' } }), [SYNCED_KEY]: '1' });
	const page = loadPage(disk, async () => undefined); // every request 503s

	await page.g.syncPlans();
	page.g.setContractPlan('L1', 'p1', '1');
	await flush(page);
	page.g.setContractPlan('L1', 'p1', '');
	await flush(page);

	assert.deepEqual(page.contracts(), {}, 'localStorage is still the working copy');
});

for (const [name, fn] of tests) {
	try {
		await fn();
		console.log(`  ok   ${name}`);
	} catch (err) {
		failures++;
		console.log(`  FAIL ${name}`);
		console.log(`       ${err.message.split('\n')[0]}`);
	}
}

if (failures) {
	console.log(`\n${failures} plan-sync test${failures === 1 ? '' : 's'} failed.`);
	process.exit(1);
}
console.log('\nAll plan-sync tests passed.');
