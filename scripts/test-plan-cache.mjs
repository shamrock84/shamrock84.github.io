// Pins readPlanMapCached in myffl.html — the read-through cache behind the
// three per-player plan getters (getContractPlan/getSalaryPlan/getCutPlan),
// each called once per rostered player on every renderGrid().
//
// The whole reason this cache is keyed on the RAW STORED STRING rather than
// invalidated by hand is that there are several writers: each setter, a sync
// answer through writePlansLocal, a logout, another tab. A cache that has to
// be TOLD about a write is one missed call away from rendering a contract
// length the manager already changed — and it would look perfectly plausible
// on screen, which is how every other silent bug in this project reads.
//
// So the load-bearing cases here are the ones that never touch a setter:
// writing straight to storage and expecting the very next get to see it. If
// someone ever "optimizes" this into an explicit-invalidation cache, those
// are the assertions that fail.
//
// Run: node scripts/test-plan-cache.mjs

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = fs.readFileSync(path.join(root, 'myffl.html'), 'utf8');
// The page's own script block — the biggest <script> in the file, same way
// every other page-level test here gets at it.
const scriptSource = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1])
  .sort((a, b) => b.length - a.length)[0];

let failures = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name} — got ${a}, want ${e}`);
  }
}

// Enough of a DOM for the script to finish evaluating; none of it is exercised.
const stub = () => new Proxy(function () {}, {
  get: (_t, k) => (k === 'appendChild' || k === 'addEventListener' || k === 'remove' ? () => {} : stub()),
  apply: () => stub(),
  set: () => true,
});

const CONTRACT_KEY = 'myfflContractPlans';
const disk = new Map([['mflAuthToken', 'test-token']]);
const context = {
  console: { log() {}, warn() {}, error() {} },
  localStorage: {
    getItem: (k) => (disk.has(k) ? disk.get(k) : null),
    setItem: (k, v) => disk.set(k, String(v)),
    removeItem: (k) => disk.delete(k),
  },
  setTimeout, clearTimeout, setInterval, clearInterval,
  document: {
    addEventListener() {},
    getElementById: () => stub(),
    createElement: () => stub(),
    querySelector: () => null,
    querySelectorAll: () => [],
    visibilityState: 'visible',
    body: stub(),
  },
  window: { addEventListener() {} },
  fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
};
vm.createContext(context);
vm.runInContext(scriptSource, context);

console.log('the setter round trip');
eq('an empty store reads as empty', context.getContractPlan('L1', 'p1'), '');
context.setContractPlan('L1', 'p1', '3');
eq('set then get is immediate', context.getContractPlan('L1', 'p1'), '3');
context.setContractPlan('L1', 'p1', '5');
eq('overwrite then get', context.getContractPlan('L1', 'p1'), '5');
context.setContractPlan('L1', 'p1', '');
eq('cleared plan reads as empty, not the old value', context.getContractPlan('L1', 'p1'), '');

// A union merge cannot express a deletion, which is why a cleared plan
// propagating correctly matters so much here — see test-plan-sync.mjs.
console.log('writes that bypass the setters entirely');
disk.set(CONTRACT_KEY, JSON.stringify({ L2: { p9: '7' } }));
eq('a direct store write is seen with no invalidation call', context.getContractPlan('L2', 'p9'), '7');
disk.set(CONTRACT_KEY, JSON.stringify({ L2: { p9: '9' } }));
eq('a second direct write is seen too', context.getContractPlan('L2', 'p9'), '9');
disk.delete(CONTRACT_KEY);
eq('a direct delete is seen', context.getContractPlan('L2', 'p9'), '');

console.log('degradation');
disk.set(CONTRACT_KEY, '{not json');
eq('corrupt storage reads as empty rather than throwing', context.getContractPlan('L2', 'p9'), '');
disk.delete(CONTRACT_KEY);

console.log('the other two getters share the same machinery');
context.setSalaryPlan('L1', 'p2', '12');
eq('salary set then get', context.getSalaryPlan('L1', 'p2'), '12');
context.setCutPlan('L1', 'p3', 'cut');
eq('cut set then get', context.getCutPlan('L1', 'p3'), 'cut');
eq('the three keys stay independent', context.getContractPlan('L1', 'p2'), '');

// The setters deliberately do NOT read through the cache — they take the map
// and mutate it, so handing them a shared object would alias it. If that ever
// changes, a sibling write is where it shows up first.
console.log('setters get their own copy, not the cached object');
context.setContractPlan('L3', 'a', '1');
context.setContractPlan('L3', 'b', '2');
eq('an earlier entry survives a sibling write', context.getContractPlan('L3', 'a'), '1');
eq('the sibling write lands', context.getContractPlan('L3', 'b'), '2');

console.log(failures === 0 ? '\nAll plan-cache checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
